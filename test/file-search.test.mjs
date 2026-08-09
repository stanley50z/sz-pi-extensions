import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fileSearchExtension from "../extensions/file-search.ts";

function setup() {
  const tools = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    exec(command, args, options = {}) {
      return new Promise((resolve, reject) => {
        execFile(command, args, {
          cwd: options.cwd,
          signal: options.signal,
          timeout: options.timeout,
          windowsHide: true,
          maxBuffer: 20 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          if (error && error.code !== 1) {
            resolve({
              code: typeof error.code === "number" ? error.code : 1,
              stdout,
              stderr: stderr || error.message,
              killed: error.killed,
            });
            return;
          }
          resolve({ code: error?.code ?? 0, stdout, stderr, killed: false });
        });
      });
    },
  };
  fileSearchExtension(pi);
  return tools;
}

test("find_files discovers matching files with the real fd binary", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "sz-find-files-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "app.ts"), "export const app = true;\n");
  await writeFile(join(cwd, "src", "app.js"), "export const app = true;\n");

  const tools = setup();
  const result = await tools.get("find_files").execute(
    "call-find",
    { pattern: "*.ts", path: ".", glob: true },
    undefined,
    undefined,
    { cwd },
  );

  assert.equal(result.content[0].text.trim(), "./src/app.ts");
  assert.deepEqual(result.details, { resultCount: 1, truncated: false, fullOutputPath: undefined });
});

test("find_files lists entries when glob mode has no explicit pattern", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "sz-find-all-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "notes.md"), "notes\n");

  const result = await setup().get("find_files").execute(
    "call-find-all",
    { path: ".", glob: true },
    undefined,
    undefined,
    { cwd },
  );

  assert.match(result.content[0].text, /notes\.md/);
});

test("file search tools hide multiline results while collapsed", () => {
  const theme = {
    fg(_color, text) {
      return text;
    },
  };
  const tools = setup();
  const findFiles = tools.get("find_files");
  const searchText = tools.get("search_text");

  const findCall = findFiles.renderCall(
    { pattern: "*.ts", path: "src" },
    theme,
    { toolCallId: "find-render", invalidate() {} },
  );
  const searchCall = searchText.renderCall(
    { pattern: "needle", path: "src" },
    theme,
    { toolCallId: "search-render", invalidate() {} },
  );
  const multilineResult = {
    content: [{ type: "text", text: "src/a.ts\nsrc/b.ts\nsrc/c.ts" }],
    details: {},
  };

  assert.deepEqual(findCall.render(120), ["find_files *.ts in src"]);
  assert.deepEqual(searchCall.render(120), ['search_text "needle" in src']);
  assert.deepEqual(
    findFiles.renderResult(multilineResult, { expanded: false }, theme, {}).render(120),
    [],
  );
  assert.deepEqual(
    searchText.renderResult(multilineResult, { expanded: false }, theme, {}).render(120),
    [],
  );
});

test("search_text finds matching content with the real rg binary", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "sz-search-text-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "app.ts"), "const first = 1;\nconst needle = true;\n");
  await writeFile(join(cwd, "src", "app.js"), "const needle = false;\n");

  const tools = setup();
  const result = await tools.get("search_text").execute(
    "call-search",
    { pattern: "needle", path: ".", glob: "*.ts", fixed_strings: true },
    undefined,
    undefined,
    { cwd },
  );

  assert.match(result.content[0].text, /^(?:\.[\\/])?src[\\/]app\.ts:2:7:const needle = true;/m);
  assert.doesNotMatch(result.content[0].text, /app\.js/);
  assert.deepEqual(result.details, { outputLines: 1, truncated: false, fullOutputPath: undefined });
});
