import assert from "node:assert/strict";
import test from "node:test";
import { createCopySessionExtension } from "../extensions/copy-session.ts";

function message(role, content) {
  return { type: "message", message: { role, content } };
}

test("/copy-all copies readable user and assistant history from the active branch", async () => {
  const commands = new Map();
  const copied = [];
  const notifications = [];
  let waited = false;
  const pi = { registerCommand(name, command) { commands.set(name, command); } };
  createCopySessionExtension({ copy: async (text) => copied.push(text) })(pi);

  const branch = [
    message("user", [{ type: "text", text: "Review this screenshot." }, { type: "image", data: "base64" }]),
    message("assistant", [
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "I found the issue." },
      { type: "toolCall", id: "1", name: "read", arguments: {} },
    ]),
    message("toolResult", [{ type: "text", text: "tool noise" }]),
  ];
  const ctx = {
    async waitForIdle() { waited = true; },
    sessionManager: { getBranch: () => branch },
    ui: { notify(text, level) { notifications.push({ text, level }); } },
  };

  await commands.get("copy-all").handler("", ctx);

  assert.equal(waited, true);
  assert.equal(copied[0], "USER:\nReview this screenshot.\n[image]\n\n---\n\nASSISTANT:\nI found the issue.");
  assert.deepEqual(notifications, [{ text: "Copied 2 messages (73 characters)", level: "info" }]);
});
