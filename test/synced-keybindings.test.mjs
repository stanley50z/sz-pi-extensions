import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../extensions/synced-keybindings.ts', import.meta.url).href;

async function install(agentDir) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { default: installSyncedKeybindings } = await import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
    installSyncedKeybindings({});
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test('installing the Pi package syncs Ctrl+Backspace as delete-word-backward', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-keybindings-'));

  await install(agentDir);

  const keybindings = JSON.parse(readFileSync(join(agentDir, 'keybindings.json'), 'utf8'));
  assert.deepEqual(keybindings['tui.editor.deleteWordBackward'], [
    'ctrl+backspace',
    'ctrl+w',
    'alt+backspace',
  ]);
});

test('syncing Ctrl+Backspace preserves the rest of the user keybindings', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-keybindings-'));
  const configPath = join(agentDir, 'keybindings.json');
  writeFileSync(configPath, JSON.stringify({
    'app.clear': 'ctrl+x',
    'tui.editor.deleteWordBackward': 'alt+backspace',
  }));

  await install(agentDir);

  const keybindings = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(keybindings, {
    'app.clear': 'ctrl+x',
    'tui.editor.deleteWordBackward': ['ctrl+backspace', 'alt+backspace'],
  });
});
