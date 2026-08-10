import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../extensions/skill-invocation.ts', import.meta.url).href;

function createFakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
    },
    getCommands() {
      return [
        { name: 'tdd', description: 'Test-driven development', source: 'skill' },
        { name: 'research', description: 'Research a topic', source: 'skill' },
        { name: 'commit', description: 'Commit and push changes', source: 'skill' },
        { name: 'review', description: 'Review prompt', source: 'prompt' },
        { name: 'fast', description: 'Toggle fast mode', source: 'extension' },
      ];
    },
  };
}

async function install() {
  const { default: installSkillInvocation } = await import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
  const pi = createFakePi();
  installSkillInvocation(pi);
  return pi;
}

test("typing '$' offers loaded skills through autocomplete", async () => {
  const pi = await install();
  let providerFactory;
  const ctx = {
    ui: {
      addAutocompleteProvider(factory) {
        providerFactory = factory;
      },
    },
  };

  await pi.handlers.get('session_start')({}, ctx);

  assert.ok(providerFactory);
  const current = {
    async getSuggestions() {
      return null;
    },
    applyCompletion() {
      throw new Error('not used');
    },
  };
  const provider = providerFactory(current);
  const suggestions = await provider.getSuggestions(['$'], 0, 1, {
    signal: new AbortController().signal,
  });

  assert.deepEqual(provider.triggerCharacters, ['$']);
  assert.deepEqual(suggestions, {
    prefix: '$',
    items: [
      { value: '$tdd', label: '$tdd', description: 'Test-driven development' },
      { value: '$research', label: '$research', description: 'Research a topic' },
      { value: '$commit', label: '$commit', description: 'Commit and push changes' },
    ],
  });
});

test("accepting a '$' completion inserts the skill name and a trailing space", async () => {
  const pi = await install();
  let providerFactory;
  await pi.handlers.get('session_start')({}, {
    ui: {
      addAutocompleteProvider(factory) {
        providerFactory = factory;
      },
    },
  });
  const current = {
    async getSuggestions() {
      return null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const line = lines[cursorLine] ?? '';
      const completed = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol);
      return { lines: [completed], cursorLine, cursorCol: item.value.length };
    },
  };
  const provider = providerFactory(current);

  const result = provider.applyCompletion(
    ['$td'],
    0,
    3,
    { value: '$tdd', label: '$tdd' },
    '$td',
  );

  assert.deepEqual(result, {
    lines: ['$tdd '],
    cursorLine: 0,
    cursorCol: 5,
  });
});

test("submitting '$skill-name' rewrites to Pi's native skill command", async () => {
  const pi = await install();

  const result = await pi.handlers.get('input')({
    text: '$commit and push',
    images: undefined,
    source: 'interactive',
  }, {});

  assert.deepEqual(result, {
    action: 'transform',
    text: '/skill:commit and push',
  });
});

test("a '$skill-name' mention inside a prompt invokes that skill", async () => {
  const pi = await install();

  const result = await pi.handlers.get('input')({
    text: 'Use $tdd to implement the feature',
    images: undefined,
    source: 'interactive',
  }, {});

  assert.deepEqual(result, {
    action: 'transform',
    text: '/skill:tdd Use to implement the feature',
  });
});

test("an unknown '$name' remains ordinary prompt text", async () => {
  const pi = await install();

  const result = await pi.handlers.get('input')({
    text: '$not-a-loaded-skill keep this literal',
    images: undefined,
    source: 'interactive',
  }, {});

  assert.deepEqual(result, { action: 'continue' });
});
