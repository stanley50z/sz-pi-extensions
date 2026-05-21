import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function runPiLoadCheck() {
  return new Promise((resolve) => {
    const child = spawn('pi', [
      '--offline',
      '--no-extensions',
      '-e',
      './extensions/pi-web-access/index.ts',
      '--list-models',
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr: stderr + '\n[TIMEOUT]' });
    }, 60_000);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('pi-web-access extension loads in pi', async () => {
  const result = await runPiLoadCheck();
  assert.equal(result.code, 0, `pi failed to load extension\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /Failed to load extension|ParseError/);
  assert.match(`${result.stdout}\n${result.stderr}`, /provider\s+model/);
});
