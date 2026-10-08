import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

// Exercise setup's real CLI with isolated package managers as part of npm test.
test("stack setup installation, checks, and failure handling", async () => {
  const python = process.platform === "win32" ? "python" : "python3";
  const { stderr } = await promisify(execFile)(python,
    ["-B", "-m", "unittest", "discover", "-s", "test", "-p", "setup_test.py"],
    { cwd: new URL("..", import.meta.url), timeout: 180_000 });
  assert.match(stderr, /OK/);
});
