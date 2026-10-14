import test from 'node:test';
import assert from 'node:assert/strict';
import { KeybindingsManager, TUI_KEYBINDINGS } from '@earendil-works/pi-tui';

const moduleUrl = new URL('../extensions/session-auto-name.ts', import.meta.url).href;

async function freshModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

function messageEntry(role, text, extra = {}) {
  return {
    type: 'message',
    message: {
      role,
      content: [{ type: 'text', text }],
      timestamp: Date.now(),
      ...extra,
    },
  };
}

function createFakePi(existingName) {
  const handlers = new Map();
  const setNames = [];
  const appendedEntries = [];
  const sentUserMessages = [];
  const sentMessages = [];
  const commands = new Map();

  return {
    handlers,
    commands,
    setNames,
    appendedEntries,
    sentUserMessages,
    sentMessages,
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    getSessionName() {
      return existingName ?? setNames.at(-1);
    },
    setSessionName(name) {
      setNames.push(name);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    sendUserMessage(content, options) {
      sentUserMessages.push({ content, options });
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
  };
}

function createFakeContext(branch, overrides = {}) {
  const model = overrides.model ?? { provider: 'openai', id: 'gpt-test', reasoning: true };
  const notifications = [];
  let editorFactory;
  return {
    mode: 'tui',
    model,
    signal: overrides.signal,
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
      getSessionFile: () => '/tmp/session.jsonl',
    },
    modelRegistry: {
      getApiKeyAndHeaders: async (requestedModel) => {
        assert.equal(requestedModel, model);
        return overrides.auth ?? { ok: true, apiKey: 'test-key', headers: { 'x-test': '1' } };
      },
    },
    notifications,
    get editorFactory() {
      return editorFactory;
    },
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      getEditorComponent() {
        return undefined;
      },
      setEditorComponent(factory) {
        editorFactory = factory;
      },
      setStatus() {},
    },
  };
}

test('names bridge sessions through the session registry as an isolated one-off request', async () => {
  const { default: install } = await freshModule();
  const pi = createFakePi();
  const model = { provider: 'claude-bridge', id: 'claude-haiku-4-5', api: 'claude-bridge' };
  const ctx = createFakeContext([
    messageEntry('user', 'Test the Claude bridge installation.'),
    messageEntry('assistant', 'The bridged file read succeeded.'),
  ], { model });
  const calls = [];
  ctx.modelRegistry.complete = async (...args) => {
    calls.push(args);
    return { stopReason: 'stop', content: [{ type: 'text', text: 'Test Claude bridge installation' }] };
  };

  install(pi);
  await pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], model);
  assert.equal(calls[0][2].cacheRetention, 'none');
  assert.deepEqual(pi.setNames, ['Test Claude bridge installation']);
});

test('generates a session name after the first user prompt receives an answer', async () => {
  const { createSessionAutoNameExtension } = await freshModule();
  const calls = [];
  const pi = createFakePi();
  const ctx = createFakeContext([
    messageEntry('user', 'Please inspect this repository.'),
    messageEntry('assistant', 'I inspected the repository.', { stopReason: 'stop' }),
  ]);

  createSessionAutoNameExtension({
    complete: async (...args) => {
      calls.push(args);
      return { stopReason: 'stop', content: [{ type: 'text', text: 'Repository Inspection' }] };
    },
  })(pi);

  await pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, ctx);

  assert.equal(calls.length, 1);
  assert.deepEqual(pi.setNames, ['Repository Inspection']);
});

test('persists a sanitized session name without adding a conversation turn', async () => {
  const { createSessionAutoNameExtension } = await freshModule();
  const calls = [];
  const pi = createFakePi();
  const ctx = createFakeContext([
    messageEntry('user', 'Please inspect this repository.'),
    messageEntry('assistant', 'I inspected the repository.', { stopReason: 'stop' }),
  ]);

  createSessionAutoNameExtension({
    complete: async (...args) => {
      calls.push(args);
      return { stopReason: 'stop', content: [{ type: 'text', text: '"Automatic Session Naming."\n' }] };
    },
  })(pi);

  await pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], ctx.model);
  assert.match(calls[0][1].systemPrompt, /concise session titles/i);
  assert.match(calls[0][1].messages[0].content[0].text, /User prompt 1:/);
  assert.doesNotMatch(calls[0][1].messages[0].content[0].text, /User prompt 2:/);
  const { signal, ...requestOptions } = calls[0][2];
  assert.equal(signal.aborted, false);
  assert.deepEqual(requestOptions, { apiKey: 'test-key', headers: { 'x-test': '1' } });
  assert.deepEqual(pi.setNames, ['Automatic Session Naming']);
  assert.equal(pi.sentUserMessages.length, 0);
  assert.equal(pi.sentMessages.length, 0);
});

test('names Copilot sessions using the account endpoint resolved by authentication', async () => {
  const { createSessionAutoNameExtension } = await freshModule();
  const pi = createFakePi();
  const model = {
    provider: 'github-copilot',
    id: 'claude-fable-5.1',
    api: 'anthropic-messages',
    baseUrl: 'https://api.individual.githubcopilot.com',
  };
  const ctx = createFakeContext([
    messageEntry('user', 'Fix session auto naming for GitHub Copilot.'),
    messageEntry('assistant', 'I will inspect the naming request.'),
  ], {
    model,
    auth: {
      ok: true,
      apiKey: 'test-key',
      headers: { 'Copilot-Integration-Id': 'vscode-chat' },
      baseUrl: 'https://api.business.githubcopilot.com',
    },
  });

  createSessionAutoNameExtension({
    complete: async (requestModel, _context, options) => {
      assert.equal(options.apiKey, 'test-key');
      assert.deepEqual(options.headers, { 'Copilot-Integration-Id': 'vscode-chat' });
      return requestModel.baseUrl === 'https://api.business.githubcopilot.com'
        ? { stopReason: 'stop', content: [{ type: 'text', text: 'Fix Copilot session auto naming' }] }
        : { stopReason: 'error', content: [], errorMessage: '421 Misdirected Request' };
    },
  })(pi);

  await pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, ctx);

  assert.deepEqual(pi.setNames, ['Fix Copilot session auto naming']);
  assert.equal(model.baseUrl, 'https://api.individual.githubcopilot.com');
});

test('retries overloaded naming requests on a timer without another turn', async (t) => {
  const { createSessionAutoNameExtension } = await freshModule();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pi = createFakePi();
  const ctx = createFakeContext([
    messageEntry('user', 'Fix session auto naming.'),
    messageEntry('assistant', 'I will inspect the naming request.'),
  ]);
  let attempts = 0;
  createSessionAutoNameExtension({
    complete: async () => ++attempts < 4
      ? { stopReason: 'error', errorMessage: 'Our servers are currently overloaded. Please try again later.', content: [{ type: 'text', text: 'Partial title' }] }
      : { stopReason: 'stop', content: [{ type: 'text', text: 'Fix session auto naming' }] },
  })(pi);

  const naming = pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, ctx);
  // Attach immediately so a failed first attempt cannot become an unhandled rejection.
  const finished = assert.doesNotReject(naming);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  for (const delay of [2000, 4000, 8000]) {
    t.mock.timers.tick(delay - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pi.setNames, []);
    const before = attempts;
    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, before + 1);
  }
  await finished;
  assert.deepEqual(pi.setNames, ['Fix session auto naming']);
});

test('reports the final error after bounded retries and allows a later naming attempt', async (t) => {
  const { createSessionAutoNameExtension } = await freshModule();
  const pi = createFakePi();
  const ctx = createFakeContext([
    messageEntry('user', 'Fix session auto naming.'),
    messageEntry('assistant', 'I will inspect the naming request.'),
  ]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  createSessionAutoNameExtension({
    complete: async () => ++attempts <= 4
      ? { stopReason: 'error', errorMessage: `Naming failure ${attempts}`, content: [{ type: 'text', text: 'Partial title' }] }
      : { stopReason: 'stop', content: [{ type: 'text', text: 'Fix session auto naming' }] },
  })(pi);

  const failed = assert.rejects(
    pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, ctx),
    /Naming failure 4/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  for (const delay of [2000, 4000, 8000]) {
    t.mock.timers.tick(delay);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await failed;
  t.mock.timers.tick(60_000);
  assert.equal(attempts, 4);
  assert.deepEqual(pi.setNames, []);
  await pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, ctx);
  assert.deepEqual(pi.setNames, ['Fix session auto naming']);
});

test('retries thrown request errors without starting duplicate naming jobs', async (t) => {
  const { createSessionAutoNameExtension } = await freshModule();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pi = createFakePi();
  const ctx = createFakeContext([
    messageEntry('user', 'Fix session auto naming.'),
    messageEntry('assistant', 'I will inspect the naming request.'),
  ]);
  let attempts = 0;
  createSessionAutoNameExtension({
    complete: async () => {
      if (++attempts === 1) throw new Error('Connection reset');
      return { stopReason: 'stop', content: [{ type: 'text', text: 'Fix session auto naming' }] };
    },
  })(pi);
  const naming = pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  await pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, ctx);
  assert.equal(attempts, 1);
  t.mock.timers.tick(2000);
  await naming;
  assert.equal(attempts, 2);
  assert.deepEqual(pi.setNames, ['Fix session auto naming']);
});

test('cancels pending naming retries when the session shuts down', async (t) => {
  const { createSessionAutoNameExtension } = await freshModule();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pi = createFakePi();
  const ctx = createFakeContext([
    messageEntry('user', 'Fix session auto naming.'),
    messageEntry('assistant', 'I will inspect the naming request.'),
  ]);
  let attempts = 0;
  createSessionAutoNameExtension({
    complete: async () => {
      attempts += 1;
      return { stopReason: 'error', errorMessage: 'Our servers are currently overloaded.', content: [] };
    },
  })(pi);
  const naming = pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  await pi.handlers.get('session_shutdown')({ type: 'session_shutdown' }, ctx);
  await naming;
  t.mock.timers.tick(60_000);
  assert.equal(attempts, 1);
  assert.deepEqual(pi.setNames, []);
});

test('ignores late naming results after a session replacement', async () => {
  const { createSessionAutoNameExtension } = await freshModule();
  const pi = createFakePi();
  const branch = [messageEntry('user', 'Fix session auto naming.'), messageEntry('assistant', 'I will inspect it.')];
  const oldCtx = createFakeContext(branch);
  const newCtx = createFakeContext(branch);
  let finishOldRequest;
  let attempts = 0;
  createSessionAutoNameExtension({
    complete: async () => {
      if (++attempts === 1) return new Promise((resolve) => { finishOldRequest = resolve; });
      return { stopReason: 'stop', content: [{ type: 'text', text: 'New session title' }] };
    },
  })(pi);
  const oldNaming = pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, oldCtx);
  await new Promise((resolve) => setImmediate(resolve));
  await pi.handlers.get('session_start')({ type: 'session_start', reason: 'switch' }, newCtx);
  await pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, newCtx);
  finishOldRequest({ stopReason: 'stop', content: [{ type: 'text', text: 'Stale session title' }] });
  await oldNaming;
  assert.deepEqual(pi.setNames, ['New session title']);
});

test('does not retry an aborted naming response', async (t) => {
  const { createSessionAutoNameExtension } = await freshModule();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pi = createFakePi();
  const ctx = createFakeContext([messageEntry('user', 'Fix naming.'), messageEntry('assistant', 'I will inspect it.')]);
  let attempts = 0;
  createSessionAutoNameExtension({
    complete: async () => {
      attempts += 1;
      return { stopReason: 'aborted', content: [] };
    },
  })(pi);
  await pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, ctx);
  t.mock.timers.tick(60_000);
  assert.equal(attempts, 1);
  assert.deepEqual(pi.setNames, []);
});

test('bare /name retries failed requests before reporting a generated title', async (t) => {
  const { createSessionAutoNameExtension } = await freshModule();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pi = createFakePi('Old Session Name');
  const ctx = createFakeContext([
    messageEntry('user', 'Please inspect this repository.'),
    messageEntry('assistant', 'I inspected the repository.', { stopReason: 'stop' }),
  ]);

  let attempts = 0;
  createSessionAutoNameExtension({
    complete: async () => ++attempts === 1
      ? { stopReason: 'error', errorMessage: 'Our servers are currently overloaded.', content: [] }
      : { stopReason: 'stop', content: [{ type: 'text', text: 'Generated Session Name' }] },
  })(pi);

  await pi.handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  const plain = (text) => text;
  const editor = ctx.editorFactory({
    terminal: { rows: 30 },
    requestRender() {},
  }, {
    borderColor: plain,
    selectList: {
      selectedPrefix: plain,
      selectedText: plain,
      description: plain,
      scrollInfo: plain,
      noMatch: plain,
    },
  }, keybindings);
  const submitted = [];
  editor.onSubmit = (text) => submitted.push(text);
  editor.setText('/name');

  editor.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ctx.notifications, []);
  t.mock.timers.tick(2000);
  for (let attempt = 0; attempt < 20 && pi.setNames.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(pi.commands.has('autoname'), false);
  assert.deepEqual(submitted, []);
  assert.deepEqual(pi.setNames, ['Generated Session Name']);
  assert.deepEqual(ctx.notifications, [
    { message: 'Session name set: Generated Session Name', type: 'info' },
  ]);
});

test("/name with an argument remains on Pi's built-in naming path", async () => {
  const { createSessionAutoNameExtension } = await freshModule();
  const pi = createFakePi();
  const ctx = createFakeContext([]);

  createSessionAutoNameExtension({
    complete: async () => {
      throw new Error('Auto-naming should not run');
    },
  })(pi);

  await pi.handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  const plain = (text) => text;
  const editor = ctx.editorFactory({
    terminal: { rows: 30 },
    requestRender() {},
  }, {
    borderColor: plain,
    selectList: {
      selectedPrefix: plain,
      selectedText: plain,
      description: plain,
      scrollInfo: plain,
      noMatch: plain,
    },
  }, keybindings);
  const submitted = [];
  editor.onSubmit = (text) => submitted.push(text);
  editor.setText('/name Chosen Name');

  editor.handleInput('\r');

  assert.deepEqual(submitted, ['/name Chosen Name']);
  assert.deepEqual(pi.setNames, []);
});

test('skips automatic naming when the session already has an explicit name', async () => {
  const { createSessionAutoNameExtension } = await freshModule();
  const calls = [];
  const pi = createFakePi('Manual Name');
  const ctx = createFakeContext([
    messageEntry('user', 'First prompt'),
    messageEntry('assistant', 'First answer', { stopReason: 'stop' }),
  ]);

  createSessionAutoNameExtension({
    complete: async (...args) => {
      calls.push(args);
      return { stopReason: 'stop', content: [{ type: 'text', text: 'Generated Name' }] };
    },
  })(pi);

  await pi.handlers.get('agent_settled')({ type: 'agent_settled', messages: [] }, ctx);

  assert.equal(calls.length, 0);
  assert.deepEqual(pi.setNames, []);
});
