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

const STATE_FILENAME = "launch-modes.json";

interface LaunchSuite {
  label: string;
  description: string;
  skillPaths: string[];
}

interface LaunchModeConfig {
  selectedSuites: string[];
  suites: Record<string, LaunchSuite>;
}

function defaultConfig(): LaunchModeConfig {
  const skillRoot = join(homedir(), ".agents", "skills");
  return {
    selectedSuites: [],
    suites: {
      remotion: {
        label: "Remotion",
        description: "Video creation, captions, rendering, and Remotion workflows",
        skillPaths: [join(skillRoot, "remotion-*")],
      },
      lark: {
        label: "Lark",
        description: "Lark documents, messaging, meetings, tasks, and other Lark workflows",
        skillPaths: [join(skillRoot, "lark-*")],
      },
    },
  };
}

function readConfig(path: string): LaunchModeConfig | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (Array.isArray(parsed.selectedSuites) && parsed.suites && typeof parsed.suites === "object") {
      return parsed as unknown as LaunchModeConfig;
    }
    if (typeof parsed.activeMode === "string" && parsed.modes && typeof parsed.modes === "object") {
      const migrated = defaultConfig();
      const legacyModes = parsed.modes as Record<string, { skillPaths?: unknown }>;
      for (const id of Object.keys(migrated.suites)) {
        if (Array.isArray(legacyModes[id]?.skillPaths)) {
          migrated.suites[id].skillPaths = legacyModes[id].skillPaths as string[];
        }
      }
      migrated.selectedSuites = parsed.activeMode === "all"
        ? Object.keys(migrated.suites)
        : parsed.activeMode === "core"
          ? []
          : [parsed.activeMode].filter((id) => Boolean(migrated.suites[id]));
      writeConfig(path, migrated);
      return migrated;
    }
    throw new Error('expected "selectedSuites" and "suites"');
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

async function selectSuites(ctx: ExtensionContext, config: LaunchModeConfig): Promise<string[] | null> {
  const suiteEntries = Object.entries(config.suites);
  const rows = [{ id: "core", label: "Core", description: "Always enabled" }, ...suiteEntries.map(([id, suite]) => ({
    id,
    label: suite.label,
    description: suite.description,
  }))];
  const selectedSuites = new Set(config.selectedSuites);

  return ctx.ui.custom<string[] | null>((tui, theme, keybindings, done) => {
    let selectedIndex = 0;

    return {
      render(width: number): string[] {
        const lines = [theme.fg("accent", theme.bold("Launch features")), ""];
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index];
          const focused = index === selectedIndex;
          const enabled = row.id === "core" || selectedSuites.has(row.id);
          const cursor = focused ? theme.fg("accent", "› ") : "  ";
          const checkbox = enabled ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
          const suffix = row.id === "core" ? theme.fg("dim", " (always on)") : "";
          const label = focused ? theme.fg("accent", row.label) : row.label;
          lines.push(truncateToWidth(`${cursor}${checkbox} ${label}${suffix}`, width, ""));
        }
        lines.push("", theme.fg("dim", "↑↓ navigate • space toggle • enter confirm • esc cancel"));
        return lines.map((line) => truncateToWidth(line, width, ""));
      },
      invalidate() {},
      handleInput(data: string): void {
        if (keybindings.matches(data, "tui.select.up")) {
          selectedIndex = selectedIndex === 0 ? rows.length - 1 : selectedIndex - 1;
        } else if (keybindings.matches(data, "tui.select.down")) {
          selectedIndex = selectedIndex === rows.length - 1 ? 0 : selectedIndex + 1;
        } else if (matchesKey(data, Key.space)) {
          const id = rows[selectedIndex].id;
          if (id !== "core") {
            if (selectedSuites.has(id)) selectedSuites.delete(id);
            else selectedSuites.add(id);
          }
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          done(suiteEntries.map(([id]) => id).filter((id) => selectedSuites.has(id)));
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

function selectedSkillPaths(config: LaunchModeConfig): string[] {
  return config.selectedSuites.flatMap((id) => {
    const suite = config.suites[id];
    if (!suite) throw new Error(`Unknown selected launch suite: ${id}`);
    return suite.skillPaths.flatMap(expandSkillPath);
  });
}

function filterSkills(skills: Skill[], config: LaunchModeConfig): Skill[] {
  const managedRoots = Object.values(config.suites).flatMap((suite) => suite.skillPaths.flatMap(expandSkillPath));
  const activeRoots = selectedSkillPaths(config);
  return skills.filter((skill) => {
    const managed = managedRoots.some((root) => isInside(skill.filePath, root));
    return !managed || activeRoots.some((root) => isInside(skill.filePath, root));
  });
}

export default function launchModeExtension(pi: ExtensionAPI) {
  const configPath = join(getAgentDir(), STATE_FILENAME);
  let config = readConfig(configPath);

  pi.registerCommand("launch-mode", {
    description: "Choose optional skill suites to load with Core",
    handler: async (args, ctx) => {
      if (!config) config = defaultConfig();
      let selected: string[] | null;
      const requested = args.trim();
      if (!requested) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/launch-mode requires TUI mode when no suites are specified", "error");
          return;
        }
        selected = await selectSuites(ctx, config);
      } else {
        const ids = requested.split(/[\s,]+/).filter(Boolean);
        selected = ids.includes("all") ? Object.keys(config.suites) : ids.filter((id) => id !== "core");
        const unknown = selected.filter((id) => !config.suites[id]);
        if (unknown.length > 0) {
          ctx.ui.notify(`Unknown launch suites: ${unknown.join(", ")}`, "error");
          return;
        }
      }
      if (!selected) return;
      config.selectedSuites = Object.keys(config.suites).filter((id) => selected.includes(id));
      writeConfig(configPath, config);
      const labels = config.selectedSuites.map((id) => config!.suites[id].label);
      ctx.ui.notify(`Launch features updated: Core${labels.length ? ` + ${labels.join(" + ")}` : ""}`, "info");
      await ctx.reload();
      return;
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!config) {
      config = defaultConfig();
      if (ctx.mode === "tui" && ctx.hasUI) {
        const selected = await selectSuites(ctx, config);
        if (selected) {
          config.selectedSuites = selected;
          writeConfig(configPath, config);
        }
      }
    }
  });

  pi.on("resources_discover", () => {
    if (!config) throw new Error("Launch feature configuration is not initialized");
    return { skillPaths: selectedSkillPaths(config) };
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
