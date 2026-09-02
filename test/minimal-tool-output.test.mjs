import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import fileSearchExtension from "../extensions/file-search.ts";
import minimalToolOutputExtension from "../extensions/minimal-tool-output.ts";
import {
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
  assert.match(renderText(skillResult).join("\n"), /\[skill\] tdd .*expand/);
  assert.match(renderText(expandedSkillResult).join("\n"), /Write a failing test first\./);
  assert.doesNotMatch(renderText(expandedSkillResult).join("\n"), /description:/);
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
    /\[skill\] grill-with-docs, grilling, domain-modeling, unslop .*expand/,
  );
  assert.deepEqual(rendered.slice(1).map((component) => renderText(component)), [[], [], []]);
  assert.deepEqual([...new Set(backgroundColors)], ["customMessageBg"]);
  assert.equal(expanded.filter((component) => /Instructions/.test(renderText(component).join("\n"))).length, 4);
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

test("ultra-collapsed view includes subagent tools in one tool-call count", async () => {
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
      arguments: { prompt: "Review the change", name: "review", harness: "pi" },
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

  assert.deepEqual(renderText(spawnCall), ["Delegating the review + 2 tool calls"]);
  assert.deepEqual(renderText(readCall), []);
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
