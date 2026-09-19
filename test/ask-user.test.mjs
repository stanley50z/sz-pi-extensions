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
  const events = [];
  const pi = {
    registerTool(definition) { tool = definition; },
    events: { emit(name, data) { events.push({ name, data }); } },
  };
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
        renderedLines = component.render(renderWidth);
        for (const key of keys) {
          component.handleInput(key);
          await new Promise((resolve) => setImmediate(resolve));
          renderedLines = component.render(renderWidth);
        }
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
    events,
  };
}

const params = {
  question: "How should I configure this?",
  options: [
    { label: "Automatic", description: "Use recommended defaults" },
    { label: "Manual", description: "Configure every setting" },
  ],
};

test("ask_user reports Herdr blocked only while the terminal question is open", async () => {
  const state = setup({ mode: "tui" });
  let answer;
  state.ctx.ui.custom = () => new Promise((resolve) => { answer = resolve; });
  const pending = state.tool.execute("herdr", params, undefined, undefined, state.ctx);
  assert.deepEqual(state.events, [{
    name: "herdr:blocked", data: { active: true, label: params.question },
  }]);
  answer({ kind: "selected", index: 0 });
  await pending;
  assert.deepEqual(state.events.at(-1), {
    name: "herdr:blocked", data: { active: false },
  });
});

test("ask_user clears Herdr waiting on dismissal, cancellation, and UI failure", async () => {
  for (const outcome of ["dismissed", "cancelled", "error"]) {
    const state = setup({ mode: "tui" });
    const controller = new AbortController();
    state.ctx.ui.custom = async () => {
      if (outcome === "error") throw new Error("UI failed");
      if (outcome === "cancelled") controller.abort();
      return null;
    };
    const pending = state.tool.execute("herdr", params, controller.signal, undefined, state.ctx);
    if (outcome === "error") await assert.rejects(pending, /UI failed/);
    else assert.equal((await pending).details.outcome, outcome);
    assert.deepEqual(state.events, [
      { name: "herdr:blocked", data: { active: true, label: params.question } },
      { name: "herdr:blocked", data: { active: false } },
    ]);
  }
});

test("ask_user does not report Herdr waiting without a terminal prompt", async () => {
  for (const options of [{ mode: "rpc" }, { hasUI: false }, { mode: "tui", aborted: true }]) {
    const state = setup(options);
    const signal = options.aborted ? AbortSignal.abort() : undefined;
    await state.tool.execute("herdr", params, signal, undefined, state.ctx);
    assert.deepEqual(state.events, []);
  }
});

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

test("ask_user moves up and down within a multiline custom answer", async () => {
  const state = setup({
    keys: ["3", ..."alpha", "\n", ..."bravo", "\x1b[A", "!", "\x1b[B", "?", "\r"],
  });
  const result = await state.tool.execute("call-multiline", params, undefined, undefined, state.ctx);

  assert.equal(result.details.outcome, "custom");
  assert.equal(result.details.answer, "alpha!\nbravo?");
});

test("ask_user moves up and down within a wrapped custom answer", async () => {
  const state = setup({
    keys: ["3", ..."abcdefghijklmnopqrst", "\x1b[A", "!", "\x1b[B", "?", "\r"],
    renderWidth: 24,
  });
  const result = await state.tool.execute("call-wrapped-cursor", params, undefined, undefined, state.ctx);

  assert.equal(result.details.outcome, "custom");
  assert.equal(result.details.answer, "ab!cdefghijklmnopqrst?");
});

test("ask_user keeps Up inside the first line until the cursor reaches the start", async () => {
  const state = setup({ keys: ["3", ..."alpha", "\x1b[A", "!", "\r"] });
  const result = await state.tool.execute("call-first-line", params, undefined, undefined, state.ctx);

  assert.equal(result.details.outcome, "custom");
  assert.equal(result.details.answer, "!alpha");
});

test("ask_user returns to options only at the draft start and preserves the draft", async () => {
  const state = setup({
    keys: ["3", ..."alpha", "\n", ..."bravo", "\x01", "\x1b[A", "\x1b[A", "\x1b[B", "!", "\r"],
  });
  const result = await state.tool.execute("call-return-to-draft", params, undefined, undefined, state.ctx);

  assert.equal(result.details.outcome, "custom");
  assert.equal(result.details.answer, "!alpha\nbravo");
});

test("ask_user navigates back to a listed option from an empty custom answer", async () => {
  const state = setup({ keys: ["3", "\x1b[A", "\r"] });
  const result = await state.tool.execute("call-empty-draft", params, undefined, undefined, state.ctx);

  assert.equal(result.details.outcome, "selected");
  assert.equal(result.details.answer, "Manual");
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
