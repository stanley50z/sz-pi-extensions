import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import fileSearchExtension from "../extensions/file-search.ts";
import minimalToolOutputExtension from "../extensions/minimal-tool-output.ts";
import {
  connectRunningSubagentStatus,
  renderSubagentResult,
  withMinimalSubagentOutput,
} from "../lib/subagent-tool-output.ts";

initTheme(undefined, false);

function install({ beforeMinimal = [], afterMinimal = [] } = {}) {
  const tools = new Map();
  const handlers = new Map();
  const markdownTransformers = [];
  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerMarkdownTransformer(transformer) {
      markdownTransformers.push(transformer);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    sendMessage() {},
    getThinkingLevel() {
      return "medium";
    },
  };
  for (const extension of beforeMinimal) extension(pi);
  minimalToolOutputExtension(pi);
  for (const extension of afterMinimal) extension(pi);
  handlers.get("session_start")(
    {},
    {
      ui: { getToolsExpanded: () => false },
      sessionManager: { getBranch: () => [] },
    },
  );
  return { tools, handlers, markdownTransformers };
}

const theme = {
  fg(_color, text) {
    return text;
  },
  bg(_color, text) {
    return text;
  },
  bold(text) {
    return `\u001b[1m${text}\u001b[22m`;
  },
  italic(text) {
    return text;
  },
  underline(text) {
    return text;
  },
  strikethrough(text) {
    return text;
  },
};

function renderText(component, width = 120) {
  return component.render(width).map((line) => stripVTControlCharacters(line).trim());
}

test("collapsed edit shows only its call line", () => {
  const edit = install().tools.get("edit");

  assert.ok(edit, "edit override should be registered");
  const call = edit.renderCall(
    { path: "extensions/file-search.ts" },
    theme,
    { toolCallId: "edit-1", expanded: true, invalidate() {} },
  );
  assert.deepEqual(renderText(call), ["", "edit extensions/file-search.ts", ""]);

  const toolResult = {
    content: [
      { type: "text", text: "diff output" },
      { type: "image", data: "base64-image", mimeType: "image/png" },
    ],
    details: {},
  };
  const ultraCollapsedResult = edit.renderResult(
    toolResult,
    { expanded: false, isPartial: false },
    theme,
    {},
  );
  const collapsedResult = edit.renderResult(
    toolResult,
    { expanded: true, isPartial: false },
    theme,
    {},
  );

  assert.deepEqual(ultraCollapsedResult.render(120), []);
  assert.deepEqual(collapsedResult.render(120), []);
});

test("agent skill reads render as skill invocations outside tool groups", async () => {
  const { tools, handlers } = install();
  const path = "C:/Users/test/.agents/skills/tdd/SKILL.md";
  const content = [
    { type: "toolCall", id: "skill-read", name: "read", arguments: { path } },
    { type: "toolCall", id: "source-read", name: "read", arguments: { path: "src/app.ts" } },
  ];

  await handlers.get("message_end")({ message: { role: "assistant", content } });

  const read = tools.get("read");
  const skillCall = read.renderCall(content[0].arguments, theme, {
    toolCallId: "skill-read",
    expanded: false,
    invalidate() {},
  });
  const sourceCall = read.renderCall(content[1].arguments, theme, {
    toolCallId: "source-read",
    expanded: false,
    invalidate() {},
  });
  const skillResult = read.renderResult(
    {
      content: [{
        type: "text",
        text: "---\nname: tdd\ndescription: Test-driven development\n---\n\n# Test-driven development\n\nWrite a failing test first.",
      }],
      details: {},
    },
    { expanded: false, isPartial: false },
    theme,
    { args: content[0].arguments, isError: false },
  );

  const expandedSkillResult = read.renderResult(
    {
      content: [{
        type: "text",
        text: "---\nname: tdd\ndescription: Test-driven development\n---\n\n# Test-driven development\n\nWrite a failing test first.",
      }],
      details: {},
    },
    { expanded: true, isPartial: false },
    theme,
    { args: content[0].arguments, isError: false },
  );

  assert.deepEqual(renderText(skillCall), []);
  assert.deepEqual(renderText(sourceCall), ["+ 1 tool call"]);
  assert.match(renderText(skillResult).join("\n"), /\[skill\] tdd/);
  assert.doesNotMatch(renderText(skillResult).join("\n"), /expand|description:|Write a failing test/);
  assert.match(renderText(expandedSkillResult).join("\n"), /\[skill\] tdd/);
  assert.doesNotMatch(
    renderText(expandedSkillResult).join("\n"),
    /expand|description:|Write a failing test/,
  );
});

test("consecutive agent skill reads collapse into one highlighted line", async () => {
  const { tools, handlers } = install();
  const calls = ["grill-with-docs", "grilling", "domain-modeling", "unslop"].map(
    (name) => ({
      type: "toolCall",
      id: `skill-${name}`,
      name: "read",
      arguments: { path: `C:/Users/test/.agents/skills/${name}/SKILL.md` },
    }),
  );

  await handlers.get("message_end")({ message: { role: "assistant", content: calls } });

  const backgroundColors = [];
  const highlightedTheme = {
    ...theme,
    bg(color, text) {
      backgroundColors.push(color);
      return text;
    },
  };
  const read = tools.get("read");
  const rendered = calls.map((call) => read.renderResult(
    {
      content: [{
        type: "text",
        text: `---\nname: ${call.id.slice("skill-".length)}\ndescription: Test skill\n---\n\n# Instructions`,
      }],
      details: {},
    },
    { expanded: false, isPartial: false },
    highlightedTheme,
    { toolCallId: call.id, args: call.arguments, isError: false },
  ));
  const expanded = calls.map((call) => read.renderResult(
    {
      content: [{
        type: "text",
        text: `---\nname: ${call.id.slice("skill-".length)}\ndescription: Test skill\n---\n\n# Instructions`,
      }],
      details: {},
    },
    { expanded: true, isPartial: false },
    theme,
    { toolCallId: call.id, args: call.arguments, isError: false },
  ));

  assert.match(
    renderText(rendered[0]).join("\n"),
    /\[skill\] grill-with-docs, grilling, domain-modeling, unslop/,
  );
  assert.doesNotMatch(renderText(rendered[0]).join("\n"), /expand|Instructions/);
  assert.deepEqual(rendered.slice(1).map((component) => renderText(component)), [[], [], []]);
  assert.deepEqual([...new Set(backgroundColors)], ["customMessageBg"]);
  assert.deepEqual(renderText(expanded[0]), renderText(rendered[0]));
  assert.deepEqual(expanded.slice(1).map((component) => renderText(component)), [[], [], []]);
});

test("ultra-collapsed view replaces mixed tool commands with one count", async () => {
  const { tools, handlers } = install();

  await handlers.get("message_end")({
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Setting up temp file with Bash commands",
        },
        {
          type: "toolCall",
          id: "write-ultra",
          name: "write",
          arguments: { path: "C:/temp/pi-rate-limit-probe.ts", content: "test" },
        },
        {
          type: "toolCall",
          id: "bash-ultra",
          name: "bash",
          arguments: { command: "pi -p -e C:/temp/pi-rate-limit-probe.ts" },
        },
      ],
    },
  });

  const writeCall = tools.get("write").renderCall(
    { path: "C:/temp/pi-rate-limit-probe.ts", content: "test" },
    theme,
    { toolCallId: "write-ultra", expanded: false, invalidate() {} },
  );
  const bashCall = tools.get("bash").renderCall(
    { command: "pi -p -e C:/temp/pi-rate-limit-probe.ts" },
    theme,
    { toolCallId: "bash-ultra", expanded: false, invalidate() {} },
  );

  assert.deepEqual(renderText(writeCall), ["Setting up temp file with Bash commands + 2 tool calls"]);
  assert.deepEqual(renderText(bashCall), []);
});

test("separately loaded extensions share one consecutive tool-call group", async () => {
  const instance = `${Date.now()}-${Math.random()}`;
  const eventModule = await import(`../extensions/minimal-tool-output.ts?events=${instance}`);
  const toolModule = await import(`../extensions/minimal-tool-output.ts?tool=${instance}`);
  const tools = new Map();
  const handlers = new Map();
  const toolName = `isolated_search_${instance}`;
  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerMarkdownTransformer() {},
    on(event, handler) {
      handlers.set(event, handler);
    },
  };

  eventModule.default(pi);
  pi.registerTool(toolModule.withMinimalToolOutput({
    name: toolName,
    label: "Isolated Search",
    description: "Test a separately loaded renderer",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  }));
  handlers.get("session_start")(
    {},
    { sessionManager: { getBranch: () => [] } },
  );

  const content = [
    { type: "text", text: "Cross-extension calls" },
    { type: "toolCall", id: "isolated-call", name: toolName, arguments: {} },
    { type: "toolCall", id: "shared-read", name: "read", arguments: { path: "a.ts" } },
  ];
  await handlers.get("message_end")({ message: { role: "assistant", content } });

  const customCall = tools.get(toolName).renderCall({}, theme, {
    toolCallId: "isolated-call",
    expanded: false,
    invalidate() {},
  });
  const readCall = tools.get("read").renderCall({ path: "a.ts" }, theme, {
    toolCallId: "shared-read",
    expanded: false,
    invalidate() {},
  });

  assert.deepEqual(renderText(customCall), ["Cross-extension calls + 2 tool calls"]);
  assert.deepEqual(renderText(readCall), []);
});

test("ultra-collapsed view includes local search tools in one tool-call count", async () => {
  const { tools, handlers } = install({ beforeMinimal: [fileSearchExtension] });
  const content = [
    { type: "text", text: "Searching the workspace" },
    {
      type: "toolCall",
      id: "find-files-1",
      name: "find_files",
      arguments: { pattern: "*.ts", path: "src", glob: true },
    },
    {
      type: "toolCall",
      id: "search-text-1",
      name: "search_text",
      arguments: { pattern: "needle", path: "src" },
    },
    { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/app.ts" } },
  ];

  await handlers.get("message_end")({ message: { role: "assistant", content } });

  const calls = [
    tools.get("find_files").renderCall(content[1].arguments, theme, {
      toolCallId: "find-files-1",
      expanded: false,
      invalidate() {},
    }),
    tools.get("search_text").renderCall(content[2].arguments, theme, {
      toolCallId: "search-text-1",
      expanded: false,
      invalidate() {},
    }),
    tools.get("read").renderCall(content[3].arguments, theme, {
      toolCallId: "read-1",
      expanded: false,
      invalidate() {},
    }),
  ];

  assert.deepEqual(renderText(calls[0]), ["Searching the workspace + 3 tool calls"]);
  assert.deepEqual(calls.slice(1).map((call) => renderText(call)), [[], []]);
});

test("ultra-collapsed view keeps subagent calls visible without their prompts", async () => {
  const subagentsExtension = (pi) => {
    pi.registerTool(withMinimalSubagentOutput({
      name: "subagent_spawn",
      label: "Spawn Subagent",
      description: "Start a child session",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "started" }], details: {} };
      },
    }));
  };
  const { tools, handlers } = install({ afterMinimal: [subagentsExtension] });
  const content = [
    { type: "text", text: "Delegating the review" },
    {
      type: "toolCall",
      id: "subagent-spawn-1",
      name: "subagent_spawn",
      arguments: {
        prompt: "Review the change",
        name: "review",
        harness: "pi",
        model: "openai-codex/gpt-6-astra",
        reasoning_effort: "low",
      },
    },
    { type: "toolCall", id: "read-after-spawn", name: "read", arguments: { path: "a.ts" } },
  ];

  await handlers.get("message_end")({ message: { role: "assistant", content } });

  const spawnCall = tools.get("subagent_spawn").renderCall(content[1].arguments, theme, {
    toolCallId: "subagent-spawn-1",
    expanded: false,
    invalidate() {},
  });
  const readCall = tools.get("read").renderCall(content[2].arguments, theme, {
    toolCallId: "read-after-spawn",
    expanded: false,
    invalidate() {},
  });

  assert.deepEqual(renderText(spawnCall), [
    "",
    "subagent_spawn review with pi · gpt-6-astra · low",
    "",
  ]);
  assert.doesNotMatch(renderText(spawnCall).join("\n"), /Review the change/);
  assert.deepEqual(renderText(readCall), ["Delegating the review + 1 tool call"]);
  assert.deepEqual(
    tools.get("subagent_spawn").renderResult(
      { content: [{ type: "text", text: "verbose child output" }], details: {} },
      { expanded: true },
      theme,
      {},
    ).render(120),
    [],
  );
});

test("spawn call settings handle omitted arguments and reasoning off in both views", () => {
  const tool = withMinimalSubagentOutput({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: "Start a child session",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "started" }], details: {} };
    },
  });
  const cases = [
    [{}, "subagent_spawn"],
    [{ name: "review", harness: "pi" }, "subagent_spawn review with pi"],
    [{ model: "sonnet" }, "subagent_spawn sonnet"],
    [{ model: "claude-fable-5-1" }, "subagent_spawn fable-5-1"],
    [{ model: "github-copilot/claude-fable-5-1" }, "subagent_spawn fable-5-1"],
    [{ reasoning_effort: "off" }, "subagent_spawn off"],
    [
      { name: "review", harness: "claude", model: "sonnet", reasoning_effort: "medium" },
      "subagent_spawn review with claude · sonnet · medium",
    ],
  ];
  for (const expanded of [false, true]) {
    for (const [args, expected] of cases) {
      const call = tool.renderCall(args, theme, {
        toolCallId: "spawn-settings",
        expanded,
        invalidate() {},
      });
      assert.deepEqual(renderText(call), ["", expected, ""]);
    }
  }
});

test("spawn rows retain the inherited model after execution and session restore", async () => {
  const makeTool = () => withMinimalSubagentOutput({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: "Start a child session",
    parameters: { type: "object", properties: {} },
    async execute(_id, args) {
      assert.equal(args.model, undefined, "display must not change spawn arguments");
      return { content: [{ type: "text", text: "started" }], details: { retained: true } };
    },
  });
  const tool = makeTool();
  const args = { name: "review", harness: "pi", reasoning_effort: "low" };
  const ctx = { model: { provider: "openai-codex", id: "gpt-6-astra" } };
  const result = await tool.execute("inherited", args, undefined, undefined, ctx);
  assert.equal(result.details.retained, true);
  ctx.model = { provider: "github-copilot", id: "claude-fable-5-1" };

  for (const renderer of [tool, makeTool()]) {
    for (const expanded of [false, true]) {
      const row = new ToolExecutionComponent(
        "subagent_spawn", "inherited", args, {}, renderer, { requestRender() {} }, process.cwd(),
      );
      row.setExpanded(expanded);
      row.updateResult(JSON.parse(JSON.stringify(result)));
      assert.deepEqual(renderText(row).filter(Boolean), [
        "subagent_spawn review with pi · gpt-6-astra · low",
      ]);
    }
  }
});

test("native spawn rows retain the resolved default model after execution and restore", async () => {
  let snapshot = { id: "sa-1", name: "smoke-test", status: "running" };
  const listeners = new Set();
  const source = {
    list: () => [{ id: "sa-2", name: "other-child", status: "running", model: "sonnet" }, snapshot],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const makeTool = () => withMinimalSubagentOutput({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: "Start a child session",
    parameters: { type: "object", properties: {} },
    async execute(_id, args) {
      assert.equal(args.model, undefined, "display must not choose the native model");
      setImmediate(() => {
        snapshot = { ...snapshot, model: "claude-opus-5-5" };
        for (const listener of listeners) listener();
      });
      return {
        content: [{ type: "text", text: "Started sa-1 “smoke-test” with claude in C:/test." }],
        details: { retained: true },
      };
    },
  }, source);
  const tool = makeTool();
  const args = { name: "smoke-test", harness: "claude" };
  const result = await tool.execute("native", args, undefined, undefined, {
    model: { provider: "openai-codex", id: "gpt-6-astra" },
  });
  assert.equal(result.details.subagentModel, "claude-opus-5-5");
  assert.equal(result.details.retained, true);
  assert.equal(listeners.size, 0, "startup listener must be released");

  // Restored rows must not need a running native session or today's parent model.
  for (const renderer of [tool, withMinimalSubagentOutput({ ...tool })]) {
    const row = new ToolExecutionComponent(
      "subagent_spawn", "native", args, {}, renderer, { requestRender() {} }, process.cwd(),
    );
    row.updateResult(JSON.parse(JSON.stringify(result)));
    assert.deepEqual(renderText(row).filter(Boolean), [
      "subagent_spawn smoke-test with claude · opus-5-5",
    ]);
  }
});

test("native spawn metadata releases its listener when startup is cancelled", async () => {
  const listeners = new Set();
  const source = {
    list: () => [{ id: "sa-1", name: "cancelled", status: "running" }],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const tool = withMinimalSubagentOutput({
    name: "subagent_spawn",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "Started sa-1 “cancelled” with claude in C:/test." }], details: {} };
    },
  }, source);
  const controller = new AbortController();
  const pending = tool.execute("cancelled", { harness: "claude" }, controller.signal, undefined, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listeners.size, 1);
  controller.abort(new Error("Cancelled startup"));
  await assert.rejects(pending, /Cancelled startup/);
  assert.equal(listeners.size, 0);
});

test("failed native startup does not invent a model or wait forever", async () => {
  const listeners = new Set();
  const source = {
    list: () => [{ id: "sa-1", name: "failed", status: "error" }],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const tool = withMinimalSubagentOutput({
    name: "subagent_spawn",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "Started sa-1 “failed” with claude in C:/test." }], details: {} };
    },
  }, source);
  const result = await tool.execute("failed", { harness: "claude" }, undefined, undefined, {
    model: { provider: "openai-codex", id: "gpt-6-astra" },
  });
  assert.equal(result.details.subagentModel, undefined);
  assert.equal(listeners.size, 0);
});

test("subagent status publishes only children that are still running", () => {
  let snapshots = [
    { id: "sa-1", name: "auth-review", status: "running" },
    { id: "sa-2", name: "finished-test", status: "done" },
  ];
  let notify = () => {};
  const events = [];
  const disconnect = connectRunningSubagentStatus(
    { events: { emit: (name, data) => events.push({ name, data }) } },
    {
      list: () => snapshots,
      subscribe(listener) {
        notify = listener;
        return () => { notify = () => {}; };
      },
    },
  );

  assert.deepEqual(events.at(-1), {
    name: "sz-subagents:running",
    data: { subagents: [{ id: "sa-1", name: "auth-review", model: undefined, reasoningEffort: undefined }] },
  });

  snapshots = snapshots.map((snapshot) => ({ ...snapshot, status: "done" }));
  notify();
  assert.deepEqual(events.at(-1), {
    name: "sz-subagents:running",
    data: { subagents: [] },
  });

  disconnect();
});

test("settled subagent messages collapse their returned text", () => {
  const message = {
    customType: "sz-subagent-result",
    content: "pi-1 “review” finished (pi)\n\nFirst detailed paragraph.\n\nSecond detailed paragraph.",
    display: true,
    details: { id: "pi-1", harness: "pi", status: "done" },
  };
  const collapsed = renderSubagentResult(message, { expanded: false, outputPad: 1 }, theme);
  const expanded = renderSubagentResult(message, { expanded: true, outputPad: 1 }, theme);

  assert.match(renderText(collapsed).join("\n"), /\[subagent\].*pi-1.*expand/);
  assert.doesNotMatch(renderText(collapsed).join("\n"), /detailed paragraph/);
  assert.match(renderText(expanded).join("\n"), /Second detailed paragraph\./);
});

test("ultra-collapsed view keeps rendered Markdown and its tool count on one line", async () => {
  const { tools, handlers, markdownTransformers } = install();
  const content = [
    { type: "thinking", thinking: "**Reviewing code consistency and diffs**" },
    { type: "toolCall", id: "review-1", name: "read", arguments: { path: "a.ts" } },
    { type: "toolCall", id: "review-2", name: "read", arguments: { path: "b.ts" } },
    { type: "toolCall", id: "review-3", name: "bash", arguments: { command: "git diff" } },
  ];

  await handlers.get("message_end")({ message: { role: "assistant", content } });

  const transformed = markdownTransformers[0](content[0].thinking, {
    messageType: "assistant-thinking",
    isStreaming: false,
    availableWidth: 120,
  });
  const firstCall = tools.get("read").renderCall(
    { path: "a.ts" },
    theme,
    { toolCallId: "review-1", expanded: false, invalidate() {} },
  );

  assert.equal(transformed, "");
  assert.deepEqual(renderText(firstCall), ["Reviewing code consistency and diffs + 3 tool calls"]);
  assert.doesNotMatch(firstCall.render(120).join("\n"), /\*\*/);
});

test("collapsed view keeps the narration above the tool card", async () => {
  const { tools, handlers, markdownTransformers } = install();
  const content = [
    { type: "text", text: "Reviewing code consistency and diffs" },
    { type: "toolCall", id: "review-expanded", name: "read", arguments: { path: "a.ts" } },
  ];

  await handlers.get("message_end")({ message: { role: "assistant", content } });

  assert.equal(
    markdownTransformers[0](content[0].text, {
      messageType: "assistant",
      isStreaming: false,
      availableWidth: 120,
    }),
    "",
  );
  const call = tools.get("read").renderCall(
    { path: "a.ts" },
    theme,
    { toolCallId: "review-expanded", expanded: true, invalidate() {} },
  );
  assert.deepEqual(renderText(call), [
    "Reviewing code consistency and diffs",
    "",
    "read a.ts",
    "",
  ]);
});

test("ultra-collapsed view combines consecutive tool-only turns into the active narration", async () => {
  const { tools, handlers, markdownTransformers } = install();
  const turns = [
    [
      { type: "text", text: "Planning failing test for tool call count bug" },
      { type: "toolCall", id: "plan-1", name: "edit", arguments: { path: "test.ts" } },
    ],
    [{ type: "toolCall", id: "plan-2", name: "bash", arguments: { command: "test 1" } }],
    [{ type: "toolCall", id: "plan-3", name: "edit", arguments: { path: "source.ts" } }],
    [{ type: "toolCall", id: "plan-4", name: "bash", arguments: { command: "test 2" } }],
  ];

  for (const content of turns) {
    await handlers.get("message_end")({ message: { role: "assistant", content } });
  }

  const transformed = markdownTransformers[0](turns[0][0].text, {
    messageType: "assistant",
    isStreaming: false,
    availableWidth: 120,
  });
  const calls = [
    tools.get("edit").renderCall(
      { path: "test.ts" },
      theme,
      { toolCallId: "plan-1", expanded: false, invalidate() {} },
    ),
    tools.get("bash").renderCall(
      { command: "test 1" },
      theme,
      { toolCallId: "plan-2", expanded: false, invalidate() {} },
    ),
    tools.get("edit").renderCall(
      { path: "source.ts" },
      theme,
      { toolCallId: "plan-3", expanded: false, invalidate() {} },
    ),
    tools.get("bash").renderCall(
      { command: "test 2" },
      theme,
      { toolCallId: "plan-4", expanded: false, invalidate() {} },
    ),
  ];

  assert.equal(transformed, "");
  assert.deepEqual(renderText(calls[0]), ["Planning failing test for tool call count bug + 4 tool calls"]);
  assert.deepEqual(calls.slice(1).map((call) => renderText(call)), [[], [], []]);
});

test("clicking a six-call summary expands every call and any card collapses the group", async () => {
  const { tools, handlers } = install();
  const calls = [
    { type: "toolCall", id: "click-1", name: "edit", arguments: { path: "src/use-reading.ts" } },
    { type: "toolCall", id: "click-2", name: "read", arguments: { path: "a.ts" } },
    { type: "toolCall", id: "click-3", name: "read", arguments: { path: "b.ts" } },
    { type: "toolCall", id: "click-4", name: "bash", arguments: { command: "echo test" } },
    { type: "toolCall", id: "click-5", name: "write", arguments: { path: "result.ts" } },
    { type: "toolCall", id: "click-6", name: "edit", arguments: { path: "final.ts" } },
  ];
  await handlers.get("message_end")({ message: { role: "assistant", content: calls.slice(0, 3) } });
  await handlers.get("message_end")({ message: { role: "assistant", content: calls.slice(3) } });
  await handlers.get("message_end")({ message: { role: "assistant", content: [
    { type: "text", text: "Separate work\nin another group" },
    { type: "toolCall", id: "other-group", name: "read", arguments: { path: "other.ts" } },
  ] } });
  const otherGroup = () => tools.get("read").renderCall({ path: "other.ts" }, theme, {
    toolCallId: "other-group", expanded: false, invalidate() {},
  });

  const components = [];
  const contexts = calls.map((call, index) => ({
    toolCallId: call.id,
    expanded: false,
    isPartial: false,
    invalidate() {
      components[index] = tools.get(call.name).renderCall(call.arguments, theme, contexts[index]);
    },
  }));
  contexts.forEach((context) => context.invalidate());
  const visible = () => components.flatMap((component) => renderText(component)).filter(Boolean);
  // Pi's click region toggles only the clicked call unless its renderer handles it.
  const click = (index) => {
    const handled = components[index].handleMouse?.({ type: "click", button: "left" });
    if (!handled?.handled) {
      contexts[index].expanded = !contexts[index].expanded;
      contexts[index].invalidate();
    }
  };

  assert.deepEqual(visible(), ["+ 6 tool calls"]);
  click(0);
  assert.deepEqual(visible(), [
    "edit src/use-reading.ts", "read a.ts", "read b.ts", "$ echo test",
    "write result.ts", "edit final.ts",
  ]);
  assert.deepEqual(renderText(otherGroup()), ["+ 1 tool call"]);
  click(2);
  assert.deepEqual(visible(), ["+ 6 tool calls"]);

  // The global keyboard toggle still uses compact same-tool cards.
  contexts.forEach((context) => {
    context.expanded = true;
    context.invalidate();
  });
  const compactCards = [
    "edit src/use-reading.ts", "read a.ts and 1 file", "$ echo test",
    "write result.ts", "edit final.ts",
  ];
  assert.deepEqual(visible(), compactCards);
  click(0);
  assert.deepEqual(visible(), ["+ 6 tool calls"]);
  contexts.forEach((context) => {
    context.expanded = false;
    context.invalidate();
  });
  assert.deepEqual(visible(), ["+ 6 tool calls"]);
  contexts.forEach((context) => {
    context.expanded = true;
    context.invalidate();
  });
  assert.deepEqual(visible(), compactCards);
});

test("ultra-collapsed view summarizes a streaming call before its group is indexed", () => {
  const bash = install().tools.get("bash");
  const call = bash.renderCall(
    { command: "echo hidden" },
    theme,
    { toolCallId: "bash-streaming", expanded: false, invalidate() {} },
  );

  assert.deepEqual(renderText(call), ["+ 1 tool call"]);
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
    {
      toolCallId: "edit-highlighted",
      expanded: true,
      isPartial: false,
      isError: false,
      invalidate() {},
    },
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
    { toolCallId: "bash-1", expanded: true, invalidate() {} },
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
    { toolCallId: reads[0][0], expanded: true, invalidate() {} },
  );
  const second = read.renderCall(
    { path: reads[1][1] },
    theme,
    { toolCallId: reads[1][0], expanded: true, invalidate() {} },
  );
  assert.equal(read.renderShell, "self");
  assert.deepEqual(renderText(first), ["", "read test/file-search.test.mjs and 4 files", ""]);
  assert.deepEqual(renderText(second), []);
});
