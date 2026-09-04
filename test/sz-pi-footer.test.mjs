import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';

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
  underline(text) {
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
      cwd: repo,
      sessionName: 'session-a',
      usingSubscription: true,
      branch: [{ type: 'message', message: { role: 'assistant', usage } }],
    });

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
    pi.events.emit('sz-git-view:update', { summary: { added: 0, deleted: 0, files: [] } });
    let now = 1000;
    Date.now = () => now;
    await pi.handlers.get('turn_start')({}, ctx);
    now = 2000;
    await pi.handlers.get('turn_end')({
      message: { role: 'assistant', usage },
    }, ctx);

    const footer = ctx.footerFactory(
      { requestRender() {} },
      plainTheme,
      createFooterData('feature-branch', new Map([['openai-fast-mode', '⚡fast']]), 2),
    );
    const lines = footer.render(160);

    assert.equal(lines.length, 2);
    assert.match(lines[0], /sz-pi-footer-[^ ]+ \(feature-branch\)\s+session-a\s+800 tok\/s$/);
    assert.match(lines[1], /↑1\.2k/);
    assert.match(lines[1], /↓800/);
    assert.match(lines[1], /R300/);
    assert.match(lines[1], /W40/);
    assert.match(lines[1], /\$0\.123/);
    assert.doesNotMatch(lines[1], /\(sub\)/);
    assert.match(lines[1], /ctx:42%/);
    assert.doesNotMatch(lines[1], /200k|\(auto\)|42\.0%/);
    assert.match(lines[1], /\+0\s+−0/);
    assert.match(lines[1], /\(openai\) test-model @high ⚡fast/);
    assert.doesNotMatch(lines[1], /tok\/s/);
    assert.equal(lines.length, 2);
  } finally {
    Date.now = originalNow;
    process.chdir(originalCwd);
  }
});

test('footer uses compact OpenAI model, reasoning, and fast-mode labels', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'sz-pi-footer-no-git-'));
  process.chdir(dir);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const ctx = createFakeContext({
      usingSubscription: false,
      model: {
        provider: 'openai-codex',
        id: 'gpt-5.6-sol',
        reasoning: true,
        contextWindow: 272000,
      },
    });

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);

    const footer = ctx.footerFactory(
      { requestRender() {} },
      plainTheme,
      createFooterData(null, new Map([['openai-fast-mode', '⚡fast']]), 2),
    );
    const lines = footer.render(120);

    assert.match(lines[1], /\(OpenAI\) 5\.6 Sol @high ⚡fast/);
    assert.doesNotMatch(lines[1], /openai-codex|gpt-5\.6-sol|\(high\)|⚡ fast/);
    assert.equal(visibleWidth(lines[1]), 120);
    assert.match(stripVTControlCharacters(lines[1]), /⚡fast$/);
  } finally {
    process.chdir(originalCwd);
  }
});

test('footer uses the compact OpenAI Luna model label', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'sz-pi-footer-no-git-'));
  process.chdir(dir);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const ctx = createFakeContext({
      usingSubscription: false,
      model: {
        provider: 'openai-codex',
        id: 'gpt-5.6-luna',
        reasoning: true,
        contextWindow: 272000,
      },
    });

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);

    const footer = ctx.footerFactory(
      { requestRender() {} },
      plainTheme,
      createFooterData(null, new Map([['openai-fast-mode', '⚡fast']]), 2),
    );
    const lines = footer.render(120);

    assert.match(lines[1], /\(OpenAI\) 5\.6 Luna @high ⚡fast/);
    assert.doesNotMatch(lines[1], /openai-codex|gpt-5\.6-luna|\(high\)|⚡ fast/);
    assert.equal(visibleWidth(lines[1]), 120);
    assert.match(stripVTControlCharacters(lines[1]), /⚡fast$/);
  } finally {
    process.chdir(originalCwd);
  }
});

test('footer shows API billing with a three-significant-figure cost', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'sz-pi-footer-no-git-'));
  process.chdir(dir);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const usage = {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0.001234 },
    };
    const ctx = createFakeContext({
      usingSubscription: false,
      branch: [{ type: 'message', message: { role: 'assistant', usage } }],
    });

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);

    const footer = ctx.footerFactory({ requestRender() {} }, plainTheme, footerData);
    const lines = footer.render(120);

    assert.match(lines[1], /\$0\.00123/);
    assert.match(lines[1], /\sAPI\s/);
    assert.doesNotMatch(lines[1], /5h:|wk:/);
  } finally {
    process.chdir(originalCwd);
  }
});

test('footer centers five-hour and weekly ChatGPT subscription usage', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'sz-pi-footer-no-git-'));
  process.chdir(dir);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const ctx = createFakeContext({ usingSubscription: true });

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
    pi.events.emit('sz-codex-rate-limits:update', {
      windows: [{ usedPercent: 1, windowDurationMins: 10080 }],
    });

    const footer = ctx.footerFactory({ requestRender() {} }, plainTheme, footerData);
    const lines = footer.render(120);

    assert.match(lines[1], /5h:— wk:1%/);
  } finally {
    process.chdir(originalCwd);
  }
});

test('footer updates token speed while the assistant response is streaming', async () => {
  const originalCwd = process.cwd();
  const originalNow = Date.now;
  const repo = await createCleanRepo();
  process.chdir(repo);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const ctx = createFakeContext();
    let renderRequests = 0;

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
    const footer = ctx.footerFactory(
      { requestRender() { renderRequests++; } },
      plainTheme,
      footerData,
    );

    let now = 1000;
    Date.now = () => now;
    await pi.handlers.get('message_start')({
      message: { role: 'assistant', content: [], usage: { output: 0 } },
    }, ctx);
    now = 2000;
    await pi.handlers.get('message_update')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'a'.repeat(400) }],
        usage: { output: 120 },
      },
      assistantMessageEvent: { type: 'text_delta', delta: 'a'.repeat(400) },
    }, ctx);

    assert.match(footer.render(100)[0], /120 tok\/s$/);
    assert.ok(renderRequests >= 1);
  } finally {
    Date.now = originalNow;
    process.chdir(originalCwd);
  }
});

test('footer finalizes token speed from reported usage and generation time', async () => {
  const originalCwd = process.cwd();
  const originalNow = Date.now;
  const repo = await createCleanRepo();
  process.chdir(repo);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const ctx = createFakeContext();

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
    const footer = ctx.footerFactory({ requestRender() {} }, plainTheme, footerData);

    let now = 1000;
    Date.now = () => now;
    await pi.handlers.get('turn_start')({}, ctx);
    now = 5000;
    await pi.handlers.get('message_start')({
      message: { role: 'assistant', content: [], usage: { output: 0 } },
    }, ctx);
    now = 7000;
    await pi.handlers.get('message_end')({
      message: { role: 'assistant', content: [], usage: { output: 300 } },
    }, ctx);

    assert.match(footer.render(100)[0], /150 tok\/s$/);
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
    await pi.handlers.get('turn_end')({
      message: { role: 'assistant', usage },
    }, ctx);
    await pi.handlers.get('tool_execution_end')({ toolName: 'bash' }, ctx);

    const footer = ctx.footerFactory({ requestRender() {} }, plainTheme, footerData);
    const lines = footer.render(100);

    assert.match(lines[0], /250 tok\/s$/);
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

    assert.match(lines[0], /new-session\s+0 tok\/s$/);
  } finally {
    process.chdir(originalCwd);
  }
});

test('footer adds a short third line only while subagents are running', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'sz-pi-footer-subagents-'));
  process.chdir(dir);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const ctx = createFakeContext();

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
    const footer = ctx.footerFactory({ requestRender() {} }, plainTheme, footerData);

    assert.equal(footer.render(100).length, 2);

    pi.events.emit('sz-subagents:running', {
      subagents: [{ id: 'sa-1', name: 'turn-delivery-research' }],
    });
    assert.equal(
      footer.render(100)[2],
      '1 subagent running · turn-delivery-research',
    );

    pi.events.emit('sz-subagents:running', {
      subagents: [
        { id: 'sa-1', name: 'turn-delivery-research' },
        { id: 'sa-2', name: 'api-review' },
      ],
    });
    const runningLines = footer.render(100);
    assert.equal(runningLines.length, 3);
    assert.equal(runningLines[2], '2 subagents running · turn-delivery-research, api-review');

    pi.events.emit('sz-subagents:running', { subagents: [] });
    assert.equal(footer.render(100).length, 2);
  } finally {
    process.chdir(originalCwd);
  }
});

test('short cwd keeps the session name centered', async () => {
  const originalCwd = process.cwd();
  const repo = await createCleanRepo();
  process.chdir(repo);

  try {
    const { default: installFooterExtension } = await freshFooterModule();
    const pi = createFakePi();
    const ctx = createFakeContext({
      cwd: process.env.HOME,
      sessionName: 'centered-session',
    });

    installFooterExtension(pi);
    await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);

    const footer = ctx.footerFactory({ requestRender() {} }, plainTheme, footerData);
    const lines = footer.render(80);

    assert.equal(stripVTControlCharacters(lines[0]).indexOf('centered-session'), 32);
    assert.match(lines[0], /0 tok\/s$/);
  } finally {
    process.chdir(originalCwd);
  }
});

test('long cwd and branch push the session name right instead of forcing it to center', async () => {
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
    const lines = footer.render(80);

    assert.match(lines[0], /important-session\s+0 tok\/s$/);
    assert.equal(stripVTControlCharacters(lines[0]).indexOf('important-session'), 54);
  } finally {
    process.chdir(originalCwd);
  }
});

test('footer shows Git diff totals supplied by the TUI viewer', async () => {
  const { default: installFooterExtension } = await freshFooterModule();
  const pi = createFakePi();
  const ctx = createFakeContext();

  installFooterExtension(pi);
  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
  pi.events.emit('sz-git-view:update', {
    summary: { added: 8, deleted: 3, files: [{ path: 'changed.txt', added: 8, deleted: 3 }] },
  });

  const footer = ctx.footerFactory({ requestRender() {} }, plainTheme, footerData);
  const lines = footer.render(120);

  assert.match(lines[1], /\+8\s+−3/);
  assert.equal(lines.length, 2);
});

test('footer hides Git changes outside a repository', async () => {
  const { default: installFooterExtension } = await freshFooterModule();
  const pi = createFakePi();
  const ctx = createFakeContext();

  installFooterExtension(pi);
  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
  pi.events.emit('sz-git-view:update', { summary: null });

  const footer = ctx.footerFactory({ requestRender() {} }, plainTheme, footerData);
  assert.doesNotMatch(footer.render(120)[1], /\+\d+\s+−\d+/);
});

test('clicking Git diff totals expands the five most changed files and clicking again collapses them', async () => {
  const { default: installFooterExtension } = await freshFooterModule();
  const pi = createFakePi();
  const ctx = createFakeContext();
  let renderRequests = 0;

  installFooterExtension(pi);
  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
  pi.events.emit('sz-git-view:update', {
    summary: {
      added: 29,
      deleted: 18,
      files: [
        { path: 'sixth.txt', added: 3, deleted: 2 },
        { path: 'third.txt', added: 8, deleted: 0 },
        { path: 'largest.txt', added: 10, deleted: 2 },
        { path: 'fifth.txt', added: 6, deleted: 0 },
        { path: 'second.txt', added: 5, deleted: 4 },
        { path: 'fourth.txt', added: 4, deleted: 3 },
      ],
    },
  });

  const footer = ctx.footerFactory(
    { requestRender() { renderRequests++; } },
    plainTheme,
    footerData,
  );
  const collapsed = footer.render(120);
  const diffX = stripVTControlCharacters(collapsed[1]).indexOf('+29');
  assert.ok(diffX >= 0);

  footer.handleMouse({
    type: 'click', button: 'left', x: diffX, y: 1,
    screenX: diffX, screenY: 1, width: 120, height: 2,
    shift: false, alt: false, ctrl: false, clickCount: 1,
  });

  const expanded = footer.render(120).map(stripVTControlCharacters);
  assert.deepEqual(
    expanded.slice(2).map((line) => line.trim()),
    [
      'largest.txt  +10 -2',
      'second.txt  +5 -4',
      'third.txt  +8 -0',
      'fourth.txt  +4 -3',
      'fifth.txt  +6 -0',
    ],
  );
  assert.doesNotMatch(expanded.join('\n'), /sixth\.txt/);
  assert.equal(renderRequests, 1);

  footer.handleMouse({
    type: 'click', button: 'left', x: diffX, y: 1,
    screenX: diffX, screenY: 1, width: 120, height: 7,
    shift: false, alt: false, ctrl: false, clickCount: 1,
  });
  assert.equal(footer.render(120).length, 2);
  assert.equal(renderRequests, 2);
});
