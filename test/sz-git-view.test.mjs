import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../extensions/sz-git-view/index.ts', import.meta.url).href;
const collectorModuleUrl = new URL('../extensions/sz-git-view/collector.ts', import.meta.url).href;

async function freshGitViewModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

async function freshCollectorModule() {
  return import(`${collectorModuleUrl}?t=${Date.now()}-${Math.random()}`);
}

function git(args, cwd) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

async function createRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'sz-git-view-'));
  git(['init'], dir);
  await writeFile(join(dir, 'changed.txt'), 'one\ntwo\nthree\n', 'utf8');
  git(['add', 'changed.txt'], dir);
  git(['commit', '-m', 'initial'], dir);
  return dir;
}

function createFakePi() {
  const handlers = new Map();
  const eventMessages = [];
  return {
    handlers,
    eventMessages,
    on(event, handler) {
      handlers.set(event, handler);
    },
    events: {
      emit(channel, data) {
        eventMessages.push({ channel, data });
      },
    },
  };
}

test('Git Diff Viewer reports added and deleted lines for each changed file', async () => {
  const repo = await createRepo();
  await writeFile(join(repo, 'changed.txt'), 'one\nupdated\nnew\n', 'utf8');

  const { collectDiffSummary } = await freshCollectorModule();
  const summary = await collectDiffSummary(repo);

  assert.deepEqual(summary, {
    added: 2,
    deleted: 2,
    files: [{ path: 'changed.txt', added: 2, deleted: 2 }],
  });
});

test('Git Diff Viewer includes untracked files as added lines', async () => {
  const repo = await createRepo();
  await writeFile(join(repo, 'new-file.txt'), 'first\nsecond\n', 'utf8');

  const { collectDiffSummary } = await freshCollectorModule();
  const summary = await collectDiffSummary(repo);

  assert.deepEqual(summary, {
    added: 2,
    deleted: 0,
    files: [{ path: 'new-file.txt', added: 2, deleted: 0 }],
  });
});

test('Git Diff Viewer works before a repository has its first commit', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'sz-git-view-new-repo-'));
  git(['init'], repo);
  await writeFile(join(repo, 'first.txt'), 'first\nsecond\n', 'utf8');
  git(['add', 'first.txt'], repo);

  const { collectDiffSummary } = await freshCollectorModule();
  const summary = await collectDiffSummary(repo);

  assert.deepEqual(summary, {
    added: 2,
    deleted: 0,
    files: [{ path: 'first.txt', added: 2, deleted: 0 }],
  });
});

test('an idle session clears its diff after another process commits in the same directory', async (t) => {
  const repo = await createRepo();
  const { default: installGitViewExtension } = await freshGitViewModule();
  const pi = createFakePi();
  const ctx = { mode: 'tui', cwd: repo, sessionManager: { getCwd: () => repo } };
  installGitViewExtension(pi);
  t.after(async () => {
    await pi.handlers.get('session_shutdown')({}, ctx);
    await rm(repo, { recursive: true, force: true });
  });
  await writeFile(join(repo, 'changed.txt'), 'updated\n', 'utf8');
  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
  assert.equal(pi.eventMessages.at(-1).data.summary.added, 1);

  // This Git process sends no tool or turn events to the observing session.
  git(['add', 'changed.txt'], repo);
  git(['commit', '-m', 'committed in another session'], repo);
  const deadline = Date.now() + 4000;
  while (pi.eventMessages.at(-1).data.summary.files.length && Date.now() < deadline) {
    await delay(50);
  }
  assert.deepEqual(pi.eventMessages.at(-1).data.summary, { added: 0, deleted: 0, files: [] });

  // Polling also sees external edits and untracked files, without redrawing unchanged data.
  const eventCount = pi.eventMessages.length;
  await delay(1400);
  assert.equal(pi.eventMessages.length, eventCount);
  await writeFile(join(repo, 'changed.txt'), 'updated\nanother\n', 'utf8');
  await writeFile(join(repo, 'new.txt'), 'new\n', 'utf8');
  const editDeadline = Date.now() + 4000;
  while (pi.eventMessages.at(-1).data.summary.added !== 2 && Date.now() < editDeadline) {
    await delay(50);
  }
  assert.deepEqual(pi.eventMessages.at(-1).data.summary, {
    added: 2, deleted: 0,
    files: [
      { path: 'changed.txt', added: 1, deleted: 0 },
      { path: 'new.txt', added: 1, deleted: 0 },
    ],
  });
  await pi.handlers.get('session_shutdown')({}, ctx);
  const shutdownEventCount = pi.eventMessages.length;
  await delay(1200);
  assert.equal(pi.eventMessages.length, shutdownEventCount);
  assert.equal(pi.eventMessages.at(-1).data.summary, null);
});

test('shutdown discards an in-flight Git scan instead of republishing stale footer data', async (t) => {
  const repo = await createRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { default: installGitViewExtension } = await freshGitViewModule();
  const pi = createFakePi();
  installGitViewExtension(pi);
  const ctx = { mode: 'tui', cwd: repo, sessionManager: { getCwd: () => repo } };
  const starting = pi.handlers.get('session_start')({}, ctx);
  const shutdown = pi.handlers.get('session_shutdown')({}, ctx);
  await Promise.all([starting, shutdown]);
  assert.deepEqual(pi.eventMessages, [{ channel: 'sz-git-view:update', data: { summary: null } }]);
});

test('Git Diff Viewer publishes TUI diff data at session startup without a localhost URL', async () => {
  const repo = await createRepo();
  await writeFile(join(repo, 'changed.txt'), 'updated\n', 'utf8');
  const { default: installGitViewExtension } = await freshGitViewModule();
  const pi = createFakePi();
  const ctx = { cwd: repo, sessionManager: { getCwd: () => repo } };

  await installGitViewExtension(pi);
  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);

  assert.deepEqual(pi.eventMessages.map(({ channel }) => channel), ['sz-git-view:update']);
  assert.deepEqual(pi.eventMessages[0].data.summary, {
    added: 1,
    deleted: 3,
    files: [{ path: 'changed.txt', added: 1, deleted: 3 }],
  });
});
