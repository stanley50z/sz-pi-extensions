import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import sessionAutoName from '../extensions/session-auto-name.ts';

// Exercise cancellation, request-time authentication, and title persistence in the real Pi runtime.
test('a stopped agent turn still generates and persists a session name', { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'sz-auto-name-runtime-'));
  const logDir = join(homedir(), '.pi', 'agent', 'logs', 'session-auto-name-validation');
  await mkdir(logDir, { recursive: true });
  const log = { events: [], errors: [], namingRequests: 0 };
  let session;
  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false },
    });
    const providerModel = {
      id: 'title-test', name: 'Title test', api: 'title-test-api', reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000, maxTokens: 512,
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        (pi) => pi.registerProvider('title-test-provider', {
          api: 'title-test-api', baseUrl: 'https://example.invalid',
          apiKey: 'validation-not-a-real-key', models: [providerModel],
          streamSimple: (model, _context, options) => {
            log.namingRequests += 1;
            assert.equal(options?.signal?.aborted ?? false, false);
            return responseStream(model, 'Fix session auto naming');
          },
        }),
        sessionAutoName,
      ],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(cwd, 'auth.json'), modelsPath: null,
      refreshOnCreate: false, allowModelNetwork: false,
    });
    const sessionManager = SessionManager.create(cwd, cwd);
    ({ session } = await createAgentSession({
      cwd, agentDir: cwd, resourceLoader, settingsManager, modelRuntime,
      sessionManager, model: { ...providerModel, provider: 'title-test-provider', baseUrl: '' },
      tools: [],
    }));
    assert.ok(modelRuntime.getProvider('title-test-provider'), 'test provider must register');
    await session.bindExtensions({ onError: (error) => log.errors.push(error) });
    await modelRuntime.setRuntimeApiKey('title-test-provider', 'validation-not-a-real-key');
    session.agent.streamFunction = (model) => responseStream(model, 'I will inspect session auto naming.');
    let cancelled = false;
    session.subscribe((event) => {
      if (['message_end', 'agent_end', 'agent_settled'].includes(event.type)) log.events.push(event.type);
      if (!cancelled && event.type === 'message_end' && event.message.role === 'assistant') {
        cancelled = true;
        session.agent.abort();
        assert.equal(session.agent.signal.aborted, true);
      }
    });
    await session.prompt('Fix session auto naming.');
    assert.equal(cancelled, true);
    log.name = sessionManager.getSessionName();
    assert.equal(log.name, 'Fix session auto naming', JSON.stringify(log));
    assert.equal(log.namingRequests, 1);
    assert.deepEqual(log.errors, []);
    const entries = (await readFile(sessionManager.getSessionFile(), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(entries.findLast((entry) => entry.type === 'session_info').name, 'Fix session auto naming');
    assert.equal(entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user').length, 1);
    assert.equal(entries.filter((entry) => entry.type === 'message' && entry.message.role === 'assistant').length, 1);
    log.passed = true;
  } catch (error) {
    log.passed = false;
    await writeFile(join(logDir, 'crash-report.txt'), error.stack ?? String(error), 'utf8');
    throw error;
  } finally {
    session?.dispose();
    await writeFile(join(logDir, 'latest.json'), JSON.stringify(log, null, 2) + '\n', 'utf8');
    await rm(cwd, { recursive: true, force: true });
  }
});

// Supply deterministic responses at the external model-service boundary without paid requests.
function responseStream(model, text) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'done', reason: 'stop', message });
  stream.end();
  return stream;
}
