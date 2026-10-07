import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import installSshImagePaste, { createSshImagePasteExtension } from '../extensions/ssh-image-paste.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

// Exercise Pi's shortcut/input boundary with real private records and Unix-socket HTTP helpers.
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-clipboard-discovery-'));
  const connectionsDir = join(dir, 'ssh-clipboard', 'connections');
  await mkdir(connectionsDir, { recursive: true, mode: 0o700 });
  const events = new Map();
  const shortcuts = new Map();
  const notices = [];
  let draft = 'Explain: ';
  const ctx = { hasUI: true, mode: 'tui', ui: {
    getEditorText: () => draft,
    setEditorText: (text) => { draft = text; },
    pasteToEditor: (text) => { draft += text; },
    notify: (text, level) => notices.push({ text, level }),
  } };
  const helpers = [];
  async function connect(id, health) {
    const token = id.repeat(64);
    const socketPath = join(dir, `${id}.sock`);
    const requests = [];
    const server = createServer((req, res) => {
      requests.push(req.url);
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end(); return; }
      if (req.url === '/health') {
        if (health) health(res);
        else { res.writeHead(204); res.end(); }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    const path = join(connectionsDir, `${id.repeat(32)}.json`);
    await writeFile(path, JSON.stringify({ socketPath, token }), { mode: 0o600 });
    const helper = { server, path, socketPath, token, requests, async close() {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    } };
    helpers.push(helper);
    return helper;
  }
  const pi = {
    on: (name, handler) => events.set(name, handler), registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
  };
  createSshImagePasteExtension({ connectionsDir, imageDir: join(dir, 'images') })(pi);
  await events.get('session_start')({}, ctx);
  t.after(async () => {
    await events.get('session_shutdown')({}, ctx);
    for (const helper of helpers) await helper.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, connectionsDir, pi, events, notices, ctx, connect, draft: () => draft,
    paste: () => shortcuts.get('alt+v').handler(ctx) };
}

describe('SSH connection discovery', { skip: process.platform === 'win32' }, () => {
  test('a FIFO masquerading as a connection record cannot stall image paste', async (t) => {
    const app = await setup(t);
    const path = join(app.connectionsDir, 'd'.repeat(32) + '.json');
    await promisify(execFile)('mkfifo', ['-m', '600', path], { timeout: 5_000 });
    const paste = app.paste();
    let timer;
    const verdict = await Promise.race([
      paste.then(() => 'completed'),
      new Promise((resolve) => { timer = setTimeout(() => resolve('stalled'), 500); }),
    ]);
    clearTimeout(timer);
    if (verdict === 'stalled') {
      // Release a buggy blocking open so the RED run can exit cleanly.
      const writer = await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
      await writer.close();
      await paste;
    }
    assert.equal(verdict, 'completed');
    assert.equal(app.draft(), 'Explain: ');
    assert.match(app.notices.at(-1).text, /record is not private/);
  });

  test('submitting during discovery cancels it before any clipboard is read', async (t) => {
    const app = await setup(t);
    let received;
    const ready = new Promise((resolve) => { received = resolve; });
    const helper = await app.connect('a', () => received());
    const paste = app.paste();
    await ready;
    await app.events.get('input')({ source: 'interactive', text: 'Send now' }, app.ctx);
    await paste;
    assert.equal(app.draft(), 'Explain: ');
    assert.deepEqual(helper.requests, ['/health']);
    assert.match(app.notices.at(-1).text, /cancelled/);
  });

  test('a world-readable connection record is rejected before contacting its helper', async (t) => {
    const app = await setup(t);
    const helper = await app.connect('a');
    await chmod(helper.path, 0o644);
    await app.paste();
    assert.equal(app.draft(), 'Explain: ');
    assert.deepEqual(helper.requests, []);
    assert.match(app.notices.at(-1).text, /record is not private/);
  });

  test('invalid record JSON reports an error without exposing its token', async (t) => {
    const app = await setup(t);
    const secret = 'c'.repeat(64);
    await writeFile(join(app.connectionsDir, 'c'.repeat(32) + '.json'), `{"token":"${secret}",`, { mode: 0o600 });
    await app.paste();
    assert.equal(app.draft(), 'Explain: ');
    assert.match(app.notices.at(-1).text, /Invalid SSH clipboard record/);
    const log = await readFile(join(app.dir, 'logs', 'ssh-clipboard.log'), 'utf8');
    assert.equal(log.includes(secret), false);
    assert.equal(app.notices.at(-1).text.includes(secret), false);
  });

  test('an unresponsive helper is bounded without changing the draft', async (t) => {
    const app = await setup(t);
    const helper = await app.connect('a', () => {});
    const start = Date.now();
    await app.paste();
    assert.ok(Date.now() - start < 2_500);
    assert.equal(app.draft(), 'Explain: ');
    assert.deepEqual(helper.requests, ['/health']);
    assert.match(app.notices.at(-1).text, /No active SSH clipboard connection/);
  });

  test('a mismatched token cannot read a clipboard during discovery', async (t) => {
    const app = await setup(t);
    const helper = await app.connect('a');
    await writeFile(helper.path, JSON.stringify({ socketPath: helper.socketPath, token: 'b'.repeat(64) }));
    await app.paste();
    assert.equal(app.draft(), 'Explain: ');
    assert.deepEqual(helper.requests, ['/health']);
    assert.match(app.notices.at(-1).text, /No active SSH clipboard connection/);
  });

  test('the default extension ignores expired credentials inherited from Herdr', async (t) => {
    const app = await setup(t);
    const helper = await app.connect('a');
    const keys = ['PI_CODING_AGENT_DIR', 'PI_SSH_CLIPBOARD_SOCKET', 'PI_SSH_CLIPBOARD_TOKEN'];
    const saved = keys.map((key) => process.env[key]);
    try {
      process.env.PI_CODING_AGENT_DIR = app.dir;
      process.env.PI_SSH_CLIPBOARD_SOCKET = join(app.dir, 'expired.sock');
      process.env.PI_SSH_CLIPBOARD_TOKEN = 'f'.repeat(64);
      installSshImagePaste(app.pi);
    } finally {
      keys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      });
    }
    await app.events.get('session_start')({}, app.ctx);
    await app.paste();
    assert.match(app.draft(), /@"[^"\n]+\.png"/);
    assert.deepEqual(helper.requests, ['/health', '/image']);
    assert.equal(app.notices.length, 0);
  });

  test('a disconnected bridge preserves the draft and writes a persistent error report', async (t) => {
    const app = await setup(t);
    await app.paste();
    assert.equal(app.draft(), 'Explain: ');
    assert.match(app.notices.at(-1).text, /No active SSH clipboard connection/);
    const log = await readFile(join(app.dir, 'logs', 'ssh-clipboard.log'), 'utf8');
    assert.match(log, /Error: No active SSH clipboard connection/);
    assert.match(log, /\n\s+at /);
  });

  test('ambiguous live connections never capture either clipboard or change the draft', async (t) => {
    const app = await setup(t);
    const first = await app.connect('a');
    const second = await app.connect('b');
    await app.paste();
    assert.equal(app.draft(), 'Explain: ');
    assert.deepEqual(first.requests, ['/health']);
    assert.deepEqual(second.requests, ['/health']);
    assert.match(app.notices.at(-1).text, /Multiple SSH clipboard connections/);
  });

  test('Alt+V follows a replacement SSH connection without restarting Pi', async (t) => {
    const app = await setup(t);
    const first = await app.connect('a');
    await app.paste();
    assert.match(app.draft(), /@"[^"\n]+\.png"/);
    await first.close(); // An abrupt disconnect can leave its record behind.
    const second = await app.connect('b');
    await app.paste();
    assert.equal([...app.draft().matchAll(/@"([^"\n]+\.png)"/g)].length, 2);
    assert.deepEqual(first.requests, ['/health', '/image']);
    assert.deepEqual(second.requests, ['/health', '/image']);
    const attached = await app.events.get('input')({ source: 'interactive', text: app.draft() }, app.ctx);
    assert.equal(attached.images.length, 2);
    assert.equal(attached.images[1].data, png.toString('base64'));
    assert.equal(app.notices.length, 0);
  });
});
