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

const STATE_FILENAME = "launch-modes.json";
const STATUS_KEY = "launch-mode";

interface LaunchMode {
  label: string;
  description: string;
  skillPaths: string[];
}

interface LaunchModeConfig {
  activeMode: string;
  modes: Record<string, LaunchMode>;
}

function defaultConfig(): LaunchModeConfig {
  const skillRoot = join(homedir(), ".agents", "skills");
  return {
    activeMode: "core",
    modes: {
      core: {
        label: "Core",
        description: "Default skills without optional suites",
        skillPaths: [],
      },
      lark: {
        label: "Lark",
        description: "Core plus the Lark skill suite",
        skillPaths: [join(skillRoot, "lark-*")],
      },
      remotion: {
        label: "Remotion",
        description: "Core plus the Remotion skill suite",
        skillPaths: [join(skillRoot, "remotion-*")],
      },
      all: {
        label: "Lark + Remotion",
        description: "Core plus both optional skill suites",
        skillPaths: [join(skillRoot, "lark-*"), join(skillRoot, "remotion-*")],
      },
    },
  };
}

function readConfig(path: string): LaunchModeConfig | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LaunchModeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read launch mode config from ${path}: ${(error as Error).message}`);
  }
}

function writeConfig(path: string, config: LaunchModeConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function modeIdForLabel(config: LaunchModeConfig, label: string): string | undefined {
  return Object.entries(config.modes).find(([, mode]) => mode.label === label)?.[0];
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
    throw new Error(`Launch mode skill paths only support wildcards in the final path segment: ${pattern}`);
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

function filterSkills(skills: Skill[], config: LaunchModeConfig): Skill[] {
  const managedRoots = Object.values(config.modes).flatMap((mode) => mode.skillPaths.flatMap(expandSkillPath));
  const activeMode = config.modes[config.activeMode];
  if (!activeMode) throw new Error(`Unknown active launch mode: ${config.activeMode}`);
  const activeRoots = activeMode.skillPaths.flatMap(expandSkillPath);
  return skills.filter((skill) => {
    const managed = managedRoots.some((root) => isInside(skill.filePath, root));
    return !managed || activeRoots.some((root) => isInside(skill.filePath, root));
  });
}

export default function launchModeExtension(pi: ExtensionAPI) {
  const configPath = join(getAgentDir(), STATE_FILENAME);
  let config = readConfig(configPath);

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, `mode:${config?.activeMode ?? "core"}`);
  }

  pi.registerCommand("launch-mode", {
    description: "Switch the active skill-suite launch mode",
    handler: async (args, ctx) => {
      if (!config) config = defaultConfig();
      let nextMode = args.trim();
      if (!nextMode) {
        const selected = await ctx.ui.select(
          "Launch mode",
          Object.values(config.modes).map((mode) => mode.label),
        );
        if (!selected) return;
        nextMode = modeIdForLabel(config, selected) ?? "";
      }
      if (!config.modes[nextMode]) {
        ctx.ui.notify(`Unknown launch mode "${nextMode}". Available: ${Object.keys(config.modes).join(", ")}`, "error");
        return;
      }
      config.activeMode = nextMode;
      writeConfig(configPath, config);
      ctx.ui.notify(`Launch mode changed to ${config.modes[nextMode].label}`, "info");
      await ctx.reload();
      return;
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!config) {
      config = defaultConfig();
      if (ctx.mode === "tui" && ctx.hasUI) {
        const labels = Object.values(config.modes).map((mode) => mode.label);
        const selected = await ctx.ui.select("Launch mode", labels);
        const selectedId = selected ? modeIdForLabel(config, selected) : undefined;
        if (selectedId) config.activeMode = selectedId;
        writeConfig(configPath, config);
      }
    }
    updateStatus(ctx);
  });

  pi.on("resources_discover", () => {
    const activeMode = config?.modes[config.activeMode];
    if (!activeMode) throw new Error(`Unknown active launch mode: ${config?.activeMode}`);
    return { skillPaths: activeMode.skillPaths.flatMap(expandSkillPath) };
  });

  pi.on("before_agent_start", (event) => {
    if (!config || !event.systemPromptOptions.skills) return;
    const originalSkills = event.systemPromptOptions.skills;
    const filteredSkills = filterSkills(originalSkills, config);
    const originalBlock = formatSkillsForPrompt(originalSkills);
    const filteredBlock = formatSkillsForPrompt(filteredSkills);
    event.systemPromptOptions.skills = filteredSkills;
    return {
      systemPrompt: originalBlock ? event.systemPrompt.replace(originalBlock, filteredBlock) : event.systemPrompt,
    };
  });
}
