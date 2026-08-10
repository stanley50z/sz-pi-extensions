import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  formatSkillsForPrompt,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const CONFIG_FILENAME = "skill-suites.json";
const LEGACY_CONFIG_FILENAME = "launch-modes.json";

interface SkillSuite {
  label: string;
  description: string;
  skillPaths: string[];
  tools: string[];
}

interface ProjectSuiteSettings {
  enabledSuites: string[];
}

interface SkillSuitesConfig {
  projects: Record<string, ProjectSuiteSettings>;
  suites: Record<string, SkillSuite>;
}

function defaultConfig(): SkillSuitesConfig {
  const skillRoot = join(homedir(), ".agents", "skills");
  return {
    projects: {},
    suites: {
      remotion: {
        label: "Remotion",
        description: "Video creation, captions, rendering, and Remotion workflows",
        skillPaths: [join(skillRoot, "remotion-*")],
        tools: [],
      },
      lark: {
        label: "Lark",
        description: "Lark documents, messaging, meetings, tasks, and other Lark workflows",
        skillPaths: [join(skillRoot, "lark-*")],
        tools: [],
      },
    },
  };
}

function writeConfig(path: string, config: SkillSuitesConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function parseConfig(path: string): SkillSuitesConfig {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (parsed.projects && typeof parsed.projects === "object" && parsed.suites && typeof parsed.suites === "object") {
    return parsed as unknown as SkillSuitesConfig;
  }
  if (Array.isArray(parsed.enabledSuites) && parsed.suites && typeof parsed.suites === "object") {
    const migrated = { projects: {}, suites: parsed.suites } as SkillSuitesConfig;
    writeConfig(path, migrated);
    return migrated;
  }
  throw new Error('expected "projects" and "suites"');
}

function migrateLegacyConfig(path: string): SkillSuitesConfig {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const migrated = defaultConfig();
  if (Array.isArray(parsed.selectedSuites) && parsed.suites && typeof parsed.suites === "object") {
    const suites = parsed.suites as Record<string, Partial<SkillSuite>>;
    migrated.suites = Object.fromEntries(Object.entries(suites).map(([id, suite]) => [id, {
      label: suite.label ?? id,
      description: suite.description ?? "",
      skillPaths: suite.skillPaths ?? [],
      tools: suite.tools ?? [],
    }]));
    return migrated;
  }
  if (typeof parsed.activeMode === "string") return migrated;
  throw new Error(`Cannot migrate legacy skill suites from ${path}`);
}

function loadConfig(agentDir: string): SkillSuitesConfig {
  const configPath = join(agentDir, CONFIG_FILENAME);
  try {
    return parseConfig(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot read skill suites from ${configPath}: ${(error as Error).message}`);
    }
  }

  const legacyPath = join(agentDir, LEGACY_CONFIG_FILENAME);
  if (existsSync(legacyPath)) {
    const migrated = migrateLegacyConfig(legacyPath);
    writeConfig(configPath, migrated);
    return migrated;
  }
  return defaultConfig();
}

function projectKey(cwd: string): string {
  return resolve(cwd);
}

function enabledSuiteIds(config: SkillSuitesConfig, cwd: string): string[] {
  return config.projects[projectKey(cwd)]?.enabledSuites ?? [];
}

async function selectSuites(ctx: ExtensionContext, config: SkillSuitesConfig): Promise<string[] | null> {
  const suiteEntries = Object.entries(config.suites);
  const enabledSuites = new Set(enabledSuiteIds(config, ctx.cwd));

  return ctx.ui.custom<string[] | null>((tui, theme, keybindings, done) => {
    let selectedIndex = 0;

    return {
      render(width: number): string[] {
        const lines = [theme.fg("accent", theme.bold("Skill suites")), ""];
        if (suiteEntries.length === 0) lines.push(theme.fg("dim", "No skill suites configured"));
        for (let index = 0; index < suiteEntries.length; index++) {
          const [id, suite] = suiteEntries[index];
          const focused = index === selectedIndex;
          const cursor = focused ? theme.fg("accent", "› ") : "  ";
          const checkbox = enabledSuites.has(id) ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
          const label = focused ? theme.fg("accent", suite.label) : suite.label;
          lines.push(truncateToWidth(`${cursor}${checkbox} ${label}`, width, ""));
        }
        lines.push("", theme.fg("dim", "↑↓ navigate • space toggle • enter confirm • esc cancel"));
        return lines.map((line) => truncateToWidth(line, width, ""));
      },
      invalidate() {},
      handleInput(data: string): void {
        if (keybindings.matches(data, "tui.select.up") && suiteEntries.length > 0) {
          selectedIndex = selectedIndex === 0 ? suiteEntries.length - 1 : selectedIndex - 1;
        } else if (keybindings.matches(data, "tui.select.down") && suiteEntries.length > 0) {
          selectedIndex = selectedIndex === suiteEntries.length - 1 ? 0 : selectedIndex + 1;
        } else if (matchesKey(data, Key.space) && suiteEntries.length > 0) {
          const id = suiteEntries[selectedIndex][0];
          if (enabledSuites.has(id)) enabledSuites.delete(id);
          else enabledSuites.add(id);
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          done(suiteEntries.map(([id]) => id).filter((id) => enabledSuites.has(id)));
          return;
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done(null);
          return;
        }
        tui.requestRender();
      },
    };
  });
}

function wildcardRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`);
}

function expandSkillPath(pattern: string): string[] {
  const namePattern = pattern.slice(Math.max(pattern.lastIndexOf("/"), pattern.lastIndexOf("\\")) + 1);
  const parent = dirname(pattern);
  if (!namePattern.includes("*") && !namePattern.includes("?")) return existsSync(pattern) ? [pattern] : [];
  if (parent.includes("*") || parent.includes("?")) {
    throw new Error(`Skill suite paths only support wildcards in the final path segment: ${pattern}`);
  }
  if (!existsSync(parent)) return [];
  const matches = wildcardRegex(namePattern);
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && matches.test(entry.name))
    .map((entry) => join(parent, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function isInside(path: string, root: string): boolean {
  const relation = relative(resolve(root), resolve(path));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function enabledSkillPaths(config: SkillSuitesConfig, cwd: string): string[] {
  return enabledSuiteIds(config, cwd).flatMap((id) => {
    const suite = config.suites[id];
    if (!suite) throw new Error(`Unknown enabled skill suite: ${id}`);
    return suite.skillPaths.flatMap(expandSkillPath);
  });
}

function filterSkills(skills: Skill[], config: SkillSuitesConfig, cwd: string): Skill[] {
  const managedRoots = Object.values(config.suites).flatMap((suite) => suite.skillPaths.flatMap(expandSkillPath));
  const activeRoots = enabledSkillPaths(config, cwd);
  return skills.filter((skill) => {
    const managed = managedRoots.some((root) => isInside(skill.filePath, root));
    return !managed || activeRoots.some((root) => isInside(skill.filePath, root));
  });
}

function buildProposalPrompt(
  description: string,
  configPath: string,
  projectCwd: string,
  config: SkillSuitesConfig,
  availableTools: string[],
): string {
  return `The user wants to change their Pi skill suites for project cwd ${projectKey(projectCwd)}:

${description}

Propose a new suite or edits to the current suites. Do not edit any files yet. Show the exact JSON changes and briefly explain which skills and tools belong together, then ask for explicit approval.

After approval, update this file: ${configPath}

Configuration shape:
- projects.<resolved-cwd>.enabledSuites: suite ids enabled for that project cwd
- suites.<id>.label: display label
- suites.<id>.description: when the suite is useful
- suites.<id>.skillPaths: skill files, directories, or paths with a wildcard only in the final segment
- suites.<id>.tools: registered Pi tool names controlled by the suite

Current configuration:
\`\`\`json
${JSON.stringify(config, null, 2)}
\`\`\`

Currently registered tool names:
${availableTools.join(", ") || "(none)"}

Preserve unrelated suites and every project's enabled state unless the request explicitly changes them. After an approved edit, tell the user to run /reload so the new suite definitions take effect.`;
}

function applySuiteTools(pi: ExtensionAPI, config: SkillSuitesConfig, ctx: ExtensionContext): void {
  const knownTools = new Set(pi.getAllTools().map((tool) => tool.name));
  const managedTools = new Set(Object.values(config.suites).flatMap((suite) => suite.tools));
  const enabledTools = enabledSuiteIds(config, ctx.cwd).flatMap((id) => {
    const suite = config.suites[id];
    if (!suite) throw new Error(`Unknown enabled skill suite: ${id}`);
    return suite.tools;
  });
  const unknownTools = enabledTools.filter((name) => !knownTools.has(name));
  if (unknownTools.length > 0) {
    ctx.ui.notify(`Skill suites reference unknown tools: ${[...new Set(unknownTools)].join(", ")}`, "warning");
  }
  const unmanagedActiveTools = pi.getActiveTools().filter((name) => !managedTools.has(name));
  pi.setActiveTools([...new Set([...unmanagedActiveTools, ...enabledTools.filter((name) => knownTools.has(name))])]);
}

export default function skillSuitesExtension(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const configPath = join(agentDir, CONFIG_FILENAME);
  let config = loadConfig(agentDir);

  pi.registerCommand("ss", {
    description: "Toggle skill suites, or ask the agent to propose suite changes",
    handler: async (args, ctx) => {
      const description = args.trim();
      if (description) {
        pi.sendUserMessage(buildProposalPrompt(
          description,
          configPath,
          ctx.cwd,
          config,
          pi.getAllTools().map((tool) => tool.name),
        ));
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/ss requires TUI mode", "error");
        return;
      }
      const selected = await selectSuites(ctx, config);
      if (!selected) return;
      const cwdKey = projectKey(ctx.cwd);
      config.projects[cwdKey] = {
        enabledSuites: Object.keys(config.suites).filter((id) => selected.includes(id)),
      };
      writeConfig(configPath, config);
      const labels = config.projects[cwdKey].enabledSuites.map((id) => config.suites[id].label);
      ctx.ui.notify(`Skill suites updated for this project: ${labels.length ? labels.join(" + ") : "none"}`, "info");
      await ctx.reload();
      return;
    },
  });

  pi.on("session_start", (_event, ctx) => {
    applySuiteTools(pi, config, ctx);
  });

  pi.on("resources_discover", (event) => ({ skillPaths: enabledSkillPaths(config, event.cwd) }));

  pi.on("before_agent_start", (event) => {
    if (!event.systemPromptOptions.skills) return;
    const originalSkills = event.systemPromptOptions.skills;
    const filteredSkills = filterSkills(originalSkills, config, event.systemPromptOptions.cwd);
    const originalBlock = formatSkillsForPrompt(originalSkills);
    const filteredBlock = formatSkillsForPrompt(filteredSkills);
    event.systemPromptOptions.skills = filteredSkills;
    return {
      systemPrompt: originalBlock ? event.systemPrompt.replace(originalBlock, filteredBlock) : event.systemPrompt,
    };
  });
}
