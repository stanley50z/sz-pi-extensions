import test from 'node:test';
import assert from 'node:assert/strict';
import install from '../extensions/commit-button.ts';

// Exercise the extension's public editor factory and message API without running git.
test('commit click sends an expanded follow-up without touching the draft or keyboard handler', () => {
  let start;
  let factory;
  const sent = [];
  const mouseEvents = [];
  const editor = {
    getText: () => 'unfinished draft',
    handleInput() {},
    render: (width) => ['─'.repeat(width), 'unfinished draft', '─'.repeat(width)],
    handleMouse: (event) => { mouseEvents.push(event); },
    invalidate() {},
  };
  const keyboard = editor.handleInput;
  install({
    on: (name, handler) => { if (name === 'session_start') start = handler; },
    sendUserMessage: (...args) => sent.push(args),
  });
  start({}, {
    mode: 'tui',
    ui: {
      theme: { fg: (_color, text) => text },
      getEditorComponent: () => () => editor,
      setEditorComponent: (value) => { factory = value; },
    },
  });
  const plain = (text) => text;
  const wrapped = factory({}, {
    borderColor: plain,
    selectList: {
      selectedPrefix: plain,
      selectedText: plain,
      description: plain,
      scrollInfo: plain,
      noMatch: plain,
    },
  }, {});
  const lines = wrapped.render(80);
  const x = lines[0].indexOf('[ commit ]');
  assert.notEqual(x, -1);
  wrapped.handleMouse({ type: 'press', button: 'left', x, y: 0 });
  assert.equal(sent.length, 0);
  wrapped.handleMouse({ type: 'click', button: 'left', x, y: 0 });
  assert.deepEqual(sent, [['$commit', { deliverAs: 'followUp', expandPromptTemplates: true }]]);
  assert.equal(wrapped.getText(), 'unfinished draft');
  assert.equal(wrapped.handleInput, keyboard);
  const outside = { type: 'click', button: 'left', x: 0, y: 1 };
  wrapped.handleMouse(outside);
  assert.deepEqual(mouseEvents, [outside]);
});

test('non-TUI sessions do not install the button', () => {
  let start;
  install({ on: (_name, handler) => { start = handler; } });
  start({}, { mode: 'rpc' });
});
