import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../lib/codex-rate-limits.ts', import.meta.url).href;

test('reads five-hour and weekly usage from the Codex app-server protocol', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-rate-limits-'));
  const serverPath = join(dir, 'fake-codex-app-server.mjs');
  await writeFile(serverPath, `
    import readline from 'node:readline';
    const lines = readline.createInterface({ input: process.stdin });
    const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        send({ id: message.id, result: { userAgent: 'fake-codex' } });
      } else if (message.method === 'account/rateLimits/read') {
        send({
          id: message.id,
          result: {
            rateLimits: {
              primary: { usedPercent: 73, windowDurationMins: 10080 },
              secondary: { usedPercent: 12, windowDurationMins: 300 },
            },
          },
        });
      }
    });
  `, 'utf8');

  const { readCodexRateLimits } = await import(moduleUrl);
  const result = await readCodexRateLimits({
    command: process.execPath,
    args: [serverPath],
    timeoutMs: 2000,
  });

  assert.deepEqual(result.windows, [
    { usedPercent: 73, windowDurationMins: 10080 },
    { usedPercent: 12, windowDurationMins: 300 },
  ]);
});
