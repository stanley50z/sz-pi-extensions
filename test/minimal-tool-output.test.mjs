import assert from "node:assert/strict";
import test from "node:test";
import minimalToolOutputExtension from "../extensions/minimal-tool-output.ts";

function install() {
  const tools = new Map();
  minimalToolOutputExtension({
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  });
  return tools;
}

const theme = {
  fg(_color, text) {
    return text;
  },
};

test("collapsed edit shows only Pi's built-in call line", () => {
  const edit = install().get("edit");

  assert.ok(edit, "edit override should be registered");
  assert.equal(edit.renderCall, undefined, "Pi should retain its built-in edit call renderer");

  const result = edit.renderResult(
    { content: [{ type: "text", text: "diff output" }], details: {} },
    { expanded: false, isPartial: false },
    theme,
    {},
  );

  assert.deepEqual(result.render(120), []);
});
