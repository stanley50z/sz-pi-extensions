import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import install, { createCommitButtonExtension } from '../extensions/commit-button.ts';

// Exercise the public editor factory, mouse events and shutdown request without running git or exiting the test process.
function setup(t, options = {}) {
  const handlers = new Map();
  let factory;
  let shutdowns = 0;
  let renders = 0;
  let ctrl = false;
  const sent = [];
  const submitted = [];
  const notifications = [];
  const mouseEvents = [];
  const editor = {
    getText: () => 'unfinished draft',
    handleInput() {},
    onSubmit: (text) => submitted.push(text),
    render: (width) => ['─'.repeat(width), 'unfinished draft', '─'.repeat(width)],
    handleMouse: (event) => { mouseEvents.push(event); },
    invalidate() {},
  };
  const keyboard = editor.handleInput;
  (options.install ?? createCommitButtonExtension({ isCtrlPressed: () => ctrl }))({
    on: (name, handler) => handlers.set(name, handler),
    sendUserMessage: (...args) => sent.push(args),
  });
  const ctx = {
    mode: 'tui',
    shutdown: () => { shutdowns++; },
    ui: {
      theme: { fg: (_color, text) => text },
      notify: (...args) => notifications.push(args),
      getEditorComponent: () => () => editor,
      setEditorComponent: (value) => { factory = value; },
    },
  };
  handlers.get('session_start')({}, ctx);
  t.after(() => handlers.get('session_shutdown')?.({}, ctx));
  const tui = options.tui ?? { requestRender() { renders++; } };
  const wrapped = factory(tui, {}, {});
  return {
    wrapped, sent, submitted, notifications, mouseEvents, keyboard, tui,
    setCtrl(value) { ctrl = value; },
    replace: () => factory(tui, {}, {}),
    shutdown: () => handlers.get('session_shutdown')({}, ctx),
    get shutdowns() { return shutdowns; },
    get renders() { return renders; },
  };
}

test('commit click sends an expanded follow-up without touching the draft or keyboard handler', (t) => {
  const h = setup(t);
  const lines = h.wrapped.render(80);
  const x = lines[0].indexOf('[ commit ]');
  assert.notEqual(x, -1);
  h.wrapped.handleMouse({ type: 'press', button: 'left', x, y: 0 });
  assert.equal(h.sent.length, 0);
  h.wrapped.handleMouse({ type: 'click', button: 'left', x, y: 0 });
  assert.deepEqual(h.sent, [['$commit', { deliverAs: 'followUp', expandPromptTemplates: true }]]);
  assert.equal(h.wrapped.getText(), 'unfinished draft');
  assert.equal(h.wrapped.handleInput, h.keyboard);
  const outside = { type: 'click', button: 'left', x: 0, y: 1 };
  h.wrapped.handleMouse(outside);
  assert.deepEqual(h.mouseEvents, [outside]);
});

test('holding Ctrl shows Exit while idle and releasing restores Commit', async (t) => {
  const h = setup(t);
  assert.match(h.wrapped.render(80)[0], /\[ commit \]$/);
  h.setCtrl(true);
  await delay(100);
  assert.match(h.wrapped.render(80)[0], /\[ exit \]$/);
  assert.ok(h.renders > 0, 'bare modifier transitions repaint without keyboard input');
  h.setCtrl(false);
  await delay(100);
  assert.match(h.wrapped.render(80)[0], /\[ commit \]$/);
});

test('Ctrl-click submits the built-in /quit command, not deferred extension shutdown or a commit', (t) => {
  const h = setup(t);
  const x = h.wrapped.render(80)[0].indexOf('[ commit ]');
  h.wrapped.handleMouse({ type: 'press', button: 'left', ctrl: true, x, y: 0 });
  assert.equal(h.shutdowns, 0);
  h.wrapped.handleMouse({ type: 'click', button: 'left', ctrl: true, x, y: 0 });
  assert.deepEqual(h.submitted, ['/quit']);
  assert.equal(h.shutdowns, 0, 'extension shutdown would defer exit while Pi is busy');
  assert.deepEqual(h.sent, []);
  assert.equal(h.wrapped.getText(), 'unfinished draft');
});

test('a plain click still commits when the last repaint showed Exit', async (t) => {
  const h = setup(t);
  h.setCtrl(true);
  await delay(100);
  const x = h.wrapped.render(80)[0].indexOf('[ exit ]');
  assert.notEqual(x, -1);
  h.wrapped.handleMouse({ type: 'click', button: 'left', ctrl: false, x, y: 0 });
  assert.equal(h.shutdowns, 0);
  assert.equal(h.sent.length, 1);
});

test('Ctrl in another app does not show Exit, and focus tracking cleans up', async (t) => {
  const inputs = [];
  const original = (data) => { inputs.push(data); return { consume: true }; };
  const tui = { requestRender() {}, handleViewportInput: original };
  const h = setup(t, { tui });
  h.setCtrl(true);
  await delay(100);
  assert.match(h.wrapped.render(80)[0], /\[ exit \]$/);
  assert.deepEqual(tui.handleViewportInput('\x1b[O'), { consume: true });
  await delay(100);
  assert.match(h.wrapped.render(80)[0], /\[ commit \]$/);
  tui.handleViewportInput('\x1b[I');
  await delay(100);
  assert.match(h.wrapped.render(80)[0], /\[ exit \]$/);
  h.shutdown();
  assert.equal(tui.handleViewportInput, original);
  assert.deepEqual(inputs, ['\x1b[O', '\x1b[I']);
});

test('editor replacement and shutdown stop their key polling', async (t) => {
  let reads = 0;
  const h = setup(t, { install: createCommitButtonExtension({ isCtrlPressed: () => { reads++; return false; } }) });
  await delay(100);
  assert.ok(reads > 0);
  h.replace();
  h.shutdown();
  const stopped = reads;
  await delay(100);
  assert.equal(reads, stopped);
});

test('narrow editors do not expose an invisible button', (t) => {
  const h = setup(t);
  h.wrapped.render(10);
  h.wrapped.handleMouse({ type: 'click', button: 'left', ctrl: true, x: 9, y: 0 });
  assert.equal(h.shutdowns, 0);
  assert.deepEqual(h.sent, []);
});

test('a failed native detector stops polling and persists the stack trace', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'commit-button-error-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  let broken = false;
  let reads = 0;
  const h = setup(t, { install: createCommitButtonExtension({ isCtrlPressed() {
    reads++;
    if (broken) throw new Error('native control probe failed');
    return true;
  } }) });
  assert.match(h.wrapped.render(80)[0], /\[ exit \]$/);
  broken = true;
  await delay(150);
  assert.match(h.wrapped.render(80)[0], /\[ commit \]$/);
  const stopped = reads;
  await delay(100);
  assert.equal(reads, stopped);
  assert.equal(h.notifications.length, 1);
  const report = await readFile(join(directory, 'logs', 'commit-button.log'), 'utf8');
  assert.match(report, /Error: native control probe failed\n\s+at /);
});

if (process.platform === 'win32' || process.platform === 'darwin') {
  test('default installation reads native Ctrl locally but not over SSH', async (t) => {
    const { getNativePlatformHelper } = await import('@earendil-works/pi-tui/dist/native-platform.js');
    const helper = getNativePlatformHelper();
    assert.equal(typeof helper?.isModifierPressed, 'function');
    const originalSsh = [process.env.SSH_CONNECTION, process.env.SSH_TTY];
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_TTY;
    t.after(() => {
      for (const [index, name] of ['SSH_CONNECTION', 'SSH_TTY'].entries()) {
        if (originalSsh[index] === undefined) delete process.env[name];
        else process.env[name] = originalSsh[index];
      }
    });
    const state = t.mock.method(helper, 'isModifierPressed', () => true);
    const local = setup(t, { install });
    assert.match(local.wrapped.render(80)[0], /\[ exit \]$/);
    assert.ok(state.mock.calls.every(call => call.arguments[0] === 'control'));
    local.shutdown();
    for (const name of ['SSH_CONNECTION', 'SSH_TTY']) {
      process.env[name] = 'test-ssh';
      const remote = setup(t, { install });
      const reads = state.mock.callCount();
      await delay(100);
      assert.match(remote.wrapped.render(80)[0], /\[ commit \]$/);
      assert.equal(state.mock.callCount(), reads);
      remote.wrapped.handleMouse({ type: 'click', button: 'left', ctrl: true, x: 79, y: 0 });
      assert.deepEqual(remote.submitted, ['/quit'], 'the client click still carries Ctrl');
      remote.shutdown();
      delete process.env[name];
    }
  });
}

test('non-TUI sessions do not install the button', () => {
  const handlers = new Map();
  install({ on: (name, handler) => handlers.set(name, handler) });
  handlers.get('session_start')({}, { mode: 'rpc' });
});
