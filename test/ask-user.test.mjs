import assert from "node:assert/strict";
import test from "node:test";
import askUserExtension from "../extensions/ask-user.ts";

function setup({ choice, customAnswer, hasUI = true } = {}) {
  let tool;
  const selectCalls = [];
  const inputCalls = [];
  const pi = { registerTool(definition) { tool = definition; } };
  askUserExtension(pi);
  const ctx = {
    hasUI,
    ui: {
      async select(title, items) { selectCalls.push({ title, items }); return choice; },
      async input(title, placeholder) { inputCalls.push({ title, placeholder }); return customAnswer; },
    },
  };
  return { get tool() { return tool; }, ctx, selectCalls, inputCalls };
}

const params = {
  question: "How should I configure this?",
  options: [
    { label: "Automatic", description: "Use recommended defaults" },
    { label: "Manual", description: "Configure every setting" },
  ],
};

test("ask_user presents choices and returns the selected answer", async () => {
  const state = setup({ choice: "Automatic — Use recommended defaults" });
  assert.equal(state.tool.executionMode, "sequential");
  const result = await state.tool.execute("call-1", params, undefined, undefined, state.ctx);

  assert.deepEqual(state.selectCalls, [{
    title: "How should I configure this?",
    items: [
      "Automatic — Use recommended defaults",
      "Manual — Configure every setting",
      "Something else…",
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

test("ask_user always offers and returns a free-form answer", async () => {
  const state = setup({ choice: "Something else…", customAnswer: "Use the team preset" });
  const result = await state.tool.execute("call-2", params, undefined, undefined, state.ctx);

  assert.deepEqual(state.inputCalls, [{ title: "Your answer", placeholder: "Type a response" }]);
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
