import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../extensions/openai-fast-mode.ts', import.meta.url).href;

function createAgentDir() {
  return mkdtempSync(join(tmpdir(), 'pi-fast-mode-'));
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

test('fast mode stays session-local and ignores the old shared default', async (t) => {
  const previousFastMode = process.env.PI_OPENAI_FAST_MODE;
  t.after(() => {
    if (previousFastMode === undefined) delete process.env.PI_OPENAI_FAST_MODE;
    else process.env.PI_OPENAI_FAST_MODE = previousFastMode;
  });
  delete process.env.PI_OPENAI_FAST_MODE;
  const agentDir = createAgentDir();
  writeFileSync(join(agentDir, 'openai-fast-mode.json'), '{"enabled":true}\n');
  const firstPi = await install({}, agentDir);
  const secondPi = await install({}, agentDir);
  const firstCtx = createFakeContext();
  const secondCtx = createFakeContext();
  const request = { payload: { model: 'gpt-6-astra', input: [] } };
  t.after(async () => {
    await firstPi.handlers.get('session_shutdown')?.({}, firstCtx);
    await secondPi.handlers.get('session_shutdown')?.({}, secondCtx);
  });
  await firstPi.handlers.get('session_start')({}, firstCtx);
  await secondPi.handlers.get('session_start')({}, secondCtx);
  assert.equal(await firstPi.handlers.get('before_provider_request')(request, firstCtx), undefined);
  await firstPi.commands.get('fast').handler('on', firstCtx);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await secondPi.handlers.get('before_provider_request')(request, secondCtx), undefined);
  assert.equal(process.env.PI_OPENAI_FAST_MODE, undefined);
  await secondPi.commands.get('fast').handler('off', secondCtx);
  assert.equal((await firstPi.handlers.get('before_provider_request')(request, firstCtx)).service_tier, 'priority');
  const restartedPi = await install({}, agentDir);
  const restartedCtx = createFakeContext();
  await restartedPi.handlers.get('session_start')({}, restartedCtx);
  t.after(() => restartedPi.handlers.get('session_shutdown')?.({}, restartedCtx));
  assert.equal(await restartedPi.handlers.get('before_provider_request')(request, restartedCtx), undefined);
  await firstPi.handlers.get('session_start')({}, firstCtx);
  assert.equal(await firstPi.handlers.get('before_provider_request')(request, firstCtx), undefined);
});

test('invalid /fast arguments notify an error', async () => {
  const pi = await install();
  const ctx = createFakeContext();

  await pi.commands.get('fast').handler('maybe', ctx);

  assert.deepEqual(ctx.notifications.at(-1), { message: 'Usage: /fast [on|off|status]', type: 'error' });
});

test('/ultrafast toggles the Codex request tier without affecting another session', async () => {
  const pi = await install();
  const otherPi = await install();
  const ctx = createFakeContext({ provider: 'openai-codex', id: 'gpt-6-astra', api: 'openai-codex-responses' });
  const payload = { model: 'gpt-6-astra', input: [], service_tier: 'priority' };
  const command = pi.commands.get('ultrafast');
  assert.ok(command, '/ultrafast is registered');
  await pi.handlers.get('session_start')({}, ctx);
  await command.handler('', ctx);
  assert.deepEqual(await pi.handlers.get('before_provider_request')({ payload }, ctx), { ...payload, service_tier: 'ultrafast' });
  assert.equal(await otherPi.handlers.get('before_provider_request')({ payload }, ctx), undefined);
  assert.deepEqual(ctx.notifications.at(-1), { message: 'Ultrafast mode: on', type: 'info' });
  assert.deepEqual(ctx.statuses.at(-1), { key: 'openai-fast-mode', text: '⚡ultrafast' });
  await pi.commands.get('fast').handler('on', ctx);
  assert.equal((await pi.handlers.get('before_provider_request')({ payload }, ctx)).service_tier, 'priority');
  await command.handler('', ctx);
  await pi.commands.get('fast').handler('status', ctx);
  assert.deepEqual(ctx.notifications.at(-1), { message: 'Fast mode: off (supported)', type: 'info' });
  await command.handler('', ctx);
  assert.equal(await pi.handlers.get('before_provider_request')({ payload }, ctx), undefined);
});

test('/ultrafast has no argument completions and rejects arguments without changing mode', async () => {
  const pi = await install();
  const ctx = createFakeContext();
  const command = pi.commands.get('ultrafast');
  const request = { payload: { model: 'gpt-6-astra', input: [] } };
  assert.equal(command.getArgumentCompletions, undefined);
  for (const argument of ['on', 'off', 'status', 'maybe']) {
    await command.handler(argument, ctx);
    assert.deepEqual(ctx.notifications.at(-1), { message: 'Usage: /ultrafast', type: 'error' });
    assert.equal(await pi.handlers.get('before_provider_request')(request, ctx), undefined);
  }
  await command.handler('', ctx);
  await command.handler('off', ctx);
  assert.deepEqual(ctx.notifications.at(-1), { message: 'Usage: /ultrafast', type: 'error' });
  assert.equal((await pi.handlers.get('before_provider_request')(request, ctx)).service_tier, 'ultrafast');
});

test('fast mode adds priority service tier to the final provider payload', async () => {
  const pi = await install();
  const ctx = createFakeContext();
  const payload = { model: 'gpt-5.6-sol', input: [] };

  await pi.commands.get('fast').handler('on', ctx);
  const result = await pi.handlers.get('before_provider_request')({ payload }, ctx);

  assert.deepEqual(result, { ...payload, service_tier: 'priority' });
});
