import assert from "node:assert/strict";
import test from "node:test";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import {
  buildWindowsProtocolCommand,
  createWindowsNotifyExtension,
} from "../extensions/windows-notify.ts";

test.beforeEach((t) => {
  const previous = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  t.after(() => {
    if (previous === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previous;
  });
});

test("notification protocol uses the windowless Windows Script Host", () => {
  assert.equal(
    buildWindowsProtocolCommand("C:\\Windows", "C:\\Pi Extensions\\windows-notify-launch.vbs"),
    '"C:\\Windows\\System32\\wscript.exe" //B //Nologo "C:\\Pi Extensions\\windows-notify-launch.vbs" "%1"',
  );
});

function setup({
  platform = "win32",
  targets = [{ windowHandle: 101, tabRuntimeId: [42, 7] }],
  terminalState = "background",
  getTerminalState = async () => terminalState,
  terminal = { setProgress() {} },
  nativeAttention = false,
} = {}) {
  const handlers = new Map();
  const notifications = [];
  const dismissedNotifications = [];
  const uiNotifications = [];
  const capturedTitles = [];
  const terminalTitles = [];
  const attentionSignals = [];
  const activationWatchers = [];
  let protocolRegistrations = 0;
  let captureIndex = 0;
  const pi = {
    getSessionName: () => "Notification work",
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  const extension = createWindowsNotifyExtension({
    platform,
    createTabMarker: () => "Pi notification target test",
    async registerProtocolHandler() {
      protocolRegistrations += 1;
    },
    createActivationUri: () => "pi-notify://focus/test-token",
    async captureTerminalWindow(title) {
      capturedTitles.push(title);
      return targets[Math.min(captureIndex++, targets.length - 1)];
    },
    getTerminalState,
    showNotification(notification, options) {
      const shown = { ...notification, ...options };
      notifications.push(shown);
      return () => dismissedNotifications.push(shown);
    },
    ...(nativeAttention ? {} : {
      setTabAttention(active) {
        attentionSignals.push(active);
      },
    }),
    watchTabActivation(target, onActive, onError) {
      activationWatchers.push({ target, onActive, onError });
      return () => {};
    },
  });
  extension(pi);
  const ctx = {
    mode: "tui",
    ui: {
      getEditorComponent: () => () => ({ render: () => [], invalidate() {} }),
      setEditorComponent(factory) { factory({ terminal }, {}, {}); },
      notify(message, type) {
        uiNotifications.push({ message, type });
      },
      setTitle(title) {
        terminalTitles.push(title);
      },
    },
  };
  return {
    handlers,
    notifications,
    dismissedNotifications,
    uiNotifications,
    capturedTitles,
    terminalTitles,
    attentionSignals,
    activationWatchers,
    get protocolRegistrations() {
      return protocolRegistrations;
    },
    ctx,
  };
}

test("captures the calling Pi tab even when another terminal tab is selected", async () => {
  const state = setup();

  await state.handlers.get("session_start")({}, state.ctx);

  assert.equal(state.protocolRegistrations, 1);
  assert.deepEqual(state.capturedTitles, ["Pi notification target test"]);
  assert.deepEqual(state.terminalTitles, ["Pi notification target test", "Pi - Notification work"]);
});

test("notification target capture restores an unprefixed title inside Herdr", async () => {
  process.env.HERDR_ENV = "1";
  const state = setup();
  await state.handlers.get("session_start")({}, state.ctx);
  assert.deepEqual(state.terminalTitles, ["Pi notification target test", "Notification work"]);
});

test("native Pi subagents do not install notification hooks", async () => {
  const state = setup();

  await state.handlers.get("session_start")({}, { ...state.ctx, mode: "print" });

  assert.equal(state.handlers.has("agent_start"), false);
  assert.equal(state.handlers.has("agent_settled"), false);
  assert.equal(state.handlers.has("ui_prompt_start"), false);
});

test("an interrupted run does not post a completion notification or request tab attention", async () => {
  const state = setup({ terminalState: "foreground-inactive" });
  const controller = new AbortController();
  await state.handlers.get("session_start")({}, state.ctx);
  await state.handlers.get("agent_start")({}, { ...state.ctx, signal: controller.signal });

  controller.abort();
  // Pi clears ctx.signal before emitting agent_settled.
  await state.handlers.get("agent_settled")({}, state.ctx);

  assert.deepEqual(state.notifications, []);
  assert.deepEqual(state.attentionSignals, []);
  assert.deepEqual(state.activationWatchers, []);
});

test("normal completion still notifies after an interrupted run", async () => {
  const state = setup();
  const interrupted = new AbortController();
  await state.handlers.get("session_start")({}, state.ctx);
  await state.handlers.get("agent_start")({}, { ...state.ctx, signal: interrupted.signal });
  interrupted.abort();
  await state.handlers.get("agent_settled")({}, state.ctx);

  const nextRun = new AbortController();
  await state.handlers.get("agent_start")({}, { ...state.ctx, signal: nextRun.signal });
  await state.handlers.get("agent_settled")({}, state.ctx);

  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].body, "Response finished");
});

test("a completed background tab posts a persistent notification without taking focus", async () => {
  const state = setup({ terminalState: "background" });
  await state.handlers.get("session_start")({}, state.ctx);
  await state.handlers.get("agent_start")({}, state.ctx);

  assert.deepEqual(state.notifications, []);

  await state.handlers.get("agent_settled")({}, state.ctx);
  assert.deepEqual(state.notifications, [{
    title: "Pi - Notification work",
    body: "Response finished",
    windowHandle: 101,
    tabRuntimeId: [42, 7],
    persistent: true,
    activationUri: "pi-notify://focus/test-token",
  }]);
  assert.deepEqual(state.attentionSignals, []);
  assert.equal(state.activationWatchers.length, 1);

  state.activationWatchers[0].onActive();
  assert.deepEqual(state.dismissedNotifications, [state.notifications[0]]);
});

test("a completed inactive tab uses a transient toast and a Terminal attention ring", async () => {
  const state = setup({ terminalState: "foreground-inactive" });
  await state.handlers.get("session_start")({}, state.ctx);
  await state.handlers.get("agent_start")({}, state.ctx);

  await state.handlers.get("agent_settled")({}, state.ctx);

  assert.deepEqual(state.notifications, [{
    title: "Pi - Notification work",
    body: "Response finished",
    windowHandle: 101,
    tabRuntimeId: [42, 7],
    persistent: false,
    activationUri: "pi-notify://focus/test-token",
  }]);
  assert.deepEqual(state.attentionSignals, [true]);
  assert.equal(state.activationWatchers.length, 1);
  assert.deepEqual(state.activationWatchers[0].target, { windowHandle: 101, tabRuntimeId: [42, 7] });

  state.activationWatchers[0].onActive();
  assert.deepEqual(state.attentionSignals, [true, false]);
});

test("a stale Windows Terminal tab target is recaptured without showing a PowerShell error", async () => {
  const state = setup({
    targets: [
      { windowHandle: 101, tabRuntimeId: [42, 7] },
      { windowHandle: 101, tabRuntimeId: [84, 9] },
    ],
  });
  await state.handlers.get("session_start")({}, state.ctx);
  await state.handlers.get("agent_start")({}, state.ctx);
  await state.handlers.get("agent_settled")({}, state.ctx);

  await state.activationWatchers[0].onError(new Error(
    "#< CLIXML ... The Pi terminal tab no longer exists ...",
  ));

  assert.deepEqual(state.capturedTitles, [
    "Pi notification target test",
    "Pi notification target test",
  ]);
  assert.deepEqual(state.notifications.at(-1), {
    title: "Pi - Notification work",
    body: "Response finished",
    windowHandle: 101,
    tabRuntimeId: [84, 9],
    persistent: true,
    activationUri: "pi-notify://focus/test-token",
  });
  assert.deepEqual(state.dismissedNotifications, [state.notifications[0]]);
  assert.deepEqual(state.uiNotifications, []);
  assert.deepEqual(state.activationWatchers.at(-1).target, {
    windowHandle: 101,
    tabRuntimeId: [84, 9],
  });
});

test("a completed active tab uses a normal transient notification", async () => {
  const state = setup({ terminalState: "foreground-active" });
  await state.handlers.get("session_start")({}, state.ctx);
  await state.handlers.get("agent_start")({}, state.ctx);

  await state.handlers.get("agent_settled")({}, state.ctx);

  assert.deepEqual(state.notifications, [{
    title: "Pi - Notification work",
    body: "Response finished",
    windowHandle: 101,
    tabRuntimeId: [42, 7],
    persistent: false,
    activationUri: "pi-notify://focus/test-token",
  }]);
  assert.deepEqual(state.attentionSignals, []);
});

test("agent input prompts use the same state-aware notification behavior", async () => {
  const state = setup();
  await state.handlers.get("session_start")({}, state.ctx);
  await state.handlers.get("agent_start")({}, state.ctx);

  await state.handlers.get("ui_prompt_start")({
    kind: "select",
    title: "Choose a database",
  }, state.ctx);

  assert.deepEqual(state.notifications, [{
    title: "Pi - Notification work",
    body: "Input needed: Choose a database",
    windowHandle: 101,
    tabRuntimeId: [42, 7],
    persistent: true,
    activationUri: "pi-notify://focus/test-token",
  }]);
});

test("a question requests the existing tab attention indicator even in the active tab", async () => {
  const state = setup({ terminalState: "foreground-active" });
  await state.handlers.get("session_start")({}, state.ctx);
  await state.handlers.get("agent_start")({}, state.ctx);

  await state.handlers.get("ui_prompt_start")({ kind: "custom" }, state.ctx);

  assert.deepEqual(state.attentionSignals, [true]);
  assert.equal(state.notifications[0].body, "Input needed");
});

test("selecting a waiting tab keeps attention until the question closes", async () => {
  const state = setup({ terminalState: "foreground-inactive" });
  await state.handlers.get("session_start")({}, state.ctx);
  await state.handlers.get("agent_start")({}, state.ctx);
  await state.handlers.get("ui_prompt_start")({ kind: "custom" }, state.ctx);

  state.activationWatchers[0].onActive();
  assert.deepEqual(state.attentionSignals, [true]);

  await state.handlers.get("ui_prompt_end")({ kind: "custom" }, state.ctx);
  assert.deepEqual(state.attentionSignals, [true, false]);
});

test("a question closed during the native state lookup does not restore stale attention", async () => {
  let resolveState;
  const state = setup({
    getTerminalState: () => new Promise((resolve) => { resolveState = resolve; }),
  });
  await state.handlers.get("session_start")({}, state.ctx);
  await state.handlers.get("agent_start")({}, state.ctx);

  const opening = state.handlers.get("ui_prompt_start")({ kind: "custom" }, state.ctx);
  await state.handlers.get("ui_prompt_end")({ kind: "custom" }, state.ctx);
  resolveState("foreground-inactive");
  await opening;

  assert.deepEqual(state.attentionSignals, [true, false]);
  assert.deepEqual(state.notifications, []);
  assert.deepEqual(state.activationWatchers, []);
});

test("the solid question ring survives Pi's busy keepalive and resumes after answering", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const sequences = [];
  t.mock.method(process.stdout, "write", (data) => { sequences.push(data); return true; });
  const terminal = new ProcessTerminal();
  const originalSetProgress = terminal.setProgress;
  const state = setup({ terminal, nativeAttention: true, terminalState: "foreground-active" });
  t.after(() => terminal.setProgress(false));
  await state.handlers.get("session_start")({}, state.ctx);
  await state.handlers.get("agent_start")({}, state.ctx);
  terminal.setProgress(true);
  t.mock.timers.tick(1000);
  assert.equal(sequences.at(-1), "\x1b]9;4;3\x07");

  await state.handlers.get("ui_prompt_start")({ kind: "custom" }, state.ctx);
  const waitingWrites = sequences.length;
  t.mock.timers.tick(3000);
  assert.equal(sequences.length, waitingWrites);
  assert.equal(sequences.at(-1), "\x1b]9;4;4;100\x07");
  terminal.setProgress(true);
  t.mock.timers.tick(2000);
  assert.equal(sequences.length, waitingWrites);

  await state.handlers.get("ui_prompt_end")({ kind: "custom" }, state.ctx);
  assert.equal(sequences.at(-1), "\x1b]9;4;3\x07");
  const resumedWrites = sequences.length;
  t.mock.timers.tick(1000);
  assert.equal(sequences.length, resumedWrites + 1);
  terminal.setProgress(false);
  await state.handlers.get("session_shutdown")({}, state.ctx);
  assert.equal(terminal.setProgress, originalSetProgress);
});

test("answering does not enable a disabled busy indicator", async (t) => {
  const sequences = [];
  t.mock.method(process.stdout, "write", (data) => { sequences.push(data); return true; });
  const terminal = new ProcessTerminal();
  const state = setup({ terminal, nativeAttention: true, terminalState: "foreground-active" });
  t.after(() => terminal.setProgress(false));
  await state.handlers.get("session_start")({}, state.ctx);
  await state.handlers.get("agent_start")({}, state.ctx);
  await state.handlers.get("ui_prompt_start")({ kind: "custom" }, state.ctx);
  await state.handlers.get("ui_prompt_end")({ kind: "custom" }, state.ctx);
  assert.equal(sequences.includes("\x1b]9;4;3\x07"), false);
  await state.handlers.get("session_shutdown")({}, state.ctx);
});

test("idle UI such as the /new selector does not trigger a notification", async () => {
  const state = setup();
  await state.handlers.get("session_start")({}, state.ctx);

  await state.handlers.get("ui_prompt_start")({
    kind: "select",
    title: "Select working directory",
  }, state.ctx);

  assert.deepEqual(state.notifications, []);
});

test("does not install terminal notification hooks outside Windows", () => {
  const state = setup({ platform: "linux" });
  assert.deepEqual([...state.handlers.keys()], []);
});
