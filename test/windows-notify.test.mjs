import assert from "node:assert/strict";
import test from "node:test";
import { createWindowsNotifyExtension } from "../extensions/windows-notify.ts";

function setup({ platform = "win32", targets = [{ windowHandle: 101, tabRuntimeId: [42, 7] }] } = {}) {
  const handlers = new Map();
  const notifications = [];
  const uiNotifications = [];
  let captureIndex = 0;
  const pi = {
    getSessionName: () => "Notification work",
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  const extension = createWindowsNotifyExtension({
    platform,
    async captureTerminalWindow() {
      return targets[Math.min(captureIndex++, targets.length - 1)];
    },
    notifyAndFocus(notification) {
      notifications.push(notification);
    },
  });
  extension(pi);
  const ctx = {
    mode: "tui",
    ui: {
      notify(message, type) {
        uiNotifications.push({ message, type });
      },
    },
  };
  return { handlers, notifications, uiNotifications, ctx };
}

test("notifies and focuses the session terminal only after the agent fully settles", async () => {
  const state = setup();
  await state.handlers.get("session_start")({}, state.ctx);
  await state.handlers.get("agent_start")({}, state.ctx);

  assert.deepEqual(state.notifications, []);

  await state.handlers.get("agent_settled")({}, state.ctx);
  assert.deepEqual(state.notifications, [{
    title: "Pi - Notification work",
    body: "Response finished",
    windowHandle: 101,
    tabRuntimeId: [42, 7],
  }]);
});

test("notifies and focuses immediately when Pi asks for user input", async () => {
  const state = setup();
  await state.handlers.get("session_start")({}, state.ctx);

  await state.handlers.get("ui_prompt_start")({
    kind: "select",
    title: "Choose a database",
  }, state.ctx);

  assert.deepEqual(state.notifications, [{
    title: "Pi - Notification work",
    body: "Input needed: Choose a database",
    windowHandle: 101,
    tabRuntimeId: [42, 7],
  }]);
});

test("does not install terminal notification hooks outside Windows", () => {
  const state = setup({ platform: "linux" });
  assert.deepEqual([...state.handlers.keys()], []);
});
