import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
} from '@earendil-works/pi-tui';

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
        { name: 'skill:tdd', description: 'Test-driven development', source: 'skill' },
        { name: 'skill:research', description: 'Research a topic', source: 'skill' },
        { name: 'skill:commit', description: 'Commit and push changes', source: 'skill' },
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

async function createEditorHarness() {
  const pi = await install();
  let editorFactory;
  let providerFactory;
  await pi.handlers.get('session_start')({}, {
    ui: {
      addAutocompleteProvider(factory) {
        providerFactory = factory;
      },
      setEditorComponent(factory) {
        editorFactory = factory;
      },
    },
  });

  assert.ok(editorFactory);
  assert.ok(providerFactory);

  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);
  const plain = (text) => text;
  const editor = editorFactory({
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

  return { editor, providerFactory };
}

test('preserves an editor wrapper installed by another extension', async () => {
  const pi = await install();
  const handledInputs = [];
  let editorFactory;
  const previousEditor = {
    getText: () => '/name',
    setText() {},
    handleInput(data) {
      handledInputs.push(data);
    },
    render: () => [],
    invalidate() {},
  };

  await pi.handlers.get('session_start')({}, {
    ui: {
      addAutocompleteProvider() {},
      getEditorComponent() {
        return () => previousEditor;
      },
      setEditorComponent(factory) {
        editorFactory = factory;
      },
    },
  });

  const editor = editorFactory({}, {}, new KeybindingsManager(TUI_KEYBINDINGS));
  editor.handleInput('\r');

  assert.equal(editor, previousEditor);
  assert.deepEqual(handledInputs, ['\r']);
});

test("typing '$' offers loaded skills through autocomplete", async () => {
  const pi = await install();
  let providerFactory;
  const ctx = {
    ui: {
      addAutocompleteProvider(factory) {
        providerFactory = factory;
      },
      setEditorComponent() {},
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
      setEditorComponent() {},
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

test("Enter accepts a visible '/skill:' completion without submitting it", async () => {
  const { editor, providerFactory } = await createEditorHarness();
  const current = {
    async getSuggestions(lines, cursorLine, cursorCol) {
      const prefix = (lines[cursorLine] ?? '').slice(0, cursorCol);
      if (!prefix.startsWith('/skill:')) return null;
      return {
        prefix,
        items: [{ value: '/skill:tdd', label: '/skill:tdd' }],
      };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = lines[cursorLine] ?? '';
      const completedLines = [...lines];
      completedLines[cursorLine] = `${currentLine.slice(0, cursorCol - prefix.length)}${item.value} ${currentLine.slice(cursorCol)}`;
      return {
        lines: completedLines,
        cursorLine,
        cursorCol: item.value.length + 1,
      };
    },
  };
  editor.setAutocompleteProvider(providerFactory(current));
  editor.setText('/skill:td');
  const submitted = [];
  editor.onSubmit = (text) => submitted.push(text);

  editor.handleInput('\t');
  for (let attempt = 0; attempt < 20 && !editor.isShowingAutocomplete(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(editor.isShowingAutocomplete(), true);

  editor.handleInput('\r');

  assert.equal(editor.getText(), '/skill:tdd ');
  assert.deepEqual(submitted, []);
});

test("Enter completes a '$skill' token without submitting it", async () => {
  const { editor, providerFactory } = await createEditorHarness();
  const current = {
    async getSuggestions() {
      return null;
    },
    applyCompletion() {
      throw new Error('not used');
    },
    shouldTriggerFileCompletion() {
      return true;
    },
  };
  editor.setAutocompleteProvider(providerFactory(current));
  editor.setText('$td');
  const submitted = [];
  editor.onSubmit = (text) => submitted.push(text);

  editor.handleInput('\r');
  for (let attempt = 0; attempt < 20 && editor.getText() === '$td'; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(editor.getText(), '$tdd ');
  assert.deepEqual(submitted, []);
});

test("Enter still submits an unknown '$name' as ordinary prompt text", async () => {
  const { editor, providerFactory } = await createEditorHarness();
  const current = {
    async getSuggestions() {
      return null;
    },
    applyCompletion() {
      throw new Error('not used');
    },
    shouldTriggerFileCompletion() {
      return true;
    },
  };
  editor.setAutocompleteProvider(providerFactory(current));
  editor.setText('$unknown');
  const submitted = [];
  editor.onSubmit = (text) => submitted.push(text);

  editor.handleInput('\r');

  assert.deepEqual(submitted, ['$unknown']);
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
