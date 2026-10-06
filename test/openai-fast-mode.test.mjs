import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('../extensions/openai-fast-mode.ts', import.meta.url).href;

const temporaryDirs = [];
after(() => temporaryDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function createAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fast-mode-'));
  temporaryDirs.push(dir);
  return dir;
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

function createFakeContext(model = { provider: 'openai', id: 'gpt-5.5', api: 'openai-responses' }, cwd = createAgentDir()) {
  const notifications = [];
  const statuses = [];
  return {
    cwd,
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

test('new sessions in the same directory remember fast without changing open sessions', async () => {
  const cwd = createAgentDir();
  const firstPi = await install();
  const secondPi = await install();
  const firstCtx = createFakeContext(undefined, cwd);
  const secondCtx = createFakeContext(undefined, cwd);
  const request = { payload: { input: [] } };
  await firstPi.handlers.get('session_start')({}, firstCtx);
  await secondPi.handlers.get('session_start')({}, secondCtx);
  await firstPi.commands.get('fast').handler('on', firstCtx);
  assert.equal(await secondPi.handlers.get('before_provider_request')(request, secondCtx), undefined);

  const restartedPi = await install();
  const restartedCtx = createFakeContext(undefined, cwd);
  await restartedPi.handlers.get('session_start')({}, restartedCtx);
  assert.deepEqual(await restartedPi.handlers.get('before_provider_request')(request, restartedCtx), {
    input: [], service_tier: 'priority',
  });
  assert.deepEqual(restartedCtx.statuses.at(-1), { key: 'openai-fast-mode', text: '⚡fast' });
});

test('ultrafast, fast, and normal are peer levels remembered across new sessions', async () => {
  const cwd = createAgentDir();
  const pi = await install();
  const ctx = createFakeContext(undefined, cwd);
  const request = { payload: { input: [] } };
  await pi.handlers.get('session_start')({}, ctx);
  for (const [name, args, tier] of [
    ['ultrafast', '', 'ultrafast'],
    ['fast', 'on', 'priority'],
    ['ultrafast', '', 'ultrafast'],
    ['ultrafast', '', undefined],
    ['fast', '', 'priority'],
    ['fast', 'off', undefined],
  ]) {
    await pi.commands.get(name).handler(args, ctx);
    const restartedPi = await install();
    const restartedCtx = createFakeContext(undefined, cwd);
    await restartedPi.handlers.get('session_start')({}, restartedCtx);
    assert.equal((await restartedPi.handlers.get('before_provider_request')(request, restartedCtx))?.service_tier, tier);
    // Also covers /new or reload on the existing extension runtime.
    await pi.handlers.get('session_start')({}, ctx);
    assert.equal((await pi.handlers.get('before_provider_request')(request, ctx))?.service_tier, tier);
  }
});

test('directories are isolated and the legacy global file and environment are ignored', async (t) => {
  const previous = process.env.PI_OPENAI_FAST_MODE;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_OPENAI_FAST_MODE;
    else process.env.PI_OPENAI_FAST_MODE = previous;
  });
  process.env.PI_OPENAI_FAST_MODE = '1';
  const agentDir = createAgentDir();
  writeFileSync(join(agentDir, 'openai-fast-mode.json'), '{"enabled":true}\n');
  const ctx = createFakeContext();
  const pi = await install({}, agentDir);
  await pi.handlers.get('session_start')({}, ctx);
  const request = { payload: {} };
  assert.equal(await pi.handlers.get('before_provider_request')(request, ctx), undefined);
  await pi.commands.get('fast').handler('on', ctx);
  const childDir = join(ctx.cwd, 'child');
  mkdirSync(childDir);
  for (const cwd of [createAgentDir(), childDir]) {
    const otherPi = await install({}, agentDir);
    const otherCtx = createFakeContext(undefined, cwd);
    await otherPi.handlers.get('session_start')({}, otherCtx);
    assert.equal(await otherPi.handlers.get('before_provider_request')(request, otherCtx), undefined);
  }
});

test('--fast overrides the saved level without overwriting it', async () => {
  const ctx = createFakeContext();
  const pi = await install();
  await pi.commands.get('ultrafast').handler('', ctx);
  const flaggedPi = await install({ fast: true });
  await flaggedPi.handlers.get('session_start')({}, ctx);
  const request = { payload: {} };
  assert.equal((await flaggedPi.handlers.get('before_provider_request')(request, ctx)).service_tier, 'priority');
  const restartedPi = await install();
  await restartedPi.handlers.get('session_start')({}, ctx);
  assert.equal((await restartedPi.handlers.get('before_provider_request')(request, ctx)).service_tier, 'ultrafast');
});

test('invalid settings fail explicitly and persist a stack trace', async () => {
  const ctx = createFakeContext();
  mkdirSync(join(ctx.cwd, '.pi'));
  const path = join(ctx.cwd, '.pi', 'openai-fast-mode.json');
  for (const text of ['broken json', '{"level":"turbo"}', '{"enabled":true}']) {
    writeFileSync(path, text);
    const pi = await install();
    await assert.rejects(pi.handlers.get('session_start')({}, ctx));
  }
  const log = readFileSync(join(ctx.cwd, '.pi', 'logs', 'openai-speed.log'), 'utf8');
  assert.match(log, /SyntaxError/);
  assert.match(log, /Invalid speed level/);
  assert.match(log, /at projectSpeed/);
});

test('failed saves leave the active speed unchanged and report the failure', async () => {
  const ctx = createFakeContext();
  const pi = await install();
  await pi.commands.get('fast').handler('on', ctx);
  const path = join(ctx.cwd, '.pi', 'openai-fast-mode.json');
  rmSync(path);
  mkdirSync(path); // A directory at the destination prevents replacing the setting.
  await assert.rejects(pi.commands.get('ultrafast').handler('', ctx));
  assert.equal((await pi.handlers.get('before_provider_request')({ payload: {} }, ctx)).service_tier, 'priority');
  assert.deepEqual(ctx.notifications.at(-1), { message: 'Fast mode: on', type: 'info' });
  assert.match(readFileSync(join(ctx.cwd, '.pi', 'logs', 'openai-speed.log'), 'utf8'), /Error/);
});

test('unsupported models hide the indicator without forgetting the saved level', async () => {
  const pi = await install();
  const ctx = createFakeContext({ provider: 'anthropic', id: 'claude', api: 'anthropic-messages' });
  await pi.commands.get('ultrafast').handler('', ctx);
  assert.deepEqual(ctx.statuses.at(-1), { key: 'openai-fast-mode', text: undefined });
  assert.equal(await pi.handlers.get('before_provider_request')({ payload: {} }, ctx), undefined);
  ctx.model = { provider: 'openai-codex', id: 'gpt-6-astra', api: 'openai-codex-responses' };
  await pi.handlers.get('model_select')({}, ctx);
  assert.deepEqual(ctx.statuses.at(-1), { key: 'openai-fast-mode', text: '⚡ultrafast' });
  assert.equal((await pi.handlers.get('before_provider_request')({ payload: {} }, ctx)).service_tier, 'ultrafast');
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

test('real Pi sessions restore all three levels through slash commands', async () => {
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
    await import('@earendil-works/pi-coding-agent');
  const { getModel } = await import('@earendil-works/pi-ai/compat');
  const cwd = createAgentDir();
  const agentDir = createAgentDir();
  const sessions = [];

  async function start(directory = cwd) {
    const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: 'always' });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir, settingsManager,
      additionalExtensionPaths: [fileURLToPath(moduleUrl)],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: directory, agentDir, resourceLoader, settingsManager,
      model: getModel('openai', 'gpt-4o'),
      sessionManager: SessionManager.inMemory(directory), tools: [],
    });
    sessions.push(session);
    const notifications = [];
    const statuses = [];
    const errors = [];
    await session.bindExtensions({
      uiContext: {
        notify: (message, type) => notifications.push({ message, type }),
        setStatus: (key, text) => statuses.push({ key, text }),
      },
      onError: (error) => errors.push(error),
    });
    assert.deepEqual(errors, []);
    return { session, notifications, statuses, errors };
  }

  try {
    const first = await start();
    assert.equal(first.statuses.at(-1).text, undefined);
    await first.session.prompt('/fast on');
    assert.equal((await start()).statuses.at(-1).text, '⚡fast');
    const other = await start(createAgentDir());
    assert.equal(other.statuses.at(-1).text, undefined);
    await first.session.prompt('/ultrafast');
    assert.equal((await start()).statuses.at(-1).text, '⚡ultrafast');
    await first.session.prompt('/ultrafast');
    const normal = await start();
    assert.equal(normal.statuses.at(-1).text, undefined);
    await normal.session.prompt('/fast status');
    assert.equal(normal.notifications.at(-1).message, 'Fast mode: off (supported)');
    assert.deepEqual(first.errors, []);
  } finally {
    sessions.forEach((session) => session.dispose());
  }
});

test('fast mode adds priority service tier to the final provider payload', async () => {
  const pi = await install();
  const ctx = createFakeContext();
  const payload = { model: 'gpt-5.6-sol', input: [] };

  await pi.commands.get('fast').handler('on', ctx);
  const result = await pi.handlers.get('before_provider_request')({ payload }, ctx);

  assert.deepEqual(result, { ...payload, service_tier: 'priority' });
});
