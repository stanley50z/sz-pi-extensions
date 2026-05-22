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

  return {
    handlers,
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

function createFakeContext() {
  let footerFactory = null;
  return {
    get footerFactory() {
      return footerFactory;
    },
    model: { id: 'test-model' },
    sessionManager: { getBranch: () => [] },
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

const footerData = {
  onBranchChange() {
    return () => {};
  },
  getGitBranch() {
    return null;
  },
};

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
    const [line] = footer.render(120);

    assert.match(line, /\+0\s+−0/);
    assert.match(line, new RegExp(`\\x1b\\]8;;${url}\\x1b\\\\`));
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
    const [line] = footer.render(120);

    assert.match(line, /\+1\s+−1/);
    assert.match(line, new RegExp(`\\x1b\\]8;;${url}\\x1b\\\\`));
  } finally {
    process.chdir(originalCwd);
  }
});
