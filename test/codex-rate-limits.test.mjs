import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../lib/codex-rate-limits.ts', import.meta.url).href;

test('reads five-hour and weekly usage from the Codex app-server protocol', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-rate-limits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
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

test('recovers usage when the Codex login expires by refreshing through app-server', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-rate-limits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const serverPath = join(dir, 'expired-login.mjs');
  await writeFile(serverPath, `
    import readline from 'node:readline';
    let refreshed = false;
    const lines = readline.createInterface({ input: process.stdin });
    const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
    lines.on('line', (line) => {
      const { id, method, params } = JSON.parse(line);
      if (method === 'initialize') send({ id, result: {} });
      else if (method === 'account/read' && params?.refreshToken === true) {
        refreshed = true;
        send({ id, result: { account: { type: 'chatgpt' } } });
      } else if (method === 'account/rateLimits/read') {
        if (!refreshed) send({ id, error: { code: -32000,
          message: 'failed to fetch codex rate limits: 401 Unauthorized; body={"error":{"code":"token_expired","message":"Your authentication token has expired. Please try refreshing it."}}',
        } });
        else send({ id, result: { rateLimits: {
          primary: { usedPercent: 5, windowDurationMins: 10080 }, secondary: null,
        } } });
      }
    });
  `, 'utf8');
  const { readCodexRateLimits } = await import(moduleUrl);
  assert.deepEqual(await readCodexRateLimits({
    command: process.execPath, args: [serverPath], timeoutMs: 2000,
  }), { windows: [{ usedPercent: 5, windowDurationMins: 10080 }] });
});

for (const scenario of [
  { name: 'does not refresh for unrelated failures', firstError: '503 Service Unavailable; private-upstream-body', expectedError: '503 Service Unavailable; private-upstream-body',
    methods: ['initialize', 'initialized', 'account/rateLimits/read'] },
  { name: 'stops if refreshing requires a new login', firstError: '401 token_expired', refreshError: 'Please log in again', expectedError: 'Please log in again',
    methods: ['initialize', 'initialized', 'account/rateLimits/read', 'account/read'] },
  { name: 'does not loop when the refreshed token is still rejected', firstError: '401 token_expired', expectedError: '401 token_expired',
    methods: ['initialize', 'initialized', 'account/rateLimits/read', 'account/read', 'account/rateLimits/read'] },
]) {
  test(scenario.name, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-rate-limits-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    t.after(() => {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    });
    const serverPath = join(dir, 'failed-usage.mjs');
    const tracePath = join(dir, 'requests.jsonl');
    await writeFile(serverPath, `
      import readline from 'node:readline';
      import { appendFileSync } from 'node:fs';
      const scenario = ${JSON.stringify(scenario)};
      const lines = readline.createInterface({ input: process.stdin });
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      lines.on('line', (line) => {
        const { id, method } = JSON.parse(line);
        appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(method) + '\\n');
        if (method === 'initialize') send({ id, result: {} });
        else if (method === 'account/read' && !scenario.refreshError) send({ id, result: {} });
        else if (method !== 'initialized') send({ id, error: { code: -32000,
          message: method === 'account/read' ? scenario.refreshError : scenario.firstError,
        } });
      });
    `, 'utf8');
    const { readCodexRateLimits } = await import(moduleUrl);
    await assert.rejects(readCodexRateLimits({
      command: process.execPath, args: [serverPath], timeoutMs: 2000,
    }), { message: scenario.expectedError });
    const methods = (await readFile(tracePath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(methods, scenario.methods);
    const report = await readFile(join(dir, 'logs', 'codex-rate-limits.log'), 'utf8');
    assert.match(report, /Codex usage lookup failed during account\//);
    assert.match(report, /at /);
    assert.doesNotMatch(report, /private-upstream-body|Please log in again/);
  });
}
