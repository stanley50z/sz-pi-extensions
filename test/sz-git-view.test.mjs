import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const moduleUrl = new URL('../extensions/sz-git-view/index.ts', import.meta.url).href;
const collectorModuleUrl = new URL('../extensions/sz-git-view/collector.ts', import.meta.url).href;

async function freshGitViewModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

async function freshCollectorModule() {
  return import(`${collectorModuleUrl}?t=${Date.now()}-${Math.random()}`);
}

function git(args, cwd) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

async function createRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'sz-git-view-'));
  git(['init'], dir);
  await writeFile(join(dir, 'file.txt'), 'hello\n', 'utf8');
  git(['add', 'file.txt'], dir);
  git(['commit', '-m', 'initial'], dir);
  return dir;
}

function createFakePi() {
  const handlers = new Map();
  const eventMessages = [];
  return {
    handlers,
    eventMessages,
    on(event, handler) {
      handlers.set(event, handler);
    },
    events: {
      emit(channel, data) {
        eventMessages.push({ channel, data });
      },
      on() {
        return () => {};
      },
    },
  };
}

function createFakeContext() {
  return { ui: { notify() {} } };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeServerFrame(buffer) {
  if (buffer.length < 2) return null;
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + payloadLen) return null;
  return buffer.subarray(offset, offset + payloadLen).toString('utf8');
}

function receiveFirstWsMessage(url) {
  return new Promise((resolve, reject) => {
    const { port } = new URL(url);
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
    const key = randomBytes(16).toString('base64');
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for first WebSocket message'));
    }, 1000);

    socket.on('connect', () => {
      socket.write([
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headers = buffer.subarray(0, headerEnd).toString('utf8');
        assert.match(headers, /101 Switching Protocols/);
        const expectedAccept = createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        assert.ok(
          headers.includes(`Sec-WebSocket-Accept: ${expectedAccept}`),
          `missing expected Sec-WebSocket-Accept header: ${expectedAccept}`,
        );
        buffer = buffer.subarray(headerEnd + 4);
        upgraded = true;
      }
      const frame = decodeServerFrame(buffer);
      if (frame !== null) {
        clearTimeout(timer);
        socket.destroy();
        resolve(frame);
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('Git View collector preserves the first path character for modified worktree files', async () => {
  const originalCwd = process.cwd();
  const repo = await mkdtemp(join(tmpdir(), 'sz-git-view-status-'));
  const filePath = join(repo, 'extensions', 'sz-git-view', 'collector.ts');

  try {
    git(['init'], repo);
    await mkdir(join(repo, 'extensions', 'sz-git-view'), { recursive: true });
    await writeFile(filePath, 'initial\n', 'utf8');
    git(['add', 'extensions/sz-git-view/collector.ts'], repo);
    git(['commit', '-m', 'initial'], repo);
    await writeFile(filePath, 'changed\n', 'utf8');
    process.chdir(repo);

    const { collectAll } = await freshCollectorModule();
    const data = collectAll();

    assert.equal(data.error, undefined);
    assert.equal(data.status[0]?.path, 'extensions/sz-git-view/collector.ts');
  } finally {
    process.chdir(originalCwd);
  }
});

test('Git View collector excludes the primary checkout from worktrees', async () => {
  const originalCwd = process.cwd();
  const parent = await mkdtemp(join(tmpdir(), 'sz-git-view-worktrees-'));
  const repo = join(parent, 'main');
  const side = join(parent, 'side');

  try {
    await mkdir(repo, { recursive: true });
    git(['init'], repo);
    await writeFile(join(repo, 'file.txt'), 'hello\n', 'utf8');
    git(['add', 'file.txt'], repo);
    git(['commit', '-m', 'initial'], repo);
    git(['worktree', 'add', '-b', 'side', side], repo);
    process.chdir(repo);

    const { collectAll } = await freshCollectorModule();
    const data = collectAll();

    assert.equal(data.error, undefined);
    assert.deepEqual(data.worktrees.map((entry) => entry.path), [await realpath(side)]);
    assert.equal(data.worktrees[0]?.branch, 'refs/heads/side');
  } finally {
    process.chdir(originalCwd);
  }
});

test('Git View sends full repo data to a browser that connects after startup broadcast', async () => {
  const originalCwd = process.cwd();
  const repo = await createRepo();
  process.chdir(repo);

  const { default: installGitViewExtension } = await freshGitViewModule();
  const pi = createFakePi();
  const ctx = createFakeContext();

  try {
    await installGitViewExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
    const published = pi.eventMessages.find((message) => message.channel === 'sz-git-view:url');
    assert.ok(published, 'Git View URL was not published');

    await wait(1200);
    const frame = await receiveFirstWsMessage(published.data.url);
    const message = JSON.parse(frame);

    assert.equal(message.type, 'full');
    assert.equal(message.error, null);
    assert.equal(message.repoName, repo.split('/').at(-1));
    assert.ok(message.commits.length >= 1);
  } finally {
    await pi.handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
    process.chdir(originalCwd);
  }
});
