import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import replaceSession from "../extensions/replace-session.ts";

test("/rn starts a new session and deletes the session it replaced", async () => {
  const commands = new Map();
  replaceSession({
    registerCommand(name, command) {
      commands.set(name, command);
    },
  });

  const directory = mkdtempSync(join(tmpdir(), "pi-rn-"));
  const previousSessionFile = join(directory, "previous.jsonl");
  writeFileSync(previousSessionFile, '{"type":"session"}\n');

  let newSessionCalled = false;
  const replacementContext = { ui: { notify() {} } };
  const context = {
    sessionManager: { getSessionFile: () => previousSessionFile },
    async newSession(options) {
      newSessionCalled = true;
      assert.equal(existsSync(previousSessionFile), true);
      await options.withSession(replacementContext);
      return { cancelled: false };
    },
  };

  const command = commands.get("rn");
  assert.ok(command, "/rn should be registered");
  await command.handler("", context);

  assert.equal(newSessionCalled, true);
  assert.equal(existsSync(previousSessionFile), false);
});

test("/rn succeeds when the replaced session has not been persisted yet", async () => {
  const commands = new Map();
  replaceSession({
    registerCommand(name, command) {
      commands.set(name, command);
    },
  });

  const missingSessionFile = join(
    mkdtempSync(join(tmpdir(), "pi-rn-empty-")),
    "not-created-yet.jsonl",
  );
  let newSessionCalled = false;
  const context = {
    sessionManager: { getSessionFile: () => missingSessionFile },
    async newSession(options) {
      newSessionCalled = true;
      await options.withSession({ ui: { notify() {} } });
      return { cancelled: false };
    },
  };

  await commands.get("rn").handler("", context);

  assert.equal(newSessionCalled, true);
  assert.equal(existsSync(missingSessionFile), false);
});
