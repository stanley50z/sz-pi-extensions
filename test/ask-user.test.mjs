import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings } from "@earendil-works/pi-tui";
import askUserExtension from "../extensions/ask-user.ts";

function setup({ choice, customAnswer, hasUI = true, mode, keys = [] } = {}) {
  let tool;
  const selectCalls = [];
  const inputCalls = [];
  const customCalls = [];
  const pi = { registerTool(definition) { tool = definition; } };
  askUserExtension(pi);
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
        const component = factory(
          { requestRender() {} },
          { fg: identity, bg: identity, bold: (text) => text },
          getKeybindings(),
          (value) => { answer = value; },
        );
        component.focused = true;
        for (const key of keys) component.handleInput(key);
        return answer;
      },
    },
  };
  return { get tool() { return tool; }, ctx, selectCalls, inputCalls, customCalls };
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

test("ask_user reports when interactive UI is unavailable", async () => {
  const state = setup({ hasUI: false });
  const result = await state.tool.execute("call-3", params, undefined, undefined, state.ctx);

  assert.equal(result.details.outcome, "no-ui");
  assert.match(result.content[0].text, /normal conversation/);
  assert.equal(state.selectCalls.length, 0);
});
