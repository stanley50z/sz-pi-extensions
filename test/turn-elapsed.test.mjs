import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';

const moduleUrl = new URL('../extensions/turn-elapsed.ts', import.meta.url).href;

async function freshModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

function createFakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
}

function createFakeContext() {
  let widgetFactory;
  let widgetOptions;
  return {
    mode: 'tui',
    get widgetFactory() {
      return widgetFactory;
    },
    get widgetOptions() {
      return widgetOptions;
    },
    ui: {
      setWidget(_key, factory, options) {
        widgetFactory = factory;
        widgetOptions = options;
      },
    },
  };
}

const plainTheme = {
  fg(_color, text) {
    return text;
  },
};

test('shows live elapsed time since the latest user message above the editor', async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

  try {
    const { default: installTurnElapsed } = await freshModule();
    const pi = createFakePi();
    const ctx = createFakeContext();

    installTurnElapsed(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
    assert.equal(ctx.widgetOptions?.placement, 'aboveEditor');
    const widget = ctx.widgetFactory({ requestRender() {} }, plainTheme);

    now = 2_000;
    await pi.handlers.get('message_start')({
      message: { role: 'user', content: 'Please make this change', timestamp: 1_000 },
    }, ctx);
    now = 66_000;

    assert.equal(stripVTControlCharacters(widget.render(80)[0]), 'Agent turn · 1m 05s');

    await pi.handlers.get('session_shutdown')({ reason: 'quit' }, ctx);
  } finally {
    Date.now = originalNow;
  }
});

test('freezes the completed duration when the agent settles', async () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;

  try {
    const { default: installTurnElapsed } = await freshModule();
    const pi = createFakePi();
    const ctx = createFakeContext();

    installTurnElapsed(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
    const widget = ctx.widgetFactory({ requestRender() {} }, plainTheme);

    await pi.handlers.get('message_start')({
      message: { role: 'user', content: 'Run the tests', timestamp: now },
    }, ctx);
    now = 14_900;
    await pi.handlers.get('agent_settled')({}, ctx);
    now = 100_000;

    assert.match(stripVTControlCharacters(widget.render(80)[0]), /Last turn · 4s$/);

    await pi.handlers.get('session_shutdown')({ reason: 'quit' }, ctx);
  } finally {
    Date.now = originalNow;
  }
});
