import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWindowsProtocolCommand,
  createWindowsNotifyExtension,
} from "../extensions/windows-notify.ts";

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
    async getTerminalState() {
      return terminalState;
    },
    showNotification(notification, options) {
      const shown = { ...notification, ...options };
      notifications.push(shown);
      return () => dismissedNotifications.push(shown);
    },
    setTabAttention(active) {
      attentionSignals.push(active);
    },
    watchTabActivation(target, onActive) {
      activationWatchers.push({ target, onActive });
      return () => {};
    },
  });
  extension(pi);
  const ctx = {
    mode: "tui",
    ui: {
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
