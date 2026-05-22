import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../extensions/sz-git-view/git-parsers.ts', import.meta.url).href;

async function freshParsersModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

test('parseGitStatus preserves the first path character for leading-space worktree statuses', async () => {
  const { parseGitStatus } = await freshParsersModule();

  const entries = parseGitStatus(' M extensions/sz-git-view/collector.ts\n M package.json\n');

  assert.deepEqual(entries, [
    { status: 'M', path: 'extensions/sz-git-view/collector.ts' },
    { status: 'M', path: 'package.json' },
  ]);
});

test('parseGitLog separates commit subject from expanded body without repeating title', async () => {
  const { parseGitLog } = await freshParsersModule();
  const record = [
    'abcd1234full',
    'abcd123',
    'Jane Dev',
    '2026-05-21T00:00:00Z',
    '2 hours ago',
    'HEAD -> main',
    'parent1 parent2',
    'docs: expand README',
    '- README.md: add public setup, configuration, tool usage, provider behavior, security, attribution, and development documentation',
  ].join('\x1f');

  const [commit] = parseGitLog(record + '\x1e');

  assert.equal(commit.message, 'docs: expand README');
  assert.equal(
    commit.body,
    '- README.md: add public setup, configuration, tool usage, provider behavior, security, attribution, and development documentation',
  );
  assert.equal(commit.isMerge, true);
});
