import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the stack bundles and exposes the pinned Claude Code provider", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

  assert.equal(manifest.dependencies["pi-claude-bridge"], "0.9.1");
  assert.ok(manifest.bundledDependencies.includes("pi-claude-bridge"));
  assert.ok(manifest.pi.extensions.includes("node_modules/pi-claude-bridge/src/index.ts"));
  assert.equal(lockfile.packages["node_modules/pi-claude-bridge"].version, "0.9.1");
});

test("host-provided extension packages are wildcard peers, not runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

  for (const declaration of [manifest, lockfile.packages[""]]) {
    for (const name of [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "typebox",
    ]) {
      assert.equal(declaration.dependencies[name], undefined, `${name} must not be a runtime dependency`);
      assert.equal(declaration.peerDependencies[name], "*", `${name} must be a wildcard peer`);
      assert.equal((declaration.bundledDependencies ?? declaration.bundleDependencies ?? []).includes(name), false);
    }
  }
});
