import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Exercise the registered command, mocking only Pi and the process boundary.
async function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-reopen-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sessionFile = join(directory, "conversation.jsonl");
  writeFileSync(sessionFile, '{"type":"session"}\n');
  const commands = new Map();
  const events = new Map();
  const notifications = [];
  const launches = [];
  let shutdowns = 0;
  let exitHandler;
  const originalExitCode = process.exitCode;
  t.after(() => { process.exitCode = originalExitCode; });
  const originalOnce = process.once;
  t.mock.method(process, "once", function (event, handler) {
    if (event === "exit") { exitHandler = handler; return this; }
    return originalOnce.call(this, event, handler);
  });
  t.mock.method(childProcess, "spawnSync", (...args) => {
    launches.push(args);
    return { status: 0, signal: null };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { default: install } = await import("../extensions/reopen.ts");
  install({
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => events.set(name, handler),
  });
  const ctx = {
    mode: "tui",
    cwd: directory,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionFile: () => sessionFile },
    model: { provider: "example", id: "current-model" },
    thinkingLevel: "low",
    ui: { notify: (message, type) => notifications.push({ message, type }) },
    shutdown: () => { shutdowns++; },
    ...overrides,
  };
  return { commands, events, ctx, notifications, launches, sessionFile,
    shutdowns: () => shutdowns, exit: (code) => exitHandler?.(code) };
}

test("/reopen gracefully shuts down before launching Pi in the same terminal with this session", async (t) => {
  const h = await setup(t);
  assert.ok(h.commands.has("reopen"));
  await h.commands.get("reopen").handler("", h.ctx);
  assert.equal(h.shutdowns(), 1);
  assert.equal(h.launches.length, 0);
  await h.events.get("session_shutdown")({ reason: "quit" }, h.ctx);
  assert.equal(h.launches.length, 0, "other extensions must finish cleanup first");
  h.exit(0);
  assert.equal(h.launches.length, 1);
  const [executable, args, options] = h.launches[0];
  assert.equal(executable, process.execPath);
  assert.deepEqual(args, [process.argv[1], "--session", h.sessionFile,
    "--provider", "example", "--model", "current-model", "--thinking", "low"]);
  assert.equal(options.cwd, h.ctx.cwd);
  assert.equal(options.stdio, "inherit");
  assert.notEqual(options.shell, true);
});

test("/reopen lets Pi restore the saved model when none is currently selected", async (t) => {
  const h = await setup(t, { model: undefined, thinkingLevel: undefined });
  await h.commands.get("reopen").handler("", h.ctx);
  await h.events.get("session_shutdown")({ reason: "quit" }, h.ctx);
  h.exit(0);
  assert.deepEqual(h.launches[0][1], [process.argv[1], "--session", h.sessionFile]);
});

test("/reopen retains launch options without replaying prompts, attachments, forks, or old session/model selections", async (t) => {
  const originalArgv = process.argv;
  process.argv = [process.execPath, originalArgv[1],
    "--offline", "--no-extensions", "-e", "./extensions/reopen.ts", "--no-approve",
    "--system-prompt", "A custom system prompt", "--plan",
    "--session", "old.jsonl", "--fork", "source.jsonl", "--name", "old name",
    "--provider", "old-provider", "--model", "old-model", "--thinking", "high",
    "@attachment.png", "Do not repeat me", "--", "--offline"];
  t.after(() => { process.argv = originalArgv; });
  const h = await setup(t);
  await h.commands.get("reopen").handler("", h.ctx);
  await h.events.get("session_shutdown")({ reason: "quit" }, h.ctx);
  h.exit(0);
  assert.deepEqual(h.launches[0][1], [originalArgv[1],
    "--offline", "--no-extensions", "-e", join(process.cwd(), "extensions/reopen.ts"), "--no-approve",
    "--system-prompt", "A custom system prompt", "--plan",
    "--session", h.sessionFile, "--provider", "example", "--model", "current-model", "--thinking", "low"]);
});

test("/reopen does not restart on reload, session replacement, or an abnormal exit", async (t) => {
  for (const [reason, code] of [["reload", 0], ["new", 0], ["resume", 0], ["fork", 0], ["quit", 1]]) {
    await t.test(`${reason}, exit ${code}`, async (t) => {
      const h = await setup(t);
      await h.commands.get("reopen").handler("", h.ctx);
      await h.events.get("session_shutdown")({ reason }, h.ctx);
      h.exit(code);
      assert.equal(h.launches.length, 0);
    });
  }
});

test("/reopen reports a failed process launch and exits unsuccessfully", async (t) => {
  const h = await setup(t);
  t.mock.method(childProcess, "spawnSync", () => ({ error: new Error("spawn failed") }));
  syncBuiltinESMExports();
  const error = t.mock.method(console, "error", () => {});
  await h.commands.get("reopen").handler("", h.ctx);
  await h.events.get("session_shutdown")({ reason: "quit" }, h.ctx);
  h.exit(0);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(error.mock.calls[0].arguments, ["Could not reopen Pi: spawn failed"]);
});

test("/reopen refuses unsafe contexts without shutting down", async (t) => {
  for (const [name, overrides] of [
    ["RPC", { mode: "rpc" }],
    ["active turn", { isIdle: () => false }],
    ["queued messages", { hasPendingMessages: () => true }],
    ["ephemeral session", { sessionManager: { getSessionFile: () => undefined } }],
    ["not persisted yet", { sessionManager: { getSessionFile: () => join(tmpdir(), "pi-reopen-does-not-exist.jsonl") } }],
  ]) {
    await t.test(name, async (t) => {
      const h = await setup(t, overrides);
      await h.commands.get("reopen").handler("", h.ctx);
      assert.equal(h.shutdowns(), 0);
      assert.equal(h.notifications.length, 1);
      assert.equal(h.notifications[0].type, "error");
      assert.equal(h.launches.length, 0);
    });
  }
});
