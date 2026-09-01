import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const moduleUrl = new URL("../extensions/new-session-cwd.ts", import.meta.url).href;

async function loadExtension() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

function createFakePi() {
  const commands = new Map();
  const handlers = new Map();
  const sentUserMessages = [];
  return {
    commands,
    handlers,
    sentUserMessages,
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    sendUserMessage(content, options) {
      sentUserMessages.push({ content, options });
    },
  };
}

function createTuiContext(cwd, inputs, sessionCwd = cwd) {
  const renders = [];
  const notifications = [];
  return {
    cwd,
    mode: "tui",
    renders,
    notifications,
    sessionManager: {
      getCwd: () => sessionCwd,
      getSessionFile: () => "/sessions/current.jsonl",
    },
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      async custom(factory) {
        let completed = false;
        let result;
        const theme = {
          fg: (_color, text) => text,
          bold: (text) => text,
        };
        const component = factory(
          { requestRender() { renders.push(component.render(100)); } },
          theme,
          {},
          (value) => { completed = true; result = value; },
        );
        renders.push(component.render(100));
        for (const input of inputs) component.handleInput(input);
        assert.equal(completed, true, "cwd selector did not close");
        return result;
      },
    },
  };
}

test("/new preselects the current cwd and ranks the remaining cwd choices by session recency", async () => {
  const { createNewSessionCwdExtension } = await loadExtension();
  const current = "C:\\work\\current";
  const recent = "C:\\work\\recent";
  const older = "C:\\work\\older";
  const pi = createFakePi();

  createNewSessionCwdExtension({
    listSessions: async () => [
      { cwd: older, modified: new Date("2026-04-01T12:00:00Z") },
      { cwd: recent, modified: new Date("2026-05-03T12:00:00Z") },
      { cwd: current, modified: new Date("2026-05-01T12:00:00Z") },
      { cwd: recent, modified: new Date("2026-05-02T12:00:00Z") },
    ],
    cwdExists: () => true,
    schedule: (task) => task(),
    createSessionFile: () => {
      throw new Error("selecting the current cwd should use Pi's normal new-session flow");
    },
  })(pi);

  const ctx = createTuiContext("C:\\process-cwd", ["\r"], current);
  const result = await pi.handlers.get("session_before_switch")({ reason: "new" }, ctx);

  const initial = ctx.renders[0].join("\n");
  assert.ok(initial.indexOf(current) < initial.indexOf(recent));
  assert.ok(initial.indexOf(recent) < initial.indexOf(older));
  assert.equal(initial.match(new RegExp(recent.replaceAll("\\", "\\\\"), "g"))?.length, 1);
  assert.equal(result, undefined);
  assert.deepEqual(pi.sentUserMessages, []);
});

test("/new opens the selector on Pi runtimes that expose hasUI without mode", async () => {
  const { createNewSessionCwdExtension } = await loadExtension();
  const current = "C:\\work\\current";
  const pi = createFakePi();
  createNewSessionCwdExtension({
    listSessions: async () => [],
    cwdExists: () => true,
    schedule: (task) => task(),
    createSessionFile: () => {
      throw new Error("current cwd should use the native new-session flow");
    },
  })(pi);

  const ctx = createTuiContext(current, ["\r"]);
  delete ctx.mode;
  ctx.hasUI = true;
  await pi.handlers.get("session_before_switch")({ reason: "new" }, ctx);

  assert.match(ctx.renders[0].join("\n"), /New session working directory/);
});

test("/new-cwd-switch stays internal and does not appear in slash autocomplete", async () => {
  const { createNewSessionCwdExtension } = await loadExtension();
  const pi = createFakePi();
  const autocompleteFactories = [];

  createNewSessionCwdExtension({
    listSessions: async () => [],
    cwdExists: () => true,
    schedule: (task) => task(),
    createSessionFile: () => {
      throw new Error("autocomplete should not create a session");
    },
  })(pi);

  await pi.handlers.get("session_start")({}, {
    mode: "tui",
    ui: {
      addAutocompleteProvider(factory) {
        autocompleteFactories.push(factory);
      },
    },
  });

  const baseProvider = new CombinedAutocompleteProvider([
    { name: "new", description: "Start a new session" },
    { name: "new-cwd-switch", description: "Internal cwd switch" },
  ], process.cwd());
  const provider = autocompleteFactories[0](baseProvider);
  const suggestions = await provider.getSuggestions(
    ["/new"],
    0,
    4,
    { signal: new AbortController().signal },
  );

  assert.deepEqual(suggestions.items, [{
    value: "new",
    label: "new",
    description: "Start a new session",
  }]);
  assert.equal(pi.commands.has("new-cwd-switch"), true);
});

test("a cross-cwd selection creates a readable blank session with the selected cwd", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-new-cwd-agent-"));
  const targetCwd = join(agentDir, "projects", "selected");
  mkdirSync(targetCwd, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const { createBlankSessionFile } = await loadExtension();
    const sessionFile = createBlankSessionFile(targetCwd);

    assert.equal(existsSync(sessionFile), true);
    const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).cwd, resolve(targetCwd));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("selecting a recent cwd creates a blank session there and switches to it", async () => {
  const { createNewSessionCwdExtension } = await loadExtension();
  const current = "C:\\work\\current";
  const recent = "C:\\work\\recent";
  const createdFor = [];
  const switchedTo = [];
  const replacementNotifications = [];
  const pi = createFakePi();

  createNewSessionCwdExtension({
    listSessions: async () => [
      { cwd: recent, modified: new Date("2026-05-03T12:00:00Z") },
    ],
    cwdExists: () => true,
    schedule: (task) => task(),
    createSessionFile(cwd) {
      createdFor.push(cwd);
      return "C:\\sessions\\new.jsonl";
    },
  })(pi);

  const ctx = createTuiContext(current, ["\x1b[B", "\r"]);
  const result = await pi.handlers.get("session_before_switch")({ reason: "new" }, ctx);

  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(pi.sentUserMessages, [{
    content: "/new-cwd-switch",
    options: { expandPromptTemplates: true },
  }]);
  assert.deepEqual(createdFor, []);

  await pi.commands.get("new-cwd-switch").handler("", {
    ...ctx,
    async switchSession(path, options) {
      switchedTo.push(path);
      await options.withSession({
        ui: {
          notify(message, type) {
            replacementNotifications.push({ message, type });
          },
        },
      });
      return { cancelled: false };
    },
  });

  assert.deepEqual(createdFor, [recent]);
  assert.deepEqual(switchedTo, ["C:\\sessions\\new.jsonl"]);
  assert.deepEqual(replacementNotifications, [{
    message: `New session started in ${recent}`,
    type: "info",
  }]);
});
