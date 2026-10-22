import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import newSessionCwd from "../extensions/new-session-cwd.ts";

// Run /neww through Pi's real runtime replacement, using catalogue models without provider requests.
test("/neww keeps the active provider, model and reasoning instead of new-session defaults", { timeout: 30_000 }, async () => {
  const cwd = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const directory = await mkdtemp(join(tmpdir(), "sz-neww-runtime-"));
  const logDir = join(homedir(), ".pi", "agent", "logs", "neww-model-validation");
  await mkdir(logDir, { recursive: true });
  const log = { timestamp: new Date().toISOString(), replacements: [] };
  let runtime;
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(directory, "auth.json"), modelsPath: null,
      refreshOnCreate: false, allowModelNetwork: false,
    });
    await modelRuntime.setRuntimeApiKey("openai", "validation-not-a-real-key");
    await modelRuntime.setRuntimeApiKey("anthropic", "validation-not-a-real-key");
    const defaultModel = modelRuntime.getModels("openai").find(model => model.reasoning);
    const activeModel = modelRuntime.getModels("anthropic").find(model => model.reasoning);
    assert.ok(defaultModel);
    assert.ok(activeModel);
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: defaultModel.provider, defaultModel: defaultModel.id, defaultThinkingLevel: "low",
      compaction: { enabled: false }, retry: { enabled: false },
    });
    let cancelNew = false;
    const factory = async ({ sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd, agentDir: directory, settingsManager, modelRuntime,
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [pi => {
            pi.on("session_before_switch", event => {
              if (cancelNew && event.reason === "new") return { cancel: true };
            });
            // Model-default extensions can append settings before the cwd extension starts.
            pi.on("session_start", event => {
              if (event.reason === "new") pi.setThinkingLevel("high");
            });
          }, newSessionCwd],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: [] }),
        services, diagnostics: services.diagnostics };
    };
    runtime = await createAgentSessionRuntime(factory, {
      cwd, agentDir: directory, sessionManager: SessionManager.create(cwd, join(directory, "sessions")),
    });
    const errors = [];
    const bind = session => session.bindExtensions({
      mode: "tui", uiContext: { addAutocompleteProvider() {} },
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: options => runtime.newSession(options),
      },
      onError: error => errors.push(error),
    });
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    await runtime.session.setModel(activeModel);
    runtime.session.setThinkingLevel("high");
    const snapshot = () => ({ provider: runtime.session.model.provider, model: runtime.session.model.id,
      thinkingLevel: runtime.session.thinkingLevel, cwd: runtime.session.sessionManager.getCwd() });
    const expected = { provider: activeModel.provider, model: activeModel.id, thinkingLevel: "high", cwd };
    log.before = snapshot();
    assert.equal(log.before.model, activeModel.id);
    const oldSession = runtime.session;
    cancelNew = true;
    await oldSession.prompt("/neww");
    assert.equal(runtime.session, oldSession);
    assert.deepEqual(snapshot(), expected);
    cancelNew = false;
    await oldSession.prompt("/neww");
    log.replacements.push(snapshot());
    assert.notEqual(runtime.session, oldSession);
    assert.deepEqual(snapshot(), expected);
    assert.deepEqual(runtime.session.messages, []);
    assert.deepEqual(errors, []);
    assert.equal(settingsManager.getDefaultModel(), defaultModel.id);
    assert.equal(settingsManager.getDefaultThinkingLevel(), "low");

    // A second replacement must inherit from the latest session, not an obsolete runtime handle.
    runtime.session.setThinkingLevel("medium");
    await runtime.session.prompt("/neww");
    log.replacements.push(snapshot());
    assert.deepEqual(snapshot(), { ...expected, thinkingLevel: "medium" });
    runtime.session.sessionManager.appendMessage({ role: "user", content: "Persistence check", timestamp: Date.now() });
    const persisted = SessionManager.open(runtime.session.sessionFile).buildSessionContext();
    assert.deepEqual(persisted.model, { provider: activeModel.provider, modelId: activeModel.id });
    assert.equal(persisted.thinkingLevel, "medium");

    // Resume must honor subsequent manual changes, not replay the original inheritance marker.
    await runtime.session.setModel(defaultModel);
    runtime.session.setThinkingLevel("low");
    await runtime.switchSession(runtime.session.sessionFile);
    assert.deepEqual(snapshot(), { ...expected, provider: defaultModel.provider, model: defaultModel.id, thinkingLevel: "low" });
    assert.deepEqual(errors, []);
    log.passed = true;
  } catch (error) {
    log.passed = false;
    await writeFile(join(logDir, "crash-report.txt"), error.stack ?? String(error), "utf8");
    throw error;
  } finally {
    await runtime?.dispose();
    await writeFile(join(logDir, "latest.json"), JSON.stringify(log, null, 2) + "\n", "utf8");
    await rm(directory, { recursive: true, force: true });
  }
});
