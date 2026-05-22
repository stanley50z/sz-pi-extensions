import test from 'node:test';
import assert from 'node:assert/strict';

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
  return {
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
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setStatus() {},
    },
  };
}

test('does not generate a name before the second user prompt has an answer', async () => {
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

  assert.equal(calls.length, 0);
  assert.deepEqual(pi.setNames, []);
});

test('generates and persists a sanitized session name after the second answered prompt', async () => {
  const { createSessionAutoNameExtension } = await freshModule();
  const calls = [];
  const pi = createFakePi();
  const ctx = createFakeContext([
    messageEntry('user', 'Please inspect this repository.'),
    messageEntry('assistant', 'I inspected the repository.', { stopReason: 'stop' }),
    messageEntry('user', 'Add automatic session naming after round two.'),
    messageEntry('assistant', 'I will implement a session auto-name extension.', { stopReason: 'stop' }),
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
  assert.match(calls[0][1].messages[0].content[0].text, /User prompt 2:/);
  assert.deepEqual(calls[0][2], { apiKey: 'test-key', headers: { 'x-test': '1' }, signal: undefined });
  assert.deepEqual(pi.setNames, ['Automatic Session Naming']);
  assert.equal(pi.sentUserMessages.length, 0);
  assert.equal(pi.sentMessages.length, 0);
});

test('registers /autoname to generate a name for the current session on demand', async () => {
  const { createSessionAutoNameExtension } = await freshModule();
  const calls = [];
  const pi = createFakePi();
  const ctx = createFakeContext([
    messageEntry('user', 'Please inspect this repository.'),
    messageEntry('assistant', 'I inspected the repository.', { stopReason: 'stop' }),
    messageEntry('user', 'Add automatic session naming after round two.'),
    messageEntry('assistant', 'I will implement a session auto-name extension.', { stopReason: 'stop' }),
  ]);

  createSessionAutoNameExtension({
    complete: async (...args) => {
      calls.push(args);
      return { stopReason: 'stop', content: [{ type: 'text', text: 'On Demand Session Naming' }] };
    },
  })(pi);

  await pi.commands.get('autoname').handler('', ctx);

  assert.equal(calls.length, 1);
  assert.deepEqual(pi.setNames, ['On Demand Session Naming']);
  assert.equal(pi.sentUserMessages.length, 0);
  assert.equal(pi.sentMessages.length, 0);
});

test('skips automatic naming when the session already has an explicit name', async () => {
  const { createSessionAutoNameExtension } = await freshModule();
  const calls = [];
  const pi = createFakePi('Manual Name');
  const ctx = createFakeContext([
    messageEntry('user', 'First prompt'),
    messageEntry('assistant', 'First answer', { stopReason: 'stop' }),
    messageEntry('user', 'Second prompt'),
    messageEntry('assistant', 'Second answer', { stopReason: 'stop' }),
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
