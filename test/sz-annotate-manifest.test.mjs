import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('chrome-extensions/sz-annotate/manifest.json', 'utf8'));

test('registers command period as the annotation toggle shortcut on macOS', () => {
  assert.equal(manifest.commands['toggle-annotation'].suggested_key.mac, 'Command+Period');
  assert.equal(manifest.commands['toggle-annotation'].suggested_key.default, 'Ctrl+Period');
  assert.equal(manifest.commands['toggle-annotation'].description, 'Toggle annotation mode');
});
