import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

// Keep the cross-platform helper's HTTP and launcher regressions in the normal suite.
test('SSH clipboard helper HTTP and CLI behavior', async () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const { stderr } = await promisify(execFile)(python,
    ['-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'ssh_clipboard_test.py'],
    { cwd: new URL('..', import.meta.url), timeout: 45_000 });
  assert.match(stderr, /OK/);
});
