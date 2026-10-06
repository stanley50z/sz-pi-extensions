import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, initTheme,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import minimalToolOutputExtension from "../extensions/minimal-tool-output.ts";

// Run the real session, sandbox, nested tools, and renderer with a scripted model boundary.
test("real codemode reads repository files without displaying its script or returned bodies", { timeout: 30_000 }, async () => {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const agentDir = await mkdtemp(join(tmpdir(), "sz-codemode-runtime-"));
  const logDir = join(homedir(), ".pi", "agent", "logs", "codemode-minimal-validation");
  await mkdir(logDir, { recursive: true });
  const log = { timestamp: new Date().toISOString(), events: [], views: {} };
  let session;
  try {
    initTheme(undefined, false);
    const settingsManager = SettingsManager.inMemory({
      defaultTools: ["read", "ls", "codemode"],
      compaction: { enabled: false }, retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [minimalToolOutputExtension, createCodemodeExtension()],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: null,
      refreshOnCreate: false, allowModelNetwork: false,
    });
    // No network call occurs. This credential only satisfies the session's auth preflight.
    await modelRuntime.setRuntimeApiKey("openai", "validation-not-a-real-key");
    const model = modelRuntime.getModels("openai")[0];
    assert.ok(model);
    ({ session } = await createAgentSession({
      cwd, agentDir, resourceLoader, settingsManager, modelRuntime, model,
      sessionManager: SessionManager.inMemory(cwd), tools: ["read", "ls", "codemode"],
    }));
    await session.bindExtensions({});
    const code = 'const r = await Promise.all([tools.read({path:"package.json"}), tools.read({path:"README.md"})]); r.forEach(text);';
    let requests = 0;
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      const first = requests++ === 0;
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: first
          ? [{ type: "toolCall", id: "runtime-batch", name: "codemode", arguments: { code } }]
          : [{ type: "text", text: "Validation complete." }],
        stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "start", partial: message });
      if (first) stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    };
    session.subscribe((event) => {
      if (event.type.startsWith("tool_execution_")) {
        log.events.push({ type: event.type, toolName: event.toolName, parentToolCallId: event.parentToolCallId });
      }
    });
    await session.prompt("Run the codemode renderer validation.");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
    assert.ok(result, "real session must execute codemode");
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(result.details.calls.length, 2);
    assert.equal(result.details.minimalCalls.length, 2);
    const output = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    assert.ok(output.includes(await readFile(join(cwd, "package.json"), "utf8")));
    assert.ok(output.includes(await readFile(join(cwd, "README.md"), "utf8")));
    const renderers = session.extensionRunner.resolveToolRenderers("codemode", () => undefined);
    const row = new ToolExecutionComponent("codemode", "runtime-batch", { code }, { showImages: false }, renderers, { requestRender() {} }, cwd);
    row.updateResult(result);
    const visible = () => row.render(160).map((line) => stripVTControlCharacters(line).trim()).filter(Boolean);
    log.views.minimized = visible();
    assert.deepEqual(log.views.minimized, ["+ 2 tool calls"]);
    row.handleMouse({ type: "click", button: "left", x: 1, y: 1, width: 160, height: row.render(160).length });
    log.views.expanded = visible();
    assert.deepEqual(log.views.expanded, ["read package.json", "read README.md"]);
    row.handleMouse({ type: "click", button: "left", x: 1, y: 5, width: 160, height: row.render(160).length });
    log.views.recollapsed = visible();
    assert.deepEqual(log.views.recollapsed, ["+ 2 tool calls"]);
    log.passed = true;
  } catch (error) {
    log.passed = false;
    await writeFile(join(logDir, "crash-report.txt"), error.stack ?? String(error), "utf8");
    throw error;
  } finally {
    session?.dispose();
    await writeFile(join(logDir, "latest.json"), JSON.stringify(log, null, 2) + "\n", "utf8");
    await rm(agentDir, { recursive: true, force: true });
  }
});
