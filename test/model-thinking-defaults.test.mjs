import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../extensions/model-thinking-defaults.ts', import.meta.url).href;

async function freshModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

function createFakePi() {
  const handlers = new Map();
  const selectedLevels = [];
  return {
    handlers,
    selectedLevels,
    on(event, handler) {
      handlers.set(event, handler);
    },
    setThinkingLevel(level) {
      selectedLevels.push(level);
    },
  };
}

function model(provider, id) {
  return { provider, id };
}

async function install() {
  const { default: installDefaults } = await freshModule();
  const pi = createFakePi();
  installDefaults(pi);
  return pi;
}

test('Luna starts with max thinking effort', async () => {
  const pi = await install();

  await pi.handlers.get('session_start')({}, { model: model('openai-codex', 'gpt-5.6-luna') });

  assert.deepEqual(pi.selectedLevels, ['max']);
});

test('DeepSeek gets max thinking effort when selected', async () => {
  const pi = await install();

  await pi.handlers.get('model_select')({
    model: model('deepseek', 'deepseek-v4-pro'),
    previousModel: model('openai-codex', 'gpt-5.6-sol'),
    source: 'cycle',
  }, { model: model('deepseek', 'deepseek-v4-pro') });

  assert.deepEqual(pi.selectedLevels, ['max']);
});

test('5.6 Sol starts with high thinking effort', async () => {
  const pi = await install();

  await pi.handlers.get('session_start')({}, { model: model('openai-codex', 'gpt-5.6-sol') });

  assert.deepEqual(pi.selectedLevels, ['high']);
});

test('Claude Fable 5 gets high thinking effort when selected', async () => {
  const pi = await install();

  await pi.handlers.get('model_select')({
    model: model('github-copilot', 'claude-fable-5'),
    previousModel: model('openai-codex', 'gpt-5.6-luna'),
    source: 'set',
  }, { model: model('github-copilot', 'claude-fable-5') });

  assert.deepEqual(pi.selectedLevels, ['high']);
});

test('unconfigured models are left unchanged', async () => {
  const pi = await install();

  await pi.handlers.get('model_select')({
    model: model('openai-codex', 'gpt-5.6-terra'),
    previousModel: model('openai-codex', 'gpt-5.6-luna'),
    source: 'set',
  }, { model: model('openai-codex', 'gpt-5.6-terra') });

  assert.deepEqual(pi.selectedLevels, []);
});
