import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createArtifactLinkExtension } from '../extensions/artifact-link.ts';

const exec = promisify(execFile);
const python = process.platform === 'win32' ? 'python' : 'python3';
const scripts = new URL('../scripts/artifact-preview/', import.meta.url);

// Invoke the registered Pi tool against the real standalone service, not a mocked publisher.
async function setup(t) {
  const folder = await mkdtemp(join(tmpdir(), 'artifact-link-test-'));
  const agentDir = join(folder, 'agent');
  const cwd = join(folder, 'project');
  await mkdir(join(cwd, 'data', 'previews'), { recursive: true });
  await writeFile(join(cwd, 'data', 'previews', '方案 one.html'), '<h1>Remote preview</h1>', 'utf8');
  const state = join(agentDir, 'artifact-preview', 'server.json');
  let tool;
  const events = new Map();
  createArtifactLinkExtension(agentDir)({
    registerTool(value) { tool = value; },
    on(event, handler) { events.set(event, handler); },
  });
  t.after(async () => {
    try {
      if (existsSync(state)) await exec(python, ['-B', fileURLToPath(new URL('stop.py', scripts)), '--state', state], { timeout: 15_000 });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  await exec(python, ['-B', fileURLToPath(new URL('start.py', scripts)), '--state', state, '--port', '0'], { timeout: 15_000 });
  return { tool, events, cwd, agentDir, state };
}

test('artifact_link returns a usable encoded browser link for the current project', async (t) => {
  const { tool, cwd } = await setup(t);
  assert.equal(tool.name, 'artifact_link');
  const result = await tool.execute('call-1', { path: 'data/previews/方案 one.html' }, new AbortController().signal, undefined, { cwd });
  assert.match(result.structuredContent.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/%E6%96%B9%E6%A1%88%20one\.html$/);
  assert.ok(result.content[0].text.includes(result.structuredContent.url));
  assert.equal(await (await fetch(result.structuredContent.url)).text(), '<h1>Remote preview</h1>');
});

test('active service instructs existing Herdr sessions to hand off HTTP links before asking', async (t) => {
  const { events } = await setup(t);
  const event = { systemPromptOptions: { promptGuidelines: ['Keep existing guidance'] } };
  await events.get('before_agent_start')(event);
  assert.equal(event.systemPromptOptions.promptGuidelines[0], 'Keep existing guidance');
  assert.match(event.systemPromptOptions.promptGuidelines[1], /HTTP URL, including before ask_user/);
  assert.match(event.systemPromptOptions.promptGuidelines[1], /replace local paths and file:\/\/\/ handoff links/);
});

test('a stale readiness marker does not tell agents to use a dead service', async (t) => {
  const { events, state } = await setup(t);
  const metadata = await readFile(state, 'utf8');
  await exec(python, ['-B', fileURLToPath(new URL('stop.py', scripts)), '--state', state], { timeout: 15_000 });
  await writeFile(state, metadata, { mode: 0o600 });
  await writeFile(state.replace(/\.json$/, '.ready'), '');
  const event = { systemPromptOptions: { promptGuidelines: ['Unchanged'] } };
  await events.get('before_agent_start')(event);
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, ['Unchanged']);
});

test('publication errors are explicit and persist stack traces without control credentials', async (t) => {
  const { tool, cwd, agentDir, state } = await setup(t);
  await assert.rejects(tool.execute('bad-file', { path: 'package.json' }, new AbortController().signal, undefined, { cwd }),
    /Place artifacts and their assets in data\/previews or .pi\/artifacts/);
  const log = await readFile(join(agentDir, 'logs', 'artifact-link.log'), 'utf8');
  assert.match(log, /Error: Artifact publication failed \(HTTP 400\)/);
  assert.match(log, /at /);
  assert.ok(!log.includes(JSON.parse(await readFile(state, 'utf8')).token));
});

test('missing service does not alter ordinary sessions and fails with setup guidance', async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), 'artifact-link-missing-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  let tool;
  const events = new Map();
  createArtifactLinkExtension(agentDir)({ registerTool(value) { tool = value; }, on(event, handler) { events.set(event, handler); } });
  const event = { systemPromptOptions: { promptGuidelines: ['Unchanged'] } };
  await events.get('before_agent_start')(event);
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, ['Unchanged']);
  await assert.rejects(tool.execute('no-service', { path: 'data/previews/report.html' }, new AbortController().signal, undefined, { cwd: agentDir }), /Reconnect with scripts\/ssh-clipboard\/ssh.py/);
  assert.match(await readFile(join(agentDir, 'logs', 'artifact-link.log'), 'utf8'), /Error: Artifact preview service is not running/);
});
