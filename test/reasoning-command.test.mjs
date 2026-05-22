import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../extensions/reasoning-command.ts', import.meta.url).href;

async function freshReasoningCommandModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

function createFakePi() {
  const commands = new Map();
  const selectedLevels = [];
  return {
    commands,
    selectedLevels,
    registerCommand(name, options) {
      commands.set(name, options);
    },
    setThinkingLevel(level) {
      selectedLevels.push(level);
    },
  };
}

function createFakeContext(selectResult = undefined) {
  const notifications = [];
  const selectCalls = [];
  return {
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
  ];

  for (const [arg, expected] of cases) {
    const pi = await install();
    const ctx = createFakeContext();

    await pi.commands.get('r').handler(arg, ctx);

    assert.deepEqual(pi.selectedLevels, [expected]);
    assert.deepEqual(ctx.notifications, [{ message: `Reasoning: ${expected}`, type: 'info' }]);
  }
});

test('/r full level names set the requested thinking level', async () => {
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
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
    options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  }]);
  assert.deepEqual(pi.selectedLevels, ['medium']);
  assert.deepEqual(ctx.notifications, [{ message: 'Reasoning: medium', type: 'info' }]);
});

test('/r invalid arguments notify an error without changing thinking level', async () => {
  const pi = await install();
  const ctx = createFakeContext();

  await pi.commands.get('r').handler('min', ctx);

  assert.deepEqual(pi.selectedLevels, []);
  assert.deepEqual(ctx.notifications, [{
    message: 'Unknown reasoning level: min',
    type: 'error',
  }]);
});
