import test from 'node:test';
import assert from 'node:assert/strict';

const { readClaudeRateLimits } = await import('../lib/claude-rate-limits.ts');

function fakeQuery(usage) {
  const calls = { usageOptions: null, closed: false };
  const query = () => ({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options) {
      calls.usageOptions = options;
      return usage;
    },
    close() {
      calls.closed = true;
    },
  });
  return { query, calls };
}

test('reads five-hour and weekly plan usage from the Claude Code usage request', async () => {
  const { query, calls } = fakeQuery(Promise.resolve({
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12, resets_at: '2026-10-06T21:50:00+00:00' },
      seven_day: { utilization: 34.4, resets_at: '2026-10-10T23:00:00+00:00' },
      seven_day_opus: { utilization: 99, resets_at: null },
    },
  }));

  const result = await readClaudeRateLimits({ query });

  assert.deepEqual(result, {
    windows: [
      { usedPercent: 12, windowDurationMins: 300 },
      { usedPercent: 34.4, windowDurationMins: 10080 },
    ],
  });
  assert.deepEqual(calls.usageOptions, { skipBehaviors: true });
  assert.equal(calls.closed, true);
});

test('reads Fable allowance separately from the overall weekly usage', async () => {
  const { query } = fakeQuery(Promise.resolve({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12, resets_at: null },
      seven_day: { utilization: 34, resets_at: null },
      model_scoped: [
        { display_name: 'Other', utilization: 99, resets_at: null },
        { display_name: 'Fable', utilization: 56.7, resets_at: null },
      ],
    },
  }));

  assert.deepEqual(await readClaudeRateLimits({ query }), {
    windows: [
      { usedPercent: 12, windowDurationMins: 300 },
      { usedPercent: 34, windowDurationMins: 10080 },
    ],
    fableUsedPercent: 56.7,
  });
});

test('omits a plan window that reports no utilization', async () => {
  const { query } = fakeQuery(Promise.resolve({
    rate_limits_available: true,
    rate_limits: { five_hour: null, seven_day: { utilization: 7, resets_at: null } },
  }));

  assert.deepEqual(await readClaudeRateLimits({ query }), {
    windows: [{ usedPercent: 7, windowDurationMins: 10080 }],
  });
});

test('resolves to null when Claude Code is not billed through a plan', async () => {
  const { query, calls } = fakeQuery(Promise.resolve({
    subscription_type: null,
    rate_limits_available: false,
    rate_limits: null,
  }));

  assert.equal(await readClaudeRateLimits({ query }), null);
  assert.equal(calls.closed, true);
});

test('times out and closes Claude Code when the usage request never answers', async () => {
  const { query, calls } = fakeQuery(new Promise(() => {}));

  await assert.rejects(readClaudeRateLimits({ query, timeoutMs: 20 }), /timed out/);
  assert.equal(calls.closed, true);
});
