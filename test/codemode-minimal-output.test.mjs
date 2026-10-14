import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { codemodeRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/renderer.js";
import minimalToolOutputExtension from "../extensions/minimal-tool-output.ts";
import { withMinimalSubagentOutput } from "../lib/subagent-tool-output.ts";

initTheme(undefined, false);

function install(branch = [], configure = () => {}) {
  const tools = new Map();
  const handlers = new Map();
  const resolvers = [];
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerToolRenderer(resolver) { resolvers.push(resolver); },
    registerMarkdownTransformer() {},
    on(event, handler) { handlers.set(event, handler); },
  };
  minimalToolOutputExtension(pi);
  configure(pi);
  handlers.get("session_start")({}, { sessionManager: { getBranch: () => branch } });
  const resolve = (name, index = 0) => index < resolvers.length
    ? resolvers[index](name, () => resolve(name, index + 1))
    : tools.get(name) ?? (name === "codemode" ? codemodeRenderers : undefined);
  const row = (name, id, args) => new ToolExecutionComponent(
    name, id, args, { showImages: false }, resolve(name), { requestRender() {} }, process.cwd(),
  );
  return { tools, handlers, row };
}

function visible(...rows) {
  return rows.flatMap((row) => row.render(160))
    .map((line) => stripVTControlCharacters(line).trim()).filter(Boolean);
}

const script = 'text(await tools.read({path:"src/app.ts"})); text(await tools.ls({path:"src"}));';
const calls = [
  { id: "batch/1", name: "read", args: '{"path":"src/app.ts"}', status: "ok" },
  { id: "batch/2", name: "ls", args: '{"path":"src"}', status: "ok" },
];
const result = {
  content: [{ type: "text", text: "PRIVATE_RESULT_BODY" }],
  details: { calls },
};

test("codemode hides its script and output and counts nested calls instead of its wrapper", async () => {
  const { handlers, row } = install();
  await handlers.get("message_end")({ message: { role: "assistant", content: [
    { type: "toolCall", id: "batch", name: "codemode", arguments: { code: script } },
  ] } });
  const batch = row("codemode", "batch", { code: script });
  batch.updateResult(result);
  assert.deepEqual(visible(batch), ["+ 2 tool calls"]);
  batch.setExpanded(true);
  assert.deepEqual(visible(batch), ["read src/app.ts", "ls src"]);
  batch.setExpanded(false);
  assert.deepEqual(visible(batch), ["+ 2 tool calls"]);
});

test("codemode live progress updates the shared direct-tool summary and survives restore", async () => {
  const direct = { type: "toolCall", id: "direct", name: "read", arguments: { path: "README.md" } };
  const batchCall = { type: "toolCall", id: "batch", name: "codemode", arguments: { code: script } };
  const branch = [
    { type: "message", message: { role: "assistant", content: [direct, batchCall] } },
    { type: "message", message: { role: "toolResult", toolName: "codemode", toolCallId: "batch", ...result } },
  ];
  const { handlers, row } = install();
  await handlers.get("message_end")({ message: branch[0].message });
  const read = row("read", "direct", direct.arguments);
  const batch = row("codemode", "batch", batchCall.arguments);
  read.updateResult({ content: [], details: {} });
  batch.updateResult({ content: [], details: { calls: [calls[0]] } }, true);
  assert.deepEqual(visible(read, batch), ["+ 2 tool calls"]);
  batch.updateResult(result);
  assert.deepEqual(visible(read, batch), ["+ 3 tool calls"]);

  const restored = install(branch);
  const restoredRead = restored.row("read", "direct", direct.arguments);
  const restoredBatch = restored.row("codemode", "batch", batchCall.arguments);
  assert.deepEqual(visible(restoredRead, restoredBatch), ["+ 3 tool calls"]);
  restoredBatch.updateResult(result);
  assert.deepEqual(visible(restoredRead, restoredBatch), ["+ 3 tool calls"]);
});

test("clicking a summary reveals every nested call and a nested card collapses the whole group", async () => {
  const { handlers, row } = install();
  await handlers.get("message_end")({ message: { role: "assistant", content: [
    { type: "toolCall", id: "batch", name: "codemode", arguments: { code: script } },
    { type: "toolCall", id: "direct", name: "read", arguments: { path: "README.md" } },
  ] } });
  const batch = row("codemode", "batch", { code: script });
  const read = row("read", "direct", { path: "README.md" });
  batch.updateResult({ ...result, details: { calls: [calls[0], { ...calls[1], name: "read", args: '{"path":"src/other.ts"}' }] } });
  read.updateResult({ content: [], details: {} });
  assert.deepEqual(visible(batch, read), ["+ 3 tool calls"]);
  assert.equal(batch.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 160, height: batch.render(160).length })?.handled, true);
  assert.deepEqual(visible(batch, read), ["read src/app.ts", "read src/other.ts", "read README.md"]);
  // Click the second nested card rather than the parent's first line.
  assert.equal(batch.handleMouse({ type: "click", button: "left", x: 2, y: 6, width: 160, height: batch.render(160).length })?.handled, true);
  assert.deepEqual(visible(batch, read), ["+ 3 tool calls"]);
  batch.setExpanded(true);
  read.setExpanded(true);
  assert.deepEqual(visible(batch, read), ["read src/app.ts", "read src/other.ts", "read README.md"]);
});

test("minimized codemode reports running, failed, and cancelled nested calls without exposing their bodies", async () => {
  const { handlers, row } = install();
  await handlers.get("message_end")({ message: { role: "assistant", content: [
    { type: "toolCall", id: "batch", name: "codemode", arguments: { code: script } },
  ] } });
  const batch = row("codemode", "batch", { code: script });
  batch.updateResult({ content: [], details: { calls: [
    { ...calls[0], status: "running" }, { ...calls[1], status: "error", error: "PRIVATE_ERROR" },
  ] } }, true);
  assert.deepEqual(visible(batch), ["+ 2 tool calls · 1 running · 1 failed"]);
  batch.updateResult({ ...result, details: { calls: [
    calls[0], { ...calls[1], status: "cancelled" },
  ] } });
  assert.deepEqual(visible(batch), ["+ 2 tool calls · 1 cancelled"]);
});

test("nested skill and subagent exceptions stay visible and compact arguments survive truncated previews and restore", async () => {
  const configure = (pi) => pi.registerTool(withMinimalSubagentOutput({
    name: "subagent_spawn", parameters: {}, execute() {},
  }));
  const { handlers, row } = install([], configure);
  const batchCall = { type: "toolCall", id: "batch", name: "codemode", arguments: { code: script } };
  await handlers.get("message_end")({ message: { role: "assistant", content: [batchCall] } });
  const nested = [
    { id: "batch/1", name: "write", input: { path: "src/new.ts", content: "PRIVATE_WRITE_CONTENT".repeat(30) } },
    { id: "batch/2", name: "read", input: { path: "C:/skills/example/SKILL.md" } },
    { id: "batch/3", name: "subagent_spawn", input: { prompt: "PRIVATE_PROMPT".repeat(30), name: "review", harness: "pi", reasoning_effort: "low" } },
  ];
  for (const call of nested) {
    await handlers.get("tool_call")({ toolCallId: call.id, parentToolCallId: "batch", toolName: call.name, input: call.input });
    await handlers.get("tool_result")({
      toolCallId: call.id, parentToolCallId: "batch", toolName: call.name, input: call.input,
      content: [{ type: "text", text: call.name === "read" ? "---\nname: declared-skill\n---\nPRIVATE_SKILL_BODY" : "PRIVATE_NESTED_RESULT" }],
      details: call.name === "subagent_spawn" ? { subagentModel: "openai-codex/gpt-6-astra" } : {}, isError: false,
    });
  }
  const completed = { ...result, details: { calls: nested.map(({ id, name, input }) => ({
    id, name, args: JSON.stringify(input).slice(0, 100), status: "ok",
  })) } };
  const hookResult = await handlers.get("tool_result")({
    toolName: "codemode", toolCallId: "batch", input: batchCall.arguments, ...completed, isError: false,
  });
  const persisted = { ...completed, ...hookResult };
  assert.equal(persisted.content, completed.content, "model-facing output must be unchanged");
  assert.doesNotMatch(JSON.stringify(hookResult.details.minimalCalls), /PRIVATE_/);
  const batch = row("codemode", "batch", batchCall.arguments);
  batch.updateResult(persisted);
  assert.deepEqual(visible(batch), ["+ 3 tool calls", "[skill] declared-skill", "subagent_spawn review with pi · gpt-6-astra · low"]);
  batch.setExpanded(true);
  assert.deepEqual(visible(batch), ["write src/new.ts", "[skill] declared-skill", "subagent_spawn review with pi · gpt-6-astra · low"]);

  const restored = install([
    { type: "message", message: { role: "assistant", content: [batchCall] } },
    { type: "message", message: { role: "toolResult", toolName: "codemode", toolCallId: "batch", ...persisted } },
  ], configure);
  const restoredBatch = restored.row("codemode", "batch", batchCall.arguments);
  restoredBatch.updateResult(persisted);
  restoredBatch.setExpanded(true);
  assert.deepEqual(visible(restoredBatch), ["write src/new.ts", "[skill] declared-skill", "subagent_spawn review with pi · gpt-6-astra · low"]);
});

test("scripts without nested calls keep a compact codemode line and script failures remain visible", async () => {
  const { handlers, row } = install();
  await handlers.get("message_end")({ message: { role: "assistant", content: [
    { type: "toolCall", id: "empty", name: "codemode", arguments: { code: 'text("PRIVATE_OUTPUT")' } },
  ] } });
  const empty = row("codemode", "empty", { code: 'text("PRIVATE_OUTPUT")' });
  empty.updateResult({ content: [{ type: "text", text: "PRIVATE_OUTPUT" }], details: { calls: [] } });
  assert.deepEqual(visible(empty), ["codemode"]);
  empty.updateResult({ content: [{ type: "text", text: "PRIVATE_STACK_TRACE" }], details: { calls: [] }, isError: true });
  assert.deepEqual(visible(empty), ["codemode · script failed"]);

  const batch = row("codemode", "batch", { code: script });
  batch.updateResult({ ...result, isError: true });
  assert.deepEqual(visible(batch), ["+ 2 tool calls · script failed"]);
  batch.setExpanded(true);
  assert.deepEqual(visible(batch), ["codemode · script failed", "read src/app.ts", "ls src"]);
});
