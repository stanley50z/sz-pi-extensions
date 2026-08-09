import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../extensions/openai-fast-mode.ts', import.meta.url).href;

function createAgentDir() {
  return mkdtempSync(join(tmpdir(), 'pi-fast-mode-'));
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for fast mode state to synchronize');
}

async function freshFastModeModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

function createFakePi(flags = {}) {
  const commands = new Map();
  const handlers = new Map();
  return {
    commands,
    handlers,
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerFlag(name, options) {
      flags[name] ??= options.default;
    },
    getFlag(name) {
      return flags[name];
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
}

function createFakeContext(model = { provider: 'openai', id: 'gpt-5.5', api: 'openai-responses' }) {
  const notifications = [];
  const statuses = [];
  return {
    model,
    notifications,
    statuses,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setStatus(key, text) {
        statuses.push({ key, text });
      },
    },
  };
}

async function install(flags, agentDir = createAgentDir()) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { default: installFastMode } = await freshFastModeModule();
    const pi = createFakePi(flags);
    installFastMode(pi);
    return pi;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test('/fast is registered and toggles fast mode with status indicator', async () => {
  const pi = await install();
  const ctx = createFakeContext();

  assert.ok(pi.commands.has('fast'));
  assert.equal(pi.commands.get('fast').description, 'Toggle OpenAI fast mode');

  await pi.commands.get('fast').handler('', ctx);
  assert.deepEqual(ctx.notifications.at(-1), { message: 'Fast mode: on', type: 'info' });
  assert.deepEqual(ctx.statuses.at(-1), { key: 'openai-fast-mode', text: '⚡fast' });

  await pi.commands.get('fast').handler('', ctx);
  assert.deepEqual(ctx.notifications.at(-1), { message: 'Fast mode: off', type: 'info' });
  assert.deepEqual(ctx.statuses.at(-1), { key: 'openai-fast-mode', text: undefined });
});

test('/fast on, off, and status control fast mode explicitly', async () => {
  const pi = await install();
  const ctx = createFakeContext();

  await pi.commands.get('fast').handler('on', ctx);
  assert.deepEqual(ctx.notifications.at(-1), { message: 'Fast mode: on', type: 'info' });

  await pi.commands.get('fast').handler('status', ctx);
  assert.deepEqual(ctx.notifications.at(-1), { message: 'Fast mode: on (supported)', type: 'info' });

  await pi.commands.get('fast').handler('off', ctx);
  assert.deepEqual(ctx.notifications.at(-1), { message: 'Fast mode: off', type: 'info' });
});

test('--fast starts fast mode enabled on session start', async () => {
  const pi = await install({ fast: true });
  const ctx = createFakeContext();

  await pi.commands.get('fast').handler('status', ctx);

  assert.deepEqual(ctx.notifications.at(-1), { message: 'Fast mode: on (supported)', type: 'info' });
});

test('fast mode is remembered by new Pi sessions', async () => {
  const agentDir = createAgentDir();
  const firstPi = await install({}, agentDir);
  const firstCtx = createFakeContext();

  await firstPi.handlers.get('session_start')({}, firstCtx);
  await firstPi.commands.get('fast').handler('on', firstCtx);
  await firstPi.handlers.get('session_shutdown')?.({}, firstCtx);

  const restartedPi = await install({}, agentDir);
  const restartedCtx = createFakeContext();
  await restartedPi.handlers.get('session_start')({}, restartedCtx);
  await restartedPi.commands.get('fast').handler('status', restartedCtx);

  assert.deepEqual(restartedCtx.notifications.at(-1), { message: 'Fast mode: on (supported)', type: 'info' });
  await restartedPi.handlers.get('session_shutdown')?.({}, restartedCtx);
});

test('toggling fast mode synchronizes all running Pi sessions and Codex children', async (t) => {
  const previousFastMode = process.env.PI_OPENAI_FAST_MODE;
  t.after(() => {
    if (previousFastMode === undefined) delete process.env.PI_OPENAI_FAST_MODE;
    else process.env.PI_OPENAI_FAST_MODE = previousFastMode;
  });

  const agentDir = createAgentDir();
  const firstPi = await install({}, agentDir);
  const secondPi = await install({}, agentDir);
  const firstCtx = createFakeContext();
  const secondCtx = createFakeContext();
  const request = { payload: { model: 'gpt-5.6-sol', input: [] } };

  await firstPi.handlers.get('session_start')({}, firstCtx);
  await secondPi.handlers.get('session_start')({}, secondCtx);

  await firstPi.commands.get('fast').handler('on', firstCtx);
  assert.equal(process.env.PI_OPENAI_FAST_MODE, '1');
  await waitUntil(async () => {
    const result = await secondPi.handlers.get('before_provider_request')(request, secondCtx);
    return result?.service_tier === 'priority';
  });
  assert.deepEqual(secondCtx.statuses.at(-1), { key: 'openai-fast-mode', text: '⚡fast' });

  await secondPi.commands.get('fast').handler('off', secondCtx);
  assert.equal(process.env.PI_OPENAI_FAST_MODE, '0');
  await waitUntil(async () => {
    const result = await firstPi.handlers.get('before_provider_request')(request, firstCtx);
    return result === undefined;
  });
  assert.deepEqual(firstCtx.statuses.at(-1), { key: 'openai-fast-mode', text: undefined });

  await firstPi.handlers.get('session_shutdown')?.({}, firstCtx);
  await secondPi.handlers.get('session_shutdown')?.({}, secondCtx);
});

test('invalid /fast arguments notify an error', async () => {
  const pi = await install();
  const ctx = createFakeContext();

  await pi.commands.get('fast').handler('maybe', ctx);

  assert.deepEqual(ctx.notifications.at(-1), { message: 'Usage: /fast [on|off|status]', type: 'error' });
});

test('fast mode adds priority service tier to the final provider payload', async () => {
  const pi = await install();
  const ctx = createFakeContext();
  const payload = { model: 'gpt-5.6-sol', input: [] };

  await pi.commands.get('fast').handler('on', ctx);
  const result = await pi.handlers.get('before_provider_request')({ payload }, ctx);

  assert.deepEqual(result, { ...payload, service_tier: 'priority' });
});
