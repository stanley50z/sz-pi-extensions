import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../extensions/launch-mode.ts', import.meta.url).href;

function createAgentDir() {
  return mkdtempSync(join(tmpdir(), 'pi-launch-mode-'));
}

function createFakePi() {
  const commands = new Map();
  const handlers = new Map();
  return {
    commands,
    handlers,
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
}

function createFakeContext(selection) {
  const selections = [];
  const statuses = [];
  const notifications = [];
  return {
    hasUI: true,
    mode: 'tui',
    selections,
    statuses,
    notifications,
    reloads: 0,
    sessionManager: { getEntries: () => [] },
    async reload() {
      this.reloads += 1;
    },
    ui: {
      async select(title, options) {
        selections.push({ title, options });
        return selection;
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
      setStatus(key, text) {
        statuses.push({ key, text });
      },
    },
  };
}

async function install(agentDir) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { default: installLaunchMode } = await import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
    const pi = createFakePi();
    installLaunchMode(pi);
    return pi;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test('first interactive start offers launch presets and remembers the selected mode', async () => {
  const agentDir = createAgentDir();
  const pi = await install(agentDir);
  const ctx = createFakeContext('Lark');

  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);

  assert.deepEqual(ctx.selections, [{
    title: 'Launch mode',
    options: ['Core', 'Lark', 'Remotion', 'Lark + Remotion'],
  }]);
  assert.equal(JSON.parse(readFileSync(join(agentDir, 'launch-modes.json'), 'utf8')).activeMode, 'lark');
  assert.deepEqual(ctx.statuses.at(-1), { key: 'launch-mode', text: 'mode:lark' });
});

test('non-interactive startup does not consume the first interactive selection', async () => {
  const agentDir = createAgentDir();
  const pi = await install(agentDir);
  const ctx = createFakeContext('Lark');
  ctx.hasUI = false;
  ctx.mode = 'print';

  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);

  assert.equal(existsSync(join(agentDir, 'launch-modes.json')), false);
  assert.deepEqual(ctx.selections, []);
  assert.deepEqual(ctx.statuses.at(-1), { key: 'launch-mode', text: 'mode:core' });
});

test('later sessions reuse the remembered mode and discover only that suite', async () => {
  const agentDir = createAgentDir();
  const skillRoot = join(agentDir, 'optional-skills');
  const captions = join(skillRoot, 'remotion-captions');
  const render = join(skillRoot, 'remotion-render');
  mkdirSync(captions, { recursive: true });
  mkdirSync(render, { recursive: true });
  writeFileSync(join(captions, 'SKILL.md'), '---\nname: remotion-captions\ndescription: captions\n---\n');
  writeFileSync(join(render, 'SKILL.md'), '---\nname: remotion-render\ndescription: render\n---\n');
  writeFileSync(join(agentDir, 'launch-modes.json'), JSON.stringify({
    activeMode: 'remotion',
    modes: {
      core: { label: 'Core', description: 'Core', skillPaths: [] },
      remotion: {
        label: 'Remotion',
        description: 'Remotion suite',
        skillPaths: [join(skillRoot, 'remotion-*')],
      },
    },
  }));

  const pi = await install(agentDir);
  const ctx = createFakeContext('Core');
  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
  const discovered = await pi.handlers.get('resources_discover')({ reason: 'startup' }, ctx);

  assert.deepEqual(ctx.selections, []);
  assert.deepEqual(discovered.skillPaths, [captions, render]);
  assert.deepEqual(ctx.statuses.at(-1), { key: 'launch-mode', text: 'mode:remotion' });
});

test('/launch-mode changes the remembered profile and reloads session resources', async () => {
  const agentDir = createAgentDir();
  writeFileSync(join(agentDir, 'launch-modes.json'), JSON.stringify({
    activeMode: 'core',
    modes: {
      core: { label: 'Core', description: 'Core', skillPaths: [] },
      remotion: { label: 'Remotion', description: 'Remotion', skillPaths: [] },
    },
  }));
  const pi = await install(agentDir);
  const ctx = createFakeContext('Remotion');

  await pi.commands.get('launch-mode').handler('', ctx);

  assert.equal(JSON.parse(readFileSync(join(agentDir, 'launch-modes.json'), 'utf8')).activeMode, 'remotion');
  assert.equal(ctx.reloads, 1);
  assert.deepEqual(ctx.notifications.at(-1), { message: 'Launch mode changed to Remotion', type: 'info' });
});

test('the model context contains the selected suite but not disabled suites', async () => {
  const agentDir = createAgentDir();
  const skillRoot = join(agentDir, 'skills');
  const larkDir = join(skillRoot, 'lark-doc');
  const remotionDir = join(skillRoot, 'remotion-render');
  mkdirSync(larkDir, { recursive: true });
  mkdirSync(remotionDir, { recursive: true });
  writeFileSync(join(agentDir, 'launch-modes.json'), JSON.stringify({
    activeMode: 'lark',
    modes: {
      core: { label: 'Core', description: 'Core', skillPaths: [] },
      lark: { label: 'Lark', description: 'Lark', skillPaths: [join(skillRoot, 'lark-*')] },
      remotion: { label: 'Remotion', description: 'Remotion', skillPaths: [join(skillRoot, 'remotion-*')] },
    },
  }));
  const skills = [
    { name: 'research', description: 'Research', filePath: join(skillRoot, 'research', 'SKILL.md') },
    { name: 'lark-doc', description: 'Lark docs', filePath: join(larkDir, 'SKILL.md') },
    { name: 'remotion-render', description: 'Render video', filePath: join(remotionDir, 'SKILL.md') },
  ];
  const originalSkillBlock = `\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>research</name>\n    <description>Research</description>\n    <location>${skills[0].filePath}</location>\n  </skill>\n  <skill>\n    <name>lark-doc</name>\n    <description>Lark docs</description>\n    <location>${skills[1].filePath}</location>\n  </skill>\n  <skill>\n    <name>remotion-render</name>\n    <description>Render video</description>\n    <location>${skills[2].filePath}</location>\n  </skill>\n</available_skills>`;

  const pi = await install(agentDir);
  const result = await pi.handlers.get('before_agent_start')({
    systemPrompt: `base${originalSkillBlock}`,
    systemPromptOptions: { skills },
  }, createFakeContext());

  assert.match(result.systemPrompt, /<name>research<\/name>/);
  assert.match(result.systemPrompt, /<name>lark-doc<\/name>/);
  assert.doesNotMatch(result.systemPrompt, /remotion-render/);
});
