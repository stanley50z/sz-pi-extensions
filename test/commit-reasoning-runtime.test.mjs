import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';

// Exercise the real prompt, skill expansion, reasoning clamp and settling lifecycle without running git.
test('real Pi commit prompts retain the model and restore reasoning after success, failure and abort', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sz-commit-reasoning-'));
  const logDir = join(homedir(), '.pi', 'agent', 'logs', 'commit-reasoning-validation');
  await mkdir(logDir, { recursive: true });
  const log = { timestamp: new Date().toISOString(), runs: [] };
  let session;
  try {
    const skillPath = join(directory, 'commit', 'SKILL.md');
    await mkdir(join(directory, 'commit'));
    await writeFile(skillPath, '---\nname: commit\ndescription: Commit validation\n---\nReport validation complete. Do not run git.\n', 'utf8');
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager,
      additionalExtensionPaths: [fileURLToPath(new URL('../extensions/skill-invocation.ts', import.meta.url))],
      additionalSkillPaths: [skillPath],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.equal(resourceLoader.getSkills().skills[0]?.name, 'commit');
    const modelRuntime = await ModelRuntime.create({
      authPath: join(directory, 'auth.json'), modelsPath: null,
      refreshOnCreate: false, allowModelNetwork: false,
    });
    // This credential only satisfies auth preflight. All model responses are scripted below.
    await modelRuntime.setRuntimeApiKey('anthropic', 'validation-not-a-real-key');
    const model = getModel('anthropic', 'claude-opus-5-5');
    ({ session } = await createAgentSession({
      cwd: directory, agentDir: directory, resourceLoader, settingsManager, modelRuntime,
      model, thinkingLevel: 'high', sessionManager: SessionManager.inMemory(directory), tools: [],
    }));
    const errors = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    for (const outcome of ['stop', 'error', 'aborted']) {
      const run = { outcome, requests: [] };
      log.runs.push(run);
      session.agent.streamFunction = (requestModel, context, options) => {
        run.requests.push({ model: requestModel.id, provider: requestModel.provider, reasoning: options.reasoning });
        assert.equal(requestModel, model);
        assert.equal(options.reasoning, 'low');
        assert.ok(context.messages.some((message) => message.role === 'user'
          && message.content.some((block) => block.type === 'text' && block.text.includes('<skill name="commit"'))));
        const stream = createAssistantMessageEventStream();
        const message = {
          role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [{ type: 'text', text: 'Validation complete.' }],
          stopReason: outcome, timestamp: Date.now(),
          ...(outcome !== 'stop' ? { errorMessage: 'Scripted validation failure' } : {}),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: 'start', partial: message });
        if (outcome === 'stop') stream.push({ type: 'done', reason: 'stop', message });
        else stream.push({ type: 'error', reason: outcome, error: message });
        stream.end();
        return stream;
      };
      await session.prompt(outcome === 'stop' ? '$commit' : '/skill:commit');
      await session.waitForIdle();
      assert.equal(run.requests.length, 1);
      assert.equal(session.model, model);
      assert.equal(session.thinkingLevel, 'high');
      assert.equal(session.messages.at(-1).stopReason, outcome);
      run.restoredReasoning = session.thinkingLevel;
    }
    assert.deepEqual(errors, []);
    assert.equal(session.sessionManager.getBranch().filter((entry) => entry.type === 'model_change').length, 1);
    log.passed = true;
  } catch (error) {
    log.passed = false;
    await writeFile(join(logDir, 'crash-report.txt'), error.stack ?? String(error), 'utf8');
    throw error;
  } finally {
    session?.dispose();
    await writeFile(join(logDir, 'latest.json'), JSON.stringify(log, null, 2) + '\n', 'utf8');
    await rm(directory, { recursive: true, force: true });
  }
});
