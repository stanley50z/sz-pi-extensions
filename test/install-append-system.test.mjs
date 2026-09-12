import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installer = fileURLToPath(new URL("../scripts/install-append-system.mjs", import.meta.url));
const begin = "<!-- sz-pi-extensions:begin -->";
const end = "<!-- sz-pi-extensions:end -->";

// Exercise the setup CLI against an isolated Pi config directory, not the user's config.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "sz-pi-prompt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  return {
    path: join(agentDir, "APPEND_SYSTEM.md"),
    install: () => execFileSync(process.execPath, [installer], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      encoding: "utf8",
      timeout: 10_000,
      stdio: "pipe",
    }),
  };
}

test("setup installs model guidance and updates only its own section on repeat installs", (t) => {
  const { path, install } = fixture(t);
  install();
  const installed = readFileSync(path, "utf8");
  assert.match(installed, /Prefer the Pi harness for subagent sessions/);
  assert.match(installed, /GPT models.*openai-codex/);
  assert.match(installed, /Claude models.*github-copilot/);
  assert.match(installed, /Prefer Claude models for front-end design and code review/);
  assert.match(installed, /Prefer GPT-6 Astra with low reasoning for daily coding and everyday use/);
  assert.match(installed, /all subagent sessions using GPT-6 Astra or Fable.*medium or lower/);
  install();
  assert.equal(readFileSync(path, "utf8"), installed);

  const prefix = "# Personal instructions\r\n保留这段文字。\r\n\r\n";
  const suffix = "\r\n\r\n# Other instructions\r\nKeep these too.\r\n";
  writeFileSync(path, `${prefix}${begin}\r\nOutdated rules\r\n${end}${suffix}`, "utf8");
  install();
  const updated = readFileSync(path, "utf8");
  assert.equal(updated, prefix + installed.trimEnd() + suffix);
  install();
  assert.equal(readFileSync(path, "utf8"), updated);

  writeFileSync(path, prefix, "utf8");
  install();
  assert.ok(readFileSync(path, "utf8").startsWith(prefix));
  assert.ok(readFileSync(path, "utf8").includes(installed.trimEnd()));
});

test("setup refuses malformed or duplicate managed sections without changing the file", (t) => {
  const { path, install } = fixture(t);
  install();
  for (const content of [begin, end, `${end}\n${begin}`, `${begin}\n${begin}\n${end}`, `${begin}\n${end}\n${end}`]) {
    writeFileSync(path, content, "utf8");
    assert.throws(install, /Invalid sz-pi-extensions markers/);
    assert.equal(readFileSync(path, "utf8"), content);
  }
});
