import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSshImagePasteExtension } from '../extensions/ssh-image-paste.ts';

// A real, independently encoded 1x1 PNG. The Windows clipboard is the external boundary.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function setup(t, respond = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'image/png' });
  res.end(png);
}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ssh-test-'));
  const socket = join(dir, 'clipboard.sock');
  const requests = [];
  const server = createServer((req, res) => { requests.push(req.headers); respond(req, res); });
  const events = new Map();
  t.after(async () => {
    await events.get('session_shutdown')?.({}, ctx);
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const shortcuts = new Map();
  const notices = [];
  let draft = 'Explain this screenshot: ';
  const ctx = {
    mode: 'tui', hasUI: true,
    ui: {
      getEditorText: () => draft,
      pasteToEditor: (text) => { draft += text; },
      notify: (text, level) => notices.push({ text, level }),
    },
  };
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  const install = createSshImagePasteExtension({
    socketPath: socket, token: 'a'.repeat(64), imageDir: join(dir, 'images'),
  });
  install({ on: (name, handler) => events.set(name, handler), registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut) });
  await events.get('session_start')?.({}, ctx);
  return { events, shortcuts, notices, requests, ctx, dir, draft: () => draft };
}

describe('Mac SSH host transport', { skip: process.platform === 'win32' }, () => {
  test('Alt+V transfers a PNG, preserves the draft, and attaches it only when submitted', async (t) => {
    const app = await setup(t);
    await app.shortcuts.get('alt+v').handler(app.ctx);
    assert.equal(app.requests[0].authorization, `Bearer ${'a'.repeat(64)}`);
    assert.ok(app.draft().startsWith('Explain this screenshot: '));
    const path = app.draft().match(/@"([^"]+\.png)"/)[1];
    assert.deepEqual(await readFile(path), png);
    const result = await app.events.get('input')({ text: app.draft(), source: 'interactive' }, app.ctx);
    assert.equal(result.action, 'transform');
    assert.deepEqual(result.images, [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
    assert.equal(app.notices.some((notice) => notice.level === 'error'), false);
  });

  for (const [name, status, type, body, error] of [
    ['empty clipboard', 409, 'text/plain', 'No image on the Windows clipboard', /No image/],
    ['bad token', 403, 'text/plain', 'Forbidden', /403/],
    ['wrong content type', 200, 'text/html', '<html>error</html>', /PNG/],
    ['invalid image bytes', 200, 'image/png', 'not an image', /PNG/],
  ]) {
    test(`Alt+V reports ${name} without changing the draft`, async (t) => {
      const app = await setup(t, (_req, res) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); });
      await app.shortcuts.get('alt+v').handler(app.ctx);
      assert.equal(app.draft(), 'Explain this screenshot: ');
      assert.equal(app.notices.at(-1).level, 'error');
      assert.match(app.notices.at(-1).text, error);
    });
  }

  test('reload cancels an in-flight paste rather than inserting into a replacement session', async (t) => {
    let respond;
    let received;
    const ready = new Promise((resolve) => { received = resolve; });
    const app = await setup(t, (_req, res) => {
      respond = () => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); };
      received();
    });
    const paste = app.shortcuts.get('alt+v').handler(app.ctx);
    await ready;
    await app.events.get('session_shutdown')({ reason: 'reload' }, app.ctx);
    await app.events.get('session_start')({}, app.ctx);
    respond();
    await paste;
    assert.equal(app.draft(), 'Explain this screenshot: ');
  });

  test('multiple pastes attach in draft order; deleting a reference omits that image', async (t) => {
    const app = await setup(t);
    await app.shortcuts.get('alt+v').handler(app.ctx);
    await app.shortcuts.get('alt+v').handler(app.ctx);
    const all = await app.events.get('input')({ text: app.draft(), source: 'interactive' }, app.ctx);
    assert.equal(all.images.length, 2);
    const removed = app.draft().replace(/@"[^"\n]+\.png"/g, '');
    assert.equal(await app.events.get('input')({ text: removed, source: 'interactive' }, app.ctx), undefined);
  });

  test('reload retains a pasted draft reference and existing attached images', async (t) => {
    const app = await setup(t);
    await app.shortcuts.get('alt+v').handler(app.ctx);
    await app.events.get('session_shutdown')({ reason: 'reload' }, app.ctx);
    await app.events.get('session_start')({}, app.ctx);
    const existing = { type: 'image', mimeType: 'image/png', data: png.toString('base64') };
    const result = await app.events.get('input')({ text: app.draft(), images: [existing], source: 'interactive' }, app.ctx);
    assert.deepEqual(result.images, [existing, existing]);
  });

  test('ordinary Pi does not register an Alt+V override', () => {
    const pi = new Proxy({}, { get() { throw new Error('Unexpected registration'); } });
    createSshImagePasteExtension(undefined)(pi);
  });

  test('an oversized response is rejected without writing a draft reference', async (t) => {
    const app = await setup(t, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.alloc(20 * 1024 * 1024 + 1));
    });
    await app.shortcuts.get('alt+v').handler(app.ctx);
    assert.equal(app.draft(), 'Explain this screenshot: ');
    assert.match(app.notices.at(-1).text, /20 MiB/);
  });

  test('references cannot escape the image directory', async (t) => {
    const app = await setup(t);
    const result = await app.events.get('input')({ text: `@"${app.dir}/images/../other.png"`, source: 'interactive' }, app.ctx);
    assert.equal(result, undefined);
  });

  test('submitting while a paste is in flight cancels it instead of attaching to the next draft', async (t) => {
    let reply;
    let signalReady;
    const ready = new Promise((resolve) => { signalReady = resolve; });
    const app = await setup(t, (_req, res) => {
      reply = () => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); };
      signalReady();
    });
    const paste = app.shortcuts.get('alt+v').handler(app.ctx);
    await ready;
    await app.events.get('input')({ text: 'Send now', source: 'interactive' }, app.ctx);
    reply();
    await paste;
    assert.equal(app.draft(), 'Explain this screenshot: ');
    assert.match(app.notices.at(-1).text, /cancelled/i);
  });

  test('a missing saved image blocks submission with a visible error', async (t) => {
    const app = await setup(t);
    await app.shortcuts.get('alt+v').handler(app.ctx);
    const path = app.draft().match(/@"([^"]+\.png)"/)[1];
    await rm(path);
    const result = await app.events.get('input')({ text: app.draft(), source: 'interactive' }, app.ctx);
    assert.equal(result.action, 'handled');
    assert.match(app.notices.at(-1).text, /image attachment failed/i);
  });

  test('a forged PNG header without decodable image data is rejected', async (t) => {
    const fake = Buffer.alloc(45);
    png.copy(fake, 0, 0, 24);
    fake.write('IEND', 37);
    const app = await setup(t, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(fake);
    });
    await app.shortcuts.get('alt+v').handler(app.ctx);
    assert.equal(app.draft(), 'Explain this screenshot: ');
    assert.equal(app.notices.at(-1).level, 'error');
  });

  test('a helper that never responds times out without modifying the draft', async (t) => {
    const app = await setup(t, () => {});
    const started = Date.now();
    await app.shortcuts.get('alt+v').handler(app.ctx);
    assert.ok(Date.now() - started < 15_000);
    assert.equal(app.draft(), 'Explain this screenshot: ');
    assert.equal(app.notices.at(-1).level, 'error');
  });
});
