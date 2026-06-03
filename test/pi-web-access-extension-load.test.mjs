import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function runPiLoadCheck() {
  return new Promise((resolve) => {
    const piArgs = [
      '--offline',
      '--no-extensions',
      '-e',
      './extensions/pi-web-access/index.ts',
      '--list-models',
    ];
    const useWindowsShell = process.platform === 'win32';
    const piCommand = useWindowsShell ? `pi.cmd ${piArgs.join(' ')}` : 'pi';
    const spawnArgs = useWindowsShell ? [] : piArgs;
    let stdout = '';
    let stderr = '';
    let timer;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(piCommand, spawnArgs, {
        cwd: process.cwd(),
        env: process.env,
        shell: useWindowsShell,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({ code: null, stdout, stderr: err instanceof Error ? err.message : String(err) });
      return;
    }

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stdout, stderr: stderr + '\n[TIMEOUT]' });
    }, 60_000);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      finish({ code: null, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

test('pi-web-access extension loads in pi', async () => {
  const result = await runPiLoadCheck();
  assert.equal(result.code, 0, `pi failed to load extension\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /Failed to load extension|ParseError/);
  assert.match(`${result.stdout}\n${result.stderr}`, /provider\s+model/);
});
