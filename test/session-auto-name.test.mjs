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

  await pi.handlers.get('agent_end')({ type: 'agent_end', messages: [] }, ctx);

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

  await pi.handlers.get('agent_end')({ type: 'agent_end', messages: [] }, ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], ctx.model);
  assert.match(calls[0][1].systemPrompt, /concise session titles/i);
  assert.match(calls[0][1].messages[0].content[0].text, /User prompt 1:/);
  assert.doesNotMatch(calls[0][1].messages[0].content[0].text, /User prompt 2:/);
  assert.deepEqual(calls[0][2], { apiKey: 'test-key', headers: { 'x-test': '1' }, signal: undefined });
  assert.deepEqual(pi.setNames, ['Automatic Session Naming']);
  assert.equal(pi.sentUserMessages.length, 0);
  assert.equal(pi.sentMessages.length, 0);
});

test('runs manual auto-naming when /name has no argument', async () => {
  const { createSessionAutoNameExtension } = await freshModule();
  const pi = createFakePi('Old Session Name');
  const ctx = createFakeContext([
    messageEntry('user', 'Please inspect this repository.'),
    messageEntry('assistant', 'I inspected the repository.', { stopReason: 'stop' }),
  ]);

  createSessionAutoNameExtension({
    complete: async () => ({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Generated Session Name' }],
    }),
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

  await pi.handlers.get('agent_end')({ type: 'agent_end', messages: [] }, ctx);

  assert.equal(calls.length, 0);
  assert.deepEqual(pi.setNames, []);
});
