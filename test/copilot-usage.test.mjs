import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const payload = (credits = 4393) => ({
  token_based_billing: true,
  quota_reset_date_utc: '2026-10-01T00:00:00Z',
  quota_snapshots: { premium_interactions: {
    credits_used: credits, entitlement: 0, unlimited: true,
    percent_remaining: 100, overage_count: 0,
  } },
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authPath = join(dir, 'auth.json');
  const auth = async (credential = { type: 'oauth', refresh: 'github-secret', access: 'wrong-token' }) =>
    writeFile(authPath, JSON.stringify({ 'github-copilot': credential }));
  await auth();
  const { createCopilotUsageReader } = await import('../lib/copilot-usage.ts');
  return { authPath, auth, createCopilotUsageReader };
}

test('reads consumed monthly credits with the underlying OAuth token, without adding allowance or overage', async (t) => {
  const { authPath, createCopilotUsageReader } = await fixture(t);
  const reader = createCopilotUsageReader({ authPath, now: () => Date.UTC(2026, 8, 5),
    fetch: async (url, options) => {
      assert.equal(url, 'https://api.github.com/copilot_internal/user');
      assert.equal(options.headers.Authorization, 'Bearer github-secret');
      assert.equal(options.headers.Accept, 'application/json');
      assert.ok(options.headers['User-Agent']);
      assert.equal(options.redirect, 'error');
      return Response.json(payload());
    },
  });
  t.after(() => reader.dispose());
  assert.deepEqual(await reader.read(), { status: 'ready', usd: 43.93 });
});

test('invalid auth and response data are unavailable, valid zero is allowed, and prior cycles expire', async (t) => {
  const { authPath, auth, createCopilotUsageReader } = await fixture(t);
  let calls = 0;
  let data = payload(0);
  const read = async () => {
    const reader = createCopilotUsageReader({ authPath, now: () => Date.UTC(2026, 8, 5),
      fetch: async () => { calls++; return Response.json(data); },
    });
    try { return await reader.read(); } finally { reader.dispose(); }
  };
  assert.deepEqual(await read(), { status: 'ready', usd: 0 });
  for (const bad of [null, {}, payload(-1), payload('4393'), payload(null),
    { ...payload(), token_based_billing: false },
    { ...payload(), quota_reset_date_utc: '2026-09-01T00:00:00Z' },
    { ...payload(), quota_reset_date_utc: '2026-11-01T00:00:00Z' },
    { ...payload(), quota_reset_date_utc: undefined }]) {
    data = bad;
    assert.deepEqual(await read(), { status: 'unavailable' });
  }
  const before = calls;
  for (const credential of [null, { type: 'api_key', key: 'secret' },
    { type: 'oauth', access: 'secret' },
    { type: 'oauth', refresh: 'secret', enterpriseUrl: 'enterprise.example.com' }]) {
    await auth(credential);
    assert.deepEqual(await read(), { status: 'unavailable' });
  }
  await writeFile(authPath, 'broken secret JSON');
  assert.deepEqual(await read(), { status: 'unavailable' });
  await rm(authPath);
  assert.deepEqual(await read(), { status: 'unavailable' });
  assert.equal(calls, before);
});

test('dedupes and throttles reads, reloads changed credentials, cancels stale requests and disposes', async (t) => {
  const { authPath, auth, createCopilotUsageReader } = await fixture(t);
  let now = Date.UTC(2026, 8, 5);
  const requests = [];
  const reader = createCopilotUsageReader({ authPath, now: () => now,
    fetch: (url, options) => new Promise(resolve => requests.push({ options, resolve })),
  });
  t.after(() => reader.dispose());
  const first = reader.read();
  const duplicate = reader.read();
  assert.equal(requests.length, 1);
  requests[0].resolve(Response.json(payload()));
  assert.deepEqual(await first, { status: 'ready', usd: 43.93 });
  assert.deepEqual(await duplicate, await first);
  await reader.read();
  assert.equal(requests.length, 1);
  now += 60000;
  const stale = reader.read();
  await auth({ type: 'oauth', refresh: 'new-account' });
  const changed = reader.read();
  assert.equal(requests.length, 3);
  assert.equal(requests[1].options.signal.aborted, true);
  assert.equal(requests[2].options.headers.Authorization, 'Bearer new-account');
  requests[2].resolve(Response.json(payload(1200)));
  assert.deepEqual(await changed, { status: 'ready', usd: 12 });
  requests[1].resolve(Response.json(payload(9999)));
  assert.deepEqual(await stale, { status: 'unavailable' });
  assert.deepEqual(await reader.read(), { status: 'ready', usd: 12 });
  now = Date.UTC(2026, 9, 1);
  const oldCycle = reader.read();
  requests[3].resolve(Response.json(payload()));
  assert.deepEqual(await oldCycle, { status: 'unavailable' });
  now += 60000;
  const pending = reader.read();
  reader.dispose();
  assert.equal(requests[4].options.signal.aborted, true);
  requests[4].resolve(Response.json(payload()));
  assert.deepEqual(await pending, { status: 'unavailable' });
  assert.deepEqual(await reader.read(), { status: 'unavailable' });
  assert.equal(requests.length, 5);
});

test('transport failures and timeouts are unavailable and throttled without leaking secrets', async (t) => {
  const { authPath, createCopilotUsageReader } = await fixture(t);
  for (const fetcher of [
    () => { throw new Error('github-secret'); },
    async () => new Response('github-secret', { status: 401 }),
    async () => new Response('', { status: 302, headers: { Location: 'https://elsewhere.example' } }),
    async () => new Response('github-secret'),
    async () => ({ ok: true, json: async () => payload(Infinity) }),
    (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('github-secret')))),
  ]) {
    let calls = 0;
    let now = Date.UTC(2026, 8, 5);
    const reader = createCopilotUsageReader({ authPath, now: () => now, timeoutMs: 10,
      fetch: (...args) => { calls++; return fetcher(...args); },
    });
    t.after(() => reader.dispose());
    assert.deepEqual(await reader.read(), { status: 'unavailable' });
    assert.deepEqual(await reader.read(), { status: 'unavailable' });
    assert.equal(calls, 1);
    now += 60000;
    assert.deepEqual(await reader.read(), { status: 'unavailable' });
    assert.equal(calls, 2);
  }
});

test('auth removed during a request prevents its successful result from being used', async (t) => {
  const { authPath, createCopilotUsageReader } = await fixture(t);
  let resolve;
  const reader = createCopilotUsageReader({ authPath, now: () => Date.UTC(2026, 8, 5),
    fetch: () => new Promise(done => { resolve = done; }),
  });
  t.after(() => reader.dispose());
  const pending = reader.read();
  await rm(authPath);
  resolve(Response.json(payload()));
  assert.deepEqual(await pending, { status: 'unavailable' });
});
