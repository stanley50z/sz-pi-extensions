import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("install-ketch clones the configured repository outside tracked package files", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "sz-pi-ketch-"));
  const source = join(tempRoot, "source");
  const destination = join(tempRoot, "installed", "ketch");

  mkdirSync(source);
  execFileSync("git", ["init"], { cwd: source, stdio: "ignore" });
  writeFileSync(join(source, "README.md"), "temporary ketch fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: source, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Installer Test",
      "-c",
      "user.email=installer@example.com",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: source, stdio: "ignore" },
  );

  execFileSync(
    process.execPath,
    ["scripts/install-ketch.mjs", "--repository", source, "--destination", destination],
    { cwd: process.cwd(), stdio: "pipe" },
  );

  assert.equal(readFileSync(join(destination, "README.md"), "utf8").trim(), "temporary ketch fixture");
  const origin = execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: destination,
    encoding: "utf8",
  }).trim();
  assert.equal(resolve(origin), resolve(source));
});

test("npm install provisions Ketch as an ignored Pi skill checkout", () => {
  const packageManifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const gitignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");

  assert.equal(packageManifest.scripts.postinstall, "node ./scripts/install-ketch.mjs");
  assert.equal(packageManifest.pi.skills.includes("node_modules/ketch/skills/ketch"), true);
  assert.match(gitignore, /^node_modules\/$/m);
});

test("Ketch replaces the in-repo web access extension", () => {
  const packageManifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

  assert.equal(existsSync(join(process.cwd(), "extensions", "pi-web-access")), false);
  assert.equal(packageManifest.pi.skills.includes("node_modules/ketch/skills/ketch"), true);
  for (const dependency of ["@mozilla/readability", "p-limit", "turndown", "unpdf"]) {
    assert.equal(packageManifest.dependencies[dependency], undefined);
  }
});
