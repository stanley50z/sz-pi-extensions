import assert from "node:assert/strict";
import test from "node:test";
import sessionTitle, { RESTORE_TERMINAL_TITLE_EVENT } from "../extensions/session-title.ts";

function setup(initialName) {
  const handlers = new Map();
  const eventHandlers = new Map();
  const titles = [];
  let sessionName = initialName;
  const pi = {
    getSessionName: () => sessionName,
    on(name, handler) { handlers.set(name, handler); },
    events: {
      on(name, handler) { eventHandlers.set(name, handler); return () => eventHandlers.delete(name); },
      emit(name, data) { eventHandlers.get(name)?.(data); },
    },
  };
  sessionTitle(pi);
  const ctx = { ui: { setTitle(title) { titles.push(title); }, notify() {} } };
  return { pi, handlers, eventHandlers, titles, ctx, setSessionName(name) { sessionName = name; } };
}

test("terminal title follows the current Pi session name", async () => {
  const state = setup("Investigate title");
  await state.handlers.get("session_start")({}, state.ctx);
  assert.equal(state.titles.at(-1), "Pi - Investigate title");

  state.setSessionName("Native subagents");
  await state.handlers.get("session_info_changed")({ name: "Native subagents" }, state.ctx);
  assert.equal(state.titles.at(-1), "Pi - Native subagents");
});

test("terminal title can be restored after a child process overwrites it", async () => {
  const state = setup("Restore me");
  await state.handlers.get("session_start")({}, state.ctx);
  state.eventHandlers.get(RESTORE_TERMINAL_TITLE_EVENT)();
  assert.equal(state.titles.at(-1), "Pi - Restore me");
});

test("untitled sessions still use a Pi-prefixed title", async () => {
  const state = setup(undefined);
  await state.handlers.get("session_start")({}, state.ctx);
  assert.equal(state.titles.at(-1), "Pi - Untitled session");
});
