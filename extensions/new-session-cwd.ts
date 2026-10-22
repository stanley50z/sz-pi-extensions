import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildSessionProjection,
  DynamicBorder,
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

const INTERNAL_SWITCH_COMMAND = "new-cwd-switch";
const INHERITED_MODEL_ENTRY = "neww-inherit-model";

interface RecentSession {
  cwd: string;
  modified: Date;
}

interface NewSessionCwdDependencies {
  listSessions: () => Promise<RecentSession[]>;
  cwdExists: (cwd: string) => boolean;
  schedule: (task: () => void) => void;
  createSessionFile: (cwd: string) => string;
}

interface CwdChoice {
  cwd: string;
  modified?: Date;
  current: boolean;
}

function cwdKey(cwd: string): string {
  const normalized = resolve(cwd);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function compactHome(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  const prefix = home.endsWith("/") || home.endsWith("\\") ? home : `${home}${process.platform === "win32" ? "\\" : "/"}`;
  return cwd.startsWith(prefix) ? `~${cwd.slice(home.length)}` : cwd;
}

export function rankCwdChoices(currentCwd: string, sessions: RecentSession[], cwdExists: (cwd: string) => boolean): CwdChoice[] {
  const current = resolve(currentCwd);
  const currentKey = cwdKey(current);
  const seen = new Set([currentKey]);
  const choices: CwdChoice[] = [{ cwd: current, current: true }];

  const ranked = [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime());
  for (const session of ranked) {
    const cwd = resolve(session.cwd);
    const key = cwdKey(cwd);
    if (seen.has(key) || !cwdExists(cwd)) continue;
    seen.add(key);
    choices.push({ cwd, modified: session.modified, current: false });
  }

  return choices;
}

async function selectCwd(ctx: ExtensionContext, choices: CwdChoice[]): Promise<string | null> {
  const items: SelectItem[] = choices.map((choice) => ({
    value: choice.cwd,
    label: compactHome(choice.cwd),
    description: choice.current
      ? "current working directory"
      : `last used ${choice.modified?.toLocaleString()}`,
  }));

  return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("New session working directory")), 1, 0));

    const list = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function hasTui(ctx: ExtensionContext): boolean {
  const mode = (ctx as ExtensionContext & { mode?: string }).mode;
  return mode === undefined ? ctx.hasUI : mode === "tui";
}

// Adds the /new cwd selector and /neww to retain the current cwd, model and reasoning.
export function createNewSessionCwdExtension(deps: NewSessionCwdDependencies) {
  return function newSessionCwdExtension(pi: ExtensionAPI) {
    let pendingCwd: string | undefined;
    let skipCwdSelector = false;

    pi.registerCommand("neww", {
      description: "Start a new session with the current cwd, model and reasoning",
      handler: async (_args, ctx) => {
        const model = ctx.model && { provider: ctx.model.provider, id: ctx.model.id };
        const thinkingLevel = pi.getThinkingLevel();
        skipCwdSelector = true;
        try {
          await ctx.newSession({
            setup: async (sessionManager) => {
              if (model) sessionManager.appendModelChange(model.provider, model.id);
              sessionManager.appendThinkingLevelChange(thinkingLevel);
              sessionManager.appendCustomEntry(INHERITED_MODEL_ENTRY);
            },
          });
        } finally {
          skipCwdSelector = false;
        }
      },
    });

    pi.on("session_start", async (event, ctx) => {
      // /new replaces the extension runtime. Restore through this fresh Pi handle,
      // after setup has seeded canonical settings in the replacement session.
      const branch = event.reason === "new" ? ctx.sessionManager.getBranch() : [];
      const inheritedIndex = branch.findLastIndex((entry) =>
        entry.type === "custom" && entry.customType === INHERITED_MODEL_ENTRY);
      if (inheritedIndex !== -1) {
        try {
          // Ignore entries appended by earlier startup hooks when reading the snapshot.
          const saved = buildSessionProjection(branch.slice(0, inheritedIndex + 1));
          if (saved.model) {
            const model = ctx.modelRegistry.find(saved.model.provider, saved.model.modelId);
            if (!model || !await pi.setModel(model)) {
              throw new Error(`Could not retain /neww model ${saved.model.provider}/${saved.model.modelId}`);
            }
          }
          const thinkingLevel = (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)
            .find((level) => level === saved.thinkingLevel);
          if (!thinkingLevel) throw new Error(`Invalid /neww reasoning level: ${saved.thinkingLevel}`);
          pi.setThinkingLevel(thinkingLevel);
        } catch (error) {
          const logPath = join(getAgentDir(), "logs", "new-session-cwd.log");
          mkdirSync(dirname(logPath), { recursive: true });
          appendFileSync(logPath, `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`, "utf8");
          throw error;
        }
      }
      if (!hasTui(ctx)) return;

      ctx.ui.addAutocompleteProvider((current) => ({
        triggerCharacters: current.triggerCharacters,
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
          if (!suggestions?.prefix.startsWith("/")) return suggestions;

          const items = suggestions.items.filter((item) => item.value !== INTERNAL_SWITCH_COMMAND);
          return items.length > 0 ? { ...suggestions, items } : null;
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
      }));
    });

    pi.registerCommand(INTERNAL_SWITCH_COMMAND, {
      description: "Complete a /new working-directory selection",
      handler: async (_args, ctx) => {
        const cwd = pendingCwd;
        pendingCwd = undefined;
        if (!cwd) {
          ctx.ui.notify("No new-session working directory is pending", "warning");
          return;
        }

        const sessionFile = deps.createSessionFile(cwd);
        await ctx.switchSession(sessionFile, {
          withSession: async (replacementCtx) => {
            replacementCtx.ui.notify(`New session started in ${cwd}`, "info");
          },
        });
      },
    });

    pi.on("session_before_switch", async (event, ctx) => {
      if (event.reason !== "new" || skipCwdSelector || !hasTui(ctx)) return;

      const currentCwd = ctx.sessionManager.getCwd();
      const choices = rankCwdChoices(currentCwd, await deps.listSessions(), deps.cwdExists);
      const selected = await selectCwd(ctx, choices);
      if (selected === null) return { cancel: true };
      if (cwdKey(selected) === cwdKey(currentCwd)) return;

      pendingCwd = selected;
      deps.schedule(() => {
        pi.sendUserMessage(`/${INTERNAL_SWITCH_COMMAND}`, { expandPromptTemplates: true });
      });
      return { cancel: true };
    });
  };
}

export function createBlankSessionFile(cwd: string): string {
  const sessionManager = SessionManager.create(cwd);
  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (!sessionFile || !header) throw new Error(`Could not create a persisted session for ${cwd}`);

  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
  return sessionFile;
}

export default createNewSessionCwdExtension({
  listSessions: () => SessionManager.listAll(),
  cwdExists: existsSync,
  schedule: (task) => setTimeout(task, 0),
  createSessionFile: createBlankSessionFile,
});
