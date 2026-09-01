import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../extensions/reload-all.ts', import.meta.url).href;

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for all Pi instances to reload');
}

function createFakePi() {
  const commands = new Map();
  const handlers = new Map();
  let context;

  return {
    commands,
    handlers,
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    sendUserMessage(message, options) {
      assert.deepEqual(options, { deliverAs: 'followUp', expandPromptTemplates: true });
      const [command, ...args] = message.slice(1).split(' ');
      queueMicrotask(() => void commands.get(command).handler(args.join(' '), context));
    },
    async start(ctx) {
      context = ctx;
      await handlers.get('session_start')({}, ctx);
    },
  };
}

function createContext() {
  const notifications = [];
  return {
    reloads: 0,
    notifications,
    async reload() {
      this.reloads += 1;
    },
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };
}

async function install(agentDir) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { default: installReloadAll } = await import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
    const pi = createFakePi();
    installReloadAll(pi);
    return pi;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test('/reload-all reloads every running Pi instance', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-reload-all-'));
  const firstPi = await install(agentDir);
  const secondPi = await install(agentDir);
  const firstContext = createContext();
  const secondContext = createContext();

  await firstPi.start(firstContext);
  await secondPi.start(secondContext);
  await firstPi.commands.get('reload-all').handler('', firstContext);

  assert.equal(firstContext.reloads, 1);
  await waitUntil(() => secondContext.reloads === 1);

  await firstPi.handlers.get('session_shutdown')?.({}, firstContext);
  await secondPi.handlers.get('session_shutdown')?.({}, secondContext);
});
