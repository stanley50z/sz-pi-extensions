import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

// Keep standalone HTTP/lifecycle/security coverage in the package's normal test command.
test('artifact preview service HTTP and CLI behavior', async () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const { stderr } = await promisify(execFile)(python,
    ['-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'artifact_preview_test.py'],
    { cwd: new URL('..', import.meta.url), timeout: 90_000 });
  assert.match(stderr, /OK/);
});
