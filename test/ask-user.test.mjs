import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings } from "@earendil-works/pi-tui";
import askUserExtension from "../extensions/ask-user.ts";

function setup({
  choice,
  customAnswer,
  hasUI = true,
  mode,
  keys = [],
  renderWidth = 80,
  readClipboardForCustomAnswer,
} = {}) {
  let tool;
  let renderedLines = [];
  const selectCalls = [];
  const inputCalls = [];
  const customCalls = [];
  const pi = { registerTool(definition) { tool = definition; } };
  askUserExtension(pi, { readClipboardForCustomAnswer });
  const ctx = {
    hasUI,
    mode,
    ui: {
      async select(title, items) { selectCalls.push({ title, items }); return choice; },
      async input(title, placeholder) { inputCalls.push({ title, placeholder }); return customAnswer; },
      async custom(factory) {
        customCalls.push(factory);
        let answer;
        const identity = (_color, text) => text;
        const tuiKeybindings = getKeybindings();
        const keybindings = {
          matches(data, action) {
            if (action === "app.clipboard.pasteImage") return data === "<paste-image>";
            return tuiKeybindings.matches(data, action);
          },
        };
        const component = factory(
          { terminal: { rows: 40 }, requestRender() {} },
          { fg: identity, bg: identity, bold: (text) => text },
          keybindings,
          (value) => { answer = value; },
        );
        component.focused = true;
        for (const key of keys) {
          component.handleInput(key);
          await new Promise((resolve) => setImmediate(resolve));
        }
        renderedLines = component.render(renderWidth);
        return answer;
      },
    },
  };
  return {
    get tool() { return tool; },
    get renderedLines() { return renderedLines; },
    ctx,
    selectCalls,
    inputCalls,
    customCalls,
  };
}

const params = {
  question: "How should I configure this?",
  options: [
    { label: "Automatic", description: "Use recommended defaults" },
    { label: "Manual", description: "Configure every setting" },
  ],
};

test("ask_user presents choices and returns the selected answer", async () => {
  const state = setup({ mode: "rpc", choice: "Automatic — Use recommended defaults" });
  assert.equal(state.tool.executionMode, "sequential");
  const result = await state.tool.execute("call-1", params, undefined, undefined, state.ctx);

  assert.deepEqual(state.selectCalls, [{
    title: "How should I configure this?",
    items: [
      "Automatic — Use recommended defaults",
      "Manual — Configure every setting",
      "Type my own answer",
    ],
  }]);
  assert.equal(result.content[0].text, "User selected option 1: Automatic");
  assert.deepEqual(result.details, {
    outcome: "selected",
    question: params.question,
    answer: "Automatic",
    selectedIndex: 1,
  });
});

test("ask_user selects a listed answer with a top-row number key", async () => {
  const state = setup({ keys: ["2"] });
  const result = await state.tool.execute("call-2", params, undefined, undefined, state.ctx);

  assert.equal(result.content[0].text, "User selected option 2: Manual");
  assert.deepEqual(result.details, {
    outcome: "selected",
    question: params.question,
    answer: "Manual",
    selectedIndex: 2,
  });
});

test("ask_user selects a listed answer with a numpad number key", async () => {
  const state = setup({ keys: ["\x1b[57401u"] });
  const result = await state.tool.execute("call-3", params, undefined, undefined, state.ctx);

  assert.equal(result.content[0].text, "User selected option 2: Manual");
  assert.equal(result.details.selectedIndex, 2);
});

test("ask_user accepts typing immediately when the in-place custom answer is highlighted", async () => {
  const answer = "Use the team preset";
  const state = setup({
    keys: ["\x1b[B", "\x1b[B", ...answer, "\r"],
  });
  const result = await state.tool.execute("call-2", params, undefined, undefined, state.ctx);

  assert.equal(state.customCalls.length, 1);
  assert.equal(state.selectCalls.length, 0);
  assert.equal(state.inputCalls.length, 0);
  assert.equal(result.content[0].text, "User provided a custom answer: Use the team preset");
  assert.deepEqual(result.details, {
    outcome: "custom",
    question: params.question,
    answer: "Use the team preset",
    selectedIndex: undefined,
  });
});

test("ask_user pastes and attaches a clipboard image to the custom answer", async () => {
  const imagePath = "C:\\Temp\\pi-clipboard-test.png";
  const state = setup({
    keys: ["\x1b[B", "\x1b[B", "<paste-image>", "\r"],
    readClipboardForCustomAnswer: async () => ({
      text: imagePath,
      image: { type: "image", data: "cG5n", mimeType: "image/png" },
    }),
  });

  const result = await state.tool.execute("call-image", params, undefined, undefined, state.ctx);

  assert.deepEqual(result.content, [
    { type: "text", text: `User provided a custom answer: ${imagePath}` },
    { type: "image", data: "cG5n", mimeType: "image/png" },
  ]);
  assert.equal(result.details.answer, imagePath);
});

test("ask_user wraps the complete in-place custom answer", async () => {
  const answer = "alpha beta gamma delta epsilon";
  const state = setup({
    keys: ["\x1b[B", "\x1b[B", ...answer],
    renderWidth: 24,
  });

  await state.tool.execute("call-wrap", params, undefined, undefined, state.ctx);

  const firstWordLine = state.renderedLines.findIndex((line) => line.includes("alpha"));
  const lastWordLine = state.renderedLines.findIndex((line) => line.includes("epsilon"));
  assert.notEqual(firstWordLine, -1);
  assert.notEqual(lastWordLine, -1);
  assert.notEqual(firstWordLine, lastWordLine);
});

test("ask_user reports when interactive UI is unavailable", async () => {
  const state = setup({ hasUI: false });
  const result = await state.tool.execute("call-3", params, undefined, undefined, state.ctx);

  assert.equal(result.details.outcome, "no-ui");
  assert.match(result.content[0].text, /normal conversation/);
  assert.equal(state.selectCalls.length, 0);
});
