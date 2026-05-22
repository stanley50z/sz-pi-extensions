import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../extensions/sz-pi-footer.ts', import.meta.url).href;

async function freshFooterModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
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

async function createCleanRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'sz-pi-footer-'));
  git(['init'], dir);
  await writeFile(join(dir, 'file.txt'), 'before\n', 'utf8');
  git(['add', 'file.txt'], dir);
  git(['commit', '-m', 'initial'], dir);
  return dir;
}

async function createDirtyRepo() {
  const dir = await createCleanRepo();
  await writeFile(join(dir, 'file.txt'), 'after\n', 'utf8');
  return dir;
}

function createFakePi() {
  const handlers = new Map();
  const busHandlers = new Map();
  let thinkingLevel = 'high';

  return {
    handlers,
    setThinkingLevelForTest(level) {
      thinkingLevel = level;
    },
    getThinkingLevel() {
      return thinkingLevel;
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    events: {
      emit(channel, data) {
        for (const handler of busHandlers.get(channel) ?? []) handler(data);
      },
      on(channel, handler) {
        const list = busHandlers.get(channel) ?? [];
        list.push(handler);
        busHandlers.set(channel, list);
        return () => busHandlers.set(channel, (busHandlers.get(channel) ?? []).filter((h) => h !== handler));
      },
    },
  };
}

function createFakeContext(overrides = {}) {
  let footerFactory = null;
  const branch = overrides.branch ?? [];
  const cwd = overrides.cwd ?? '/tmp/test-project';
  const sessionName = overrides.sessionName;
  const model = overrides.model ?? { provider: 'openai', id: 'test-model', reasoning: true, contextWindow: 200000 };
  return {
    get footerFactory() {
      return footerFactory;
    },
    cwd,
    model,
    modelRegistry: { isUsingOAuth: () => Boolean(overrides.usingSubscription) },
    getContextUsage: () => overrides.contextUsage ?? { tokens: 84000, contextWindow: 200000, percent: 42 },
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
      getCwd: () => cwd,
      getSessionName: () => sessionName,
    },
    ui: {
      setFooter(factory) {
        footerFactory = factory;
      },
    },
  };
}

const plainTheme = {
  fg(_color, text) {
    return text;
  },
};

function createFooterData(branch = null, statuses = new Map(), providerCount = 1) {
  return {
    onBranchChange() {
      return () => {};
    },
    getGitBranch() {
      return branch;
    },
    getExtensionStatuses() {
      return statuses;
    },
    getAvailableProviderCount() {
      return providerCount;
    },
  };
}

const footerData = createFooterData();

test('footer preserves original lines and adds custom stats/statuses', async () => {
  const originalCwd = process.cwd();
  const originalNow = Date.now;
  const repo = await createCleanRepo();
  process.chdir(repo);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const usage = {
      input: 1200,
      output: 800,
      cacheRead: 300,
      cacheWrite: 40,
      cost: { total: 0.123 },
    };
    const ctx = createFakeContext({
      cwd: `${process.env.HOME}/work/project`,
      sessionName: 'session-a',
      usingSubscription: true,
      branch: [{ type: 'message', message: { role: 'assistant', usage } }],
    });

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
    let now = 1000;
    Date.now = () => now;
    await pi.handlers.get('turn_start')({}, ctx);
    now = 2000;
    await pi.handlers.get('turn_end')({}, ctx);

    const footer = ctx.footerFactory(
      { requestRender() {} },
      plainTheme,
      createFooterData('feature-branch', new Map([['openai-fast-mode', '⚡ fast']]), 2),
    );
    const lines = footer.render(160);

    assert.equal(lines.length, 2);
    assert.match(lines[0], /^~\/work\/project \(feature-branch\)\s+session-a\s+800 tok\/s  $/);
    assert.match(lines[1], /↑1\.2k/);
    assert.match(lines[1], /↓800/);
    assert.match(lines[1], /R300/);
    assert.match(lines[1], /W40/);
    assert.match(lines[1], /\$0\.123 \(sub\)/);
    assert.match(lines[1], /42\.0%\/200k \(auto\)/);
    assert.match(lines[1], /\+0\s+−0/);
    assert.match(lines[1], /\(openai\) test-model \(high\) ⚡ fast/);
    assert.doesNotMatch(lines[1], /tok\/s/);
    assert.equal(lines.length, 2);
  } finally {
    Date.now = originalNow;
    process.chdir(originalCwd);
  }
});

test('footer keeps last token speed visible after footer refreshes', async () => {
  const originalCwd = process.cwd();
  const originalNow = Date.now;
  const repo = await createCleanRepo();
  process.chdir(repo);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const usage = {
      input: 100,
      output: 250,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0.001 },
    };
    const ctx = createFakeContext({
      branch: [{ type: 'message', message: { role: 'assistant', usage } }],
    });

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
    let now = 1000;
    Date.now = () => now;
    await pi.handlers.get('turn_start')({}, ctx);
    now = 2000;
    await pi.handlers.get('turn_end')({}, ctx);
    await pi.handlers.get('tool_execution_end')({ toolName: 'bash' }, ctx);

    const footer = ctx.footerFactory({ requestRender() {} }, plainTheme, footerData);
    const lines = footer.render(100);

    assert.match(lines[0], /250 tok\/s  $/);
  } finally {
    Date.now = originalNow;
    process.chdir(originalCwd);
  }
});

test('footer shows zero token speed before the first assistant response', async () => {
  const originalCwd = process.cwd();
  const repo = await createCleanRepo();
  process.chdir(repo);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const ctx = createFakeContext({ sessionName: 'new-session' });

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);

    const footer = ctx.footerFactory({ requestRender() {} }, plainTheme, footerData);
    const lines = footer.render(100);

    assert.match(lines[0], /new-session\s+0 tok\/s  $/);
  } finally {
    process.chdir(originalCwd);
  }
});

test('footer keeps session name visible when path is long', async () => {
  const originalCwd = process.cwd();
  const repo = await createCleanRepo();
  process.chdir(repo);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const ctx = createFakeContext({
      cwd: `${process.env.HOME}/work/very/long/path/that/would/otherwise/push/session/name/off/screen/project`,
      sessionName: 'important-session',
    });

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);

    const footer = ctx.footerFactory({ requestRender() {} }, plainTheme, createFooterData('long-feature-branch'));
    const lines = footer.render(70);

    assert.match(lines[0], /important-session\s+0 tok\/s  $/);
  } finally {
    process.chdir(originalCwd);
  }
});

test('footer renders clickable zero diff stats in a clean git repository', async () => {
  const originalCwd = process.cwd();
  const repo = await createCleanRepo();
  process.chdir(repo);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const ctx = createFakeContext();
    const url = 'http://127.0.0.1:61589';

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
    pi.events.emit('sz-git-view:url', { url });

    const footer = ctx.footerFactory({ requestRender() {} }, plainTheme, footerData);
    const lines = footer.render(120);

    assert.match(lines[1], /\+0\s+−0/);
    assert.match(lines[1], new RegExp(`\\x1b\\]8;;${url}\\x1b\\\\`));
  } finally {
    process.chdir(originalCwd);
  }
});

test('footer git diff stats become a hyperlink to the Git View URL when it is available', async () => {
  const originalCwd = process.cwd();
  const repo = await createDirtyRepo();
  process.chdir(repo);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const ctx = createFakeContext();
    const url = 'http://127.0.0.1:61589';

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
    pi.events.emit('sz-git-view:url', { url });

    const footer = ctx.footerFactory({ requestRender() {} }, plainTheme, footerData);
    const lines = footer.render(120);

    assert.match(lines[1], /\+1\s+−1/);
    assert.match(lines[1], new RegExp(`\\x1b\\]8;;${url}\\x1b\\\\`));
  } finally {
    process.chdir(originalCwd);
  }
});
