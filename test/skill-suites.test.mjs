import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const moduleUrl = new URL('../extensions/skill-suites.ts', import.meta.url).href;

function createAgentDir() {
  return mkdtempSync(join(tmpdir(), 'pi-skill-suites-'));
}

function createFakePi({ activeTools = ['read', 'bash'], allTools = activeTools } = {}) {
  const commands = new Map();
  const handlers = new Map();
  const activeToolChanges = [];
  const userMessages = [];
  let currentActiveTools = [...activeTools];
  return {
    commands,
    handlers,
    activeToolChanges,
    userMessages,
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    getActiveTools() {
      return [...currentActiveTools];
    },
    getAllTools() {
      return allTools.map((name) => ({ name }));
    },
    setActiveTools(names) {
      currentActiveTools = [...names];
      activeToolChanges.push([...names]);
    },
    sendUserMessage(message) {
      userMessages.push(message);
    },
  };
}

function createFakeContext(selection, cwd = process.cwd()) {
  const selections = [];
  const statuses = [];
  const notifications = [];
  return {
    cwd,
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

function createMultiSelectContext(inputs, cwd = process.cwd()) {
  const ctx = createFakeContext(undefined, cwd);
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

async function install(agentDir, piOptions) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { default: installSkillSuites } = await import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
    const pi = createFakePi(piOptions);
    installSkillSuites(pi);
    return pi;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test('/ss remembers the selected suites for the current project cwd', async () => {
  const agentDir = createAgentDir();
  const projectCwd = join(agentDir, 'projects', 'video-app');
  const pi = await install(agentDir);
  const ctx = createMultiSelectContext([' ', '\x1b[B', ' ', '\r'], projectCwd);

  await pi.commands.get('ss').handler('', ctx);

  assert.doesNotMatch(ctx.renders[0].join('\n'), /Core/);
  assert.match(ctx.renders[0].join('\n'), /\[ \] Remotion/);
  assert.match(ctx.renders[0].join('\n'), /\[ \] Lark/);
  const saved = JSON.parse(readFileSync(join(agentDir, 'skill-suites.json'), 'utf8'));
  assert.deepEqual(saved.projects[resolve(projectCwd)].enabledSuites, ['remotion', 'lark']);
  assert.equal(ctx.reloads, 1);
  assert.deepEqual(ctx.notifications.at(-1), {
    message: 'Skill suites updated for this project: Remotion + Lark',
    type: 'info',
  });
});

test('one config file remembers different selections for different project cwds', async () => {
  const agentDir = createAgentDir();
  const projectA = join(agentDir, 'projects', 'video-app');
  const projectB = join(agentDir, 'projects', 'lark-bot');
  const pi = await install(agentDir);

  await pi.commands.get('ss').handler('', createMultiSelectContext([' ', '\r'], projectA));
  await pi.commands.get('ss').handler('', createMultiSelectContext(['\x1b[B', ' ', '\r'], projectB));

  const saved = JSON.parse(readFileSync(join(agentDir, 'skill-suites.json'), 'utf8'));
  assert.deepEqual(saved.projects[resolve(projectA)].enabledSuites, ['remotion']);
  assert.deepEqual(saved.projects[resolve(projectB)].enabledSuites, ['lark']);
  assert.equal(Object.keys(saved.projects).length, 2);
});

test('enabled suites activate their tools while disabled suite tools stay off', async () => {
  const agentDir = createAgentDir();
  writeFileSync(join(agentDir, 'skill-suites.json'), JSON.stringify({
    projects: {
      [resolve(process.cwd())]: { enabledSuites: ['remotion'] },
    },
    suites: {
      remotion: { label: 'Remotion', description: 'Remotion', skillPaths: [], tools: ['remotion_render'] },
      lark: { label: 'Lark', description: 'Lark', skillPaths: [], tools: ['lark_send'] },
    },
  }));
  const pi = await install(agentDir, {
    activeTools: ['read', 'bash', 'remotion_render', 'lark_send'],
    allTools: ['read', 'bash', 'remotion_render', 'lark_send'],
  });

  await pi.handlers.get('session_start')({ reason: 'startup' }, createFakeContext());

  assert.deepEqual(pi.activeToolChanges.at(-1), ['read', 'bash', 'remotion_render']);
});

test('/ss with a description asks the agent to propose a suite config change', async () => {
  const agentDir = createAgentDir();
  const pi = await install(agentDir, {
    activeTools: ['read', 'bash'],
    allTools: ['read', 'bash', 'chrome_devtools'],
  });
  const ctx = createFakeContext();

  await pi.commands.get('ss').handler('add a browser suite for Chrome debugging', ctx);

  assert.equal(pi.userMessages.length, 1);
  assert.match(pi.userMessages[0], /add a browser suite for Chrome debugging/);
  assert.match(pi.userMessages[0], /skill-suites\.json/);
  assert.match(pi.userMessages[0], new RegExp(resolve(ctx.cwd).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(pi.userMessages[0], /chrome_devtools/);
  assert.match(pi.userMessages[0], /Propose/);
  assert.match(pi.userMessages[0], /Do not edit/i);
  assert.equal(ctx.reloads, 0);
});

test('legacy launch-mode configuration migrates to skill suites', async () => {
  const agentDir = createAgentDir();
  writeFileSync(join(agentDir, 'launch-modes.json'), JSON.stringify({
    selectedSuites: ['remotion', 'lark'],
    suites: {
      remotion: { label: 'Remotion', description: 'Remotion', skillPaths: [], tools: [] },
      lark: { label: 'Lark', description: 'Lark', skillPaths: [], tools: [] },
    },
  }));

  await install(agentDir);

  const migrated = JSON.parse(readFileSync(join(agentDir, 'skill-suites.json'), 'utf8'));
  assert.deepEqual(migrated.projects, {});
  assert.deepEqual(Object.keys(migrated.suites), ['remotion', 'lark']);
});

test('later sessions reuse the suites remembered for their project cwd', async () => {
  const agentDir = createAgentDir();
  const projectCwd = join(agentDir, 'projects', 'combined-app');
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
  writeFileSync(join(agentDir, 'skill-suites.json'), JSON.stringify({
    projects: {
      [resolve(projectCwd)]: { enabledSuites: ['remotion', 'lark'] },
    },
    suites: {
      remotion: {
        label: 'Remotion',
        description: 'Remotion suite',
        skillPaths: [join(skillRoot, 'remotion-*')],
        tools: [],
      },
      lark: {
        label: 'Lark',
        description: 'Lark suite',
        skillPaths: [join(skillRoot, 'lark-*')],
        tools: [],
      },
    },
  }));

  const pi = await install(agentDir);
  const ctx = createFakeContext(undefined, projectCwd);
  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
  const discovered = await pi.handlers.get('resources_discover')({ reason: 'startup', cwd: projectCwd }, ctx);

  assert.deepEqual(ctx.selections, []);
  assert.deepEqual(discovered.skillPaths, [captions, render, larkDoc]);
  assert.deepEqual(ctx.statuses, []);
});

test('the model context contains the project-selected suite but not disabled suites', async () => {
  const agentDir = createAgentDir();
  const projectCwd = join(agentDir, 'projects', 'lark-app');
  const skillRoot = join(agentDir, 'skills');
  const larkDir = join(skillRoot, 'lark-doc');
  const remotionDir = join(skillRoot, 'remotion-render');
  mkdirSync(larkDir, { recursive: true });
  mkdirSync(remotionDir, { recursive: true });
  writeFileSync(join(agentDir, 'skill-suites.json'), JSON.stringify({
    projects: {
      [resolve(projectCwd)]: { enabledSuites: ['lark'] },
    },
    suites: {
      remotion: {
        label: 'Remotion',
        description: 'Remotion',
        skillPaths: [join(skillRoot, 'remotion-*')],
        tools: [],
      },
      lark: {
        label: 'Lark',
        description: 'Lark',
        skillPaths: [join(skillRoot, 'lark-*')],
        tools: [],
      },
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
    systemPromptOptions: { skills, cwd: projectCwd },
  }, createFakeContext(undefined, projectCwd));

  assert.match(result.systemPrompt, /<name>research<\/name>/);
  assert.match(result.systemPrompt, /<name>lark-doc<\/name>/);
  assert.doesNotMatch(result.systemPrompt, /remotion-render/);
});
