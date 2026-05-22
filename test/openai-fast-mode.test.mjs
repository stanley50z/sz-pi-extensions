import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../extensions/openai-fast-mode.ts', import.meta.url).href;

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

async function install(flags) {
  const { default: installFastMode } = await freshFastModeModule();
  const pi = createFakePi(flags);
  installFastMode(pi);
  return pi;
}

test('/fast is registered and toggles fast mode with status indicator', async () => {
  const pi = await install();
  const ctx = createFakeContext();

  assert.ok(pi.commands.has('fast'));
  assert.equal(pi.commands.get('fast').description, 'Toggle OpenAI fast mode');

  await pi.commands.get('fast').handler('', ctx);
  assert.deepEqual(ctx.notifications.at(-1), { message: 'Fast mode: on', type: 'info' });
  assert.deepEqual(ctx.statuses.at(-1), { key: 'openai-fast-mode', text: '⚡ fast' });

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

test('invalid /fast arguments notify an error', async () => {
  const pi = await install();
  const ctx = createFakeContext();

  await pi.commands.get('fast').handler('maybe', ctx);

  assert.deepEqual(ctx.notifications.at(-1), { message: 'Usage: /fast [on|off|status]', type: 'error' });
});

test('provider wrapper injects priority service tier only when enabled', async () => {
  const { withPriorityServiceTier } = await freshFastModeModule();
  const calls = [];
  let enabled = false;
  const delegate = (model, context, options) => {
    calls.push({ model, context, options });
    return { [Symbol.asyncIterator]: async function* () {} };
  };
  const wrapped = withPriorityServiceTier(delegate, () => enabled);

  wrapped({ api: 'openai-responses' }, {}, { existing: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.serviceTier, undefined);

  enabled = true;
  wrapped({ api: 'openai-responses' }, {}, { existing: true });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.existing, true);
  assert.equal(calls[1].options.serviceTier, 'priority');
});
