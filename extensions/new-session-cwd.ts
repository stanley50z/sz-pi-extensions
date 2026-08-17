import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  DynamicBorder,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

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

export function createNewSessionCwdExtension(deps: NewSessionCwdDependencies) {
  return function newSessionCwdExtension(pi: ExtensionAPI) {
    let pendingCwd: string | undefined;

    pi.registerCommand("new-cwd-switch", {
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
      if (event.reason !== "new" || !hasTui(ctx)) return;

      const currentCwd = ctx.sessionManager.getCwd();
      const choices = rankCwdChoices(currentCwd, await deps.listSessions(), deps.cwdExists);
      const selected = await selectCwd(ctx, choices);
      if (selected === null) return { cancel: true };
      if (cwdKey(selected) === cwdKey(currentCwd)) return;

      pendingCwd = selected;
      deps.schedule(() => {
        pi.sendUserMessage("/new-cwd-switch", { expandPromptTemplates: true });
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
