import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { CombinedAutocompleteProvider, Editor } from '@earendil-works/pi-tui';

const moduleUrl = new URL('../extensions/reasoning-command.ts', import.meta.url).href;

async function freshReasoningCommandModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

function createFakePi() {
  const commands = new Map();
  const handlers = new Map();
  const selectedLevels = [];
  return {
    commands,
    handlers,
    selectedLevels,
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    setThinkingLevel(level) {
      selectedLevels.push(level);
    },
  };
}

function createFakeContext(selectResult = undefined, model = undefined) {
  const notifications = [];
  const selectCalls = [];
  return {
    model,
    notifications,
    selectCalls,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      async select(title, options) {
        selectCalls.push({ title, options });
        return selectResult;
      },
    },
  };
}

async function install() {
  const { default: installReasoningCommand } = await freshReasoningCommandModule();
  const pi = createFakePi();
  installReasoningCommand(pi);
  return pi;
}

test('/r is registered as an extension slash command', async () => {
  const pi = await install();

  assert.ok(pi.commands.has('r'));
  assert.equal(pi.commands.get('r').description, 'Change reasoning level');
});

test('/r shorthand arguments set the requested thinking level', async () => {
  const cases = [
    ['o', 'off'],
    ['l', 'low'],
    ['m', 'medium'],
    ['h', 'high'],
    ['xh', 'xhigh'],
    ['max', 'max'],
  ];

  for (const [arg, expected] of cases) {
    const pi = await install();
    const ctx = createFakeContext();

    await pi.commands.get('r').handler(arg, ctx);

    assert.deepEqual(pi.selectedLevels, [expected]);
    assert.deepEqual(ctx.notifications, [{ message: `Reasoning: ${expected}`, type: 'info' }]);
  }
});

test('/r l applies low reasoning after one Enter in the Pi editor', async () => {
  const pi = await install();
  const command = pi.commands.get('r');
  const ctx = createFakeContext();
  const editor = new Editor({ requestRender() {} }, {
    borderColor: (text) => text,
    selectList: {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
  });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
    { name: 'r', ...command },
  ], process.cwd()));
  const submissions = [];
  editor.onSubmit = (text) => {
    submissions.push(text);
    void command.handler(text.slice('/r '.length), ctx);
  };

  for (const character of '/r l') {
    editor.handleInput(character);
    await setImmediate();
  }
  editor.handleInput('\r');

  assert.deepEqual(submissions, ['/r l']);
  assert.deepEqual(pi.selectedLevels, ['low']);
});

test('/r hides completions for complete arguments but keeps incomplete suggestions', async () => {
  const pi = await install();
  const { getArgumentCompletions } = pi.commands.get('r');

  for (const argument of ['o', 'l', 'm', 'h', 'xh', 'off', 'low', 'medium', 'high', 'xhigh', 'max', ' L ']) {
    assert.equal(getArgumentCompletions(argument), null, argument);
  }
  assert.deepEqual(getArgumentCompletions('lo'), [{ value: 'low', label: 'low' }]);
  assert.deepEqual(getArgumentCompletions('').map(({ value }) => value), [
    'o', 'l', 'm', 'h', 'xh', 'off', 'low', 'medium', 'high', 'xhigh', 'max',
  ]);
  assert.equal(getArgumentCompletions('min'), null);
});

test('/r full level names set the requested thinking level', async () => {
  for (const level of ['off', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const pi = await install();
    const ctx = createFakeContext();

    await pi.commands.get('r').handler(level, ctx);

    assert.deepEqual(pi.selectedLevels, [level]);
  }
});

test('/r without an argument opens a picker and applies the selected thinking level', async () => {
  const pi = await install();
  const ctx = createFakeContext('medium');

  await pi.commands.get('r').handler('', ctx);

  assert.deepEqual(ctx.selectCalls, [{
    title: 'Reasoning level',
    options: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  }]);
  assert.deepEqual(pi.selectedLevels, ['medium']);
  assert.deepEqual(ctx.notifications, [{ message: 'Reasoning: medium', type: 'info' }]);
});

test('/r invalid and minimal arguments notify an error without changing thinking level', async () => {
  for (const argument of ['min', 'minimal']) {
    const pi = await install();
    const ctx = createFakeContext();

    await pi.commands.get('r').handler(argument, ctx);

    assert.deepEqual(pi.selectedLevels, []);
    assert.deepEqual(ctx.notifications, [{
      message: `Unknown reasoning level: ${argument}`,
      type: 'error',
    }]);
  }
});

test('/r picker only exposes levels supported by the active model', async () => {
  const pi = await install();
  const deepSeek = {
    provider: 'deepseek',
    id: 'deepseek-v4-pro',
    reasoning: true,
    thinkingLevelMap: {
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      max: 'max',
    },
  };
  const ctx = createFakeContext('high', deepSeek);

  await pi.commands.get('r').handler('', ctx);

  assert.deepEqual(ctx.selectCalls, [{
    title: 'Reasoning level',
    options: ['off', 'high', 'max'],
  }]);
  assert.deepEqual(pi.selectedLevels, ['high']);
});

test('/r completions follow the model selected for the current session', async () => {
  const pi = await install();
  const deepSeek = {
    provider: 'deepseek',
    id: 'deepseek-v4-pro',
    reasoning: true,
    thinkingLevelMap: {
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      max: 'max',
    },
  };

  await pi.handlers.get('session_start')({}, { model: deepSeek });
  const completions = await pi.commands.get('r').getArgumentCompletions('');

  assert.deepEqual(completions.map(({ value }) => value), ['o', 'h', 'off', 'high', 'max']);
});
