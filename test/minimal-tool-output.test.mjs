import assert from "node:assert/strict";
import test from "node:test";
import minimalToolOutputExtension from "../extensions/minimal-tool-output.ts";

function install() {
  const tools = new Map();
  const handlers = new Map();
  minimalToolOutputExtension({
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  return { tools, handlers };
}

const theme = {
  fg(_color, text) {
    return text;
  },
  bg(_color, text) {
    return text;
  },
};

function renderText(component, width = 120) {
  return component.render(width).map((line) => line.trim());
}

test("collapsed edit shows only its call line", () => {
  const edit = install().tools.get("edit");

  assert.ok(edit, "edit override should be registered");
  const call = edit.renderCall(
    { path: "extensions/file-search.ts" },
    theme,
    { toolCallId: "edit-1", invalidate() {} },
  );
  assert.deepEqual(renderText(call), ["", "edit extensions/file-search.ts", ""]);

  const result = edit.renderResult(
    { content: [{ type: "text", text: "diff output" }], details: {} },
    { expanded: false, isPartial: false },
    theme,
    {},
  );

  assert.deepEqual(result.render(120), []);
});

test("completed tool call lines retain the success background", () => {
  const backgroundColors = [];
  const highlightedTheme = {
    ...theme,
    bg(color, text) {
      backgroundColors.push(color);
      return text;
    },
  };
  const edit = install().tools.get("edit");
  const call = edit.renderCall(
    { path: "extensions/file-search.ts" },
    highlightedTheme,
    { toolCallId: "edit-highlighted", isPartial: false, isError: false, invalidate() {} },
  );

  call.render(80);

  assert.ok(backgroundColors.length > 0);
  assert.deepEqual([...new Set(backgroundColors)], ["toolSuccessBg"]);
});

test("multiline bash calls show only the first command line", () => {
  const bash = install().tools.get("bash");
  const call = bash.renderCall(
    {
      command: "cd C:/Users/13982/sz-pi-extensions && node --input-type=module <<'EOF'\nimport minimal from './extensions/minimal-tool-output.ts';\nEOF",
    },
    theme,
    { toolCallId: "bash-1", invalidate() {} },
  );

  assert.deepEqual(renderText(call, 200), [
    "",
    "$ cd C:/Users/13982/sz-pi-extensions && node --input-type=module <<'EOF'",
    "",
  ]);
});

test("consecutive reads collapse into one file summary", async () => {
  const { tools, handlers } = install();
  const reads = [
    ["read-1", "test/file-search.test.mjs"],
    ["read-2", "test/openai-fast-mode.test.mjs"],
    ["read-3", "test/ask-user.test.mjs"],
    ["read-4", "extensions/file-search.ts"],
    ["read-5", "extensions/openai-fast-mode.ts"],
  ];

  await handlers.get("message_end")({
    message: {
      role: "assistant",
      content: reads.map(([id, path]) => ({
        type: "toolCall",
        id,
        name: "read",
        arguments: { path },
      })),
    },
  });

  const read = tools.get("read");
  const first = read.renderCall(
    { path: reads[0][1] },
    theme,
    { toolCallId: reads[0][0], invalidate() {} },
  );
  const second = read.renderCall(
    { path: reads[1][1] },
    theme,
    { toolCallId: reads[1][0], invalidate() {} },
  );
  const expandedSecond = read.renderCall(
    { path: reads[1][1] },
    theme,
    { toolCallId: reads[1][0], expanded: true, invalidate() {} },
  );

  assert.equal(read.renderShell, "self");
  assert.deepEqual(renderText(first), ["", "read test/file-search.test.mjs and 4 files", ""]);
  assert.deepEqual(renderText(second), []);
  assert.deepEqual(renderText(expandedSecond), ["", "read test/openai-fast-mode.test.mjs", ""]);
});
