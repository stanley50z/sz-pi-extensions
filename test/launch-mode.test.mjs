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

function createMultiSelectContext(inputs) {
  const ctx = createFakeContext();
  const renders = [];
  ctx.renders = renders;
  ctx.ui.custom = async (factory) => {
    let completed = false;
    let result;
    const theme = {
      fg: (_color, text) => text,
      bg: (_color, text) => text,
      bold: (text) => text,
    };
    const keybindings = {
      matches(data, action) {
        return (action === 'tui.select.up' && data === '\x1b[A')
          || (action === 'tui.select.down' && data === '\x1b[B')
          || (action === 'tui.select.confirm' && data === '\r')
          || (action === 'tui.select.cancel' && data === '\x1b');
      },
    };
    const component = factory(
      { requestRender() { renders.push(component.render(80)); } },
      theme,
      keybindings,
      (value) => { completed = true; result = value; },
    );
    renders.push(component.render(80));
    for (const input of inputs) component.handleInput(input);
    assert.equal(completed, true, 'multi-select dialog did not close');
    return result;
  };
  return ctx;
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

test('first interactive start keeps Core selected and adds multiple suites with Space', async () => {
  const agentDir = createAgentDir();
  const pi = await install(agentDir);
  const ctx = createMultiSelectContext(['\x1b[B', ' ', '\x1b[B', ' ', '\r']);

  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);

  assert.match(ctx.renders[0].join('\n'), /\[✓\] Core .*always on/);
  assert.match(ctx.renders[0].join('\n'), /\[ \] Remotion/);
  assert.match(ctx.renders[0].join('\n'), /\[ \] Lark/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(agentDir, 'launch-modes.json'), 'utf8')).selectedSuites,
    ['remotion', 'lark'],
  );
  assert.deepEqual(ctx.statuses, []);
});

test('Core cannot be toggled off with Space', async () => {
  const agentDir = createAgentDir();
  const pi = await install(agentDir);
  const ctx = createMultiSelectContext([' ', '\r']);

  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);

  assert.deepEqual(
    JSON.parse(readFileSync(join(agentDir, 'launch-modes.json'), 'utf8')).selectedSuites,
    [],
  );
  assert.match(ctx.renders.at(-1).join('\n'), /\[✓\] Core .*always on/);
  assert.deepEqual(ctx.statuses, []);
});

test('legacy single-choice All mode migrates to both selected suites', async () => {
  const agentDir = createAgentDir();
  writeFileSync(join(agentDir, 'launch-modes.json'), JSON.stringify({
    activeMode: 'all',
    modes: {},
  }));

  const pi = await install(agentDir);
  const ctx = createFakeContext();
  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);

  assert.deepEqual(
    JSON.parse(readFileSync(join(agentDir, 'launch-modes.json'), 'utf8')).selectedSuites,
    ['remotion', 'lark'],
  );
  assert.deepEqual(ctx.statuses, []);
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
  assert.deepEqual(ctx.statuses, []);
});

test('later sessions reuse both remembered suites and discover both skill sets', async () => {
  const agentDir = createAgentDir();
  const skillRoot = join(agentDir, 'optional-skills');
  const captions = join(skillRoot, 'remotion-captions');
  const render = join(skillRoot, 'remotion-render');
  const larkDoc = join(skillRoot, 'lark-doc');
  mkdirSync(captions, { recursive: true });
  mkdirSync(render, { recursive: true });
  mkdirSync(larkDoc, { recursive: true });
  writeFileSync(join(captions, 'SKILL.md'), '---\nname: remotion-captions\ndescription: captions\n---\n');
  writeFileSync(join(render, 'SKILL.md'), '---\nname: remotion-render\ndescription: render\n---\n');
  writeFileSync(join(larkDoc, 'SKILL.md'), '---\nname: lark-doc\ndescription: docs\n---\n');
  writeFileSync(join(agentDir, 'launch-modes.json'), JSON.stringify({
    selectedSuites: ['remotion', 'lark'],
    suites: {
      remotion: {
        label: 'Remotion',
        description: 'Remotion suite',
        skillPaths: [join(skillRoot, 'remotion-*')],
      },
      lark: {
        label: 'Lark',
        description: 'Lark suite',
        skillPaths: [join(skillRoot, 'lark-*')],
      },
    },
  }));

  const pi = await install(agentDir);
  const ctx = createFakeContext();
  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
  const discovered = await pi.handlers.get('resources_discover')({ reason: 'startup' }, ctx);

  assert.deepEqual(ctx.selections, []);
  assert.deepEqual(discovered.skillPaths, [captions, render, larkDoc]);
  assert.deepEqual(ctx.statuses, []);
});

test('/launch-mode toggles multiple suites and reloads session resources', async () => {
  const agentDir = createAgentDir();
  writeFileSync(join(agentDir, 'launch-modes.json'), JSON.stringify({
    selectedSuites: [],
    suites: {
      remotion: { label: 'Remotion', description: 'Remotion', skillPaths: [] },
      lark: { label: 'Lark', description: 'Lark', skillPaths: [] },
    },
  }));
  const pi = await install(agentDir);
  const ctx = createMultiSelectContext(['\x1b[B', ' ', '\x1b[B', ' ', '\r']);

  await pi.commands.get('launch-mode').handler('', ctx);

  assert.deepEqual(
    JSON.parse(readFileSync(join(agentDir, 'launch-modes.json'), 'utf8')).selectedSuites,
    ['remotion', 'lark'],
  );
  assert.equal(ctx.reloads, 1);
  assert.deepEqual(ctx.notifications.at(-1), {
    message: 'Launch features updated: Core + Remotion + Lark',
    type: 'info',
  });
});

test('the model context contains the selected suite but not disabled suites', async () => {
  const agentDir = createAgentDir();
  const skillRoot = join(agentDir, 'skills');
  const larkDir = join(skillRoot, 'lark-doc');
  const remotionDir = join(skillRoot, 'remotion-render');
  mkdirSync(larkDir, { recursive: true });
  mkdirSync(remotionDir, { recursive: true });
  writeFileSync(join(agentDir, 'launch-modes.json'), JSON.stringify({
    selectedSuites: ['lark'],
    suites: {
      remotion: { label: 'Remotion', description: 'Remotion', skillPaths: [join(skillRoot, 'remotion-*')] },
      lark: { label: 'Lark', description: 'Lark', skillPaths: [join(skillRoot, 'lark-*')] },
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
