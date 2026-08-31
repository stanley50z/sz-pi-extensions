import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../extensions/pi-autoupdate.ts', import.meta.url).href;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for Pi autoupdate');
}

async function install(agentDir, exec) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { default: installPiAutoupdate } = await import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
    const handlers = new Map();
    const pi = {
      exec,
      on(event, handler) {
        handlers.set(event, handler);
      },
    };
    installPiAutoupdate(pi);
    return { handlers };
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

function createContext() {
  const notifications = [];
  return {
    notifications,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };
}

test('updates Pi in the background on startup and notifies when restart is needed', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-autoupdate-'));
  const update = deferred();
  const calls = [];
  const { handlers } = await install(agentDir, (...args) => {
    calls.push(args);
    return update.promise;
  });
  const ctx = createContext();

  await handlers.get('session_start')({}, ctx);

  assert.deepEqual(calls, [[
    process.execPath,
    [process.argv[1], 'update', '--self'],
    { timeout: 5 * 60 * 1000 },
  ]]);
  assert.deepEqual(ctx.notifications, []);

  update.resolve({
    code: 0,
    stdout: 'Updated pi from 0.84.1 to 0.85.0\n',
    stderr: '',
    killed: false,
  });

  await waitUntil(() => ctx.notifications.length === 1);
  assert.deepEqual(ctx.notifications, [{
    message: 'Pi updated to v0.85.0. Restart Pi to use the new version.',
    type: 'info',
  }]);
});

test('checks for an update at most once per day across Pi sessions', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-autoupdate-'));
  const calls = [];
  const exec = async (...args) => {
    calls.push(args);
    return {
      code: 0,
      stdout: 'pi is already up to date (v0.84.1)\n',
      stderr: '',
      killed: false,
    };
  };

  const first = await install(agentDir, exec);
  await first.handlers.get('session_start')({}, createContext());
  await waitUntil(() => calls.length === 1);

  const second = await install(agentDir, exec);
  await second.handlers.get('session_start')({}, createContext());
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(calls.length, 1);
});

test('reports a failed background update without interrupting startup', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-autoupdate-'));
  const { handlers } = await install(agentDir, async () => ({
    code: 1,
    stdout: '',
    stderr: 'Error: network unavailable\n',
    killed: false,
  }));
  const ctx = createContext();

  await handlers.get('session_start')({}, ctx);
  await waitUntil(() => ctx.notifications.length === 1);

  assert.deepEqual(ctx.notifications, [{
    message: 'Pi autoupdate failed: Error: network unavailable',
    type: 'error',
  }]);
});

test('retries on the next session after an update failure', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-autoupdate-'));
  const calls = [];
  const exec = async (...args) => {
    calls.push(args);
    return calls.length === 1
      ? { code: 1, stdout: '', stderr: 'Error: network unavailable\n', killed: false }
      : { code: 0, stdout: 'Updated pi from 0.84.3 to 0.84.4\n', stderr: '', killed: false };
  };

  const first = await install(agentDir, exec);
  const firstContext = createContext();
  await first.handlers.get('session_start')({}, firstContext);
  await waitUntil(() => firstContext.notifications.length === 1);

  const second = await install(agentDir, exec);
  const secondContext = createContext();
  await second.handlers.get('session_start')({}, secondContext);
  await waitUntil(() => secondContext.notifications.length === 1);

  assert.equal(calls.length, 2);
  assert.deepEqual(secondContext.notifications, [{
    message: 'Pi updated to v0.84.4. Restart Pi to use the new version.',
    type: 'info',
  }]);
});

test('does not autoupdate when Pi is offline', async () => {
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = '1';
  try {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-autoupdate-'));
    const calls = [];
    const { handlers } = await install(agentDir, async (...args) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '', killed: false };
    });

    await handlers.get('session_start')({}, createContext());
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepEqual(calls, []);
  } finally {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  }
});
