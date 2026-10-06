import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectDiffSummary, type GitDiffSummary } from "./collector.ts";

export const GIT_VIEW_UPDATE_EVENT = "sz-git-view:update";
export const GIT_VIEW_SUMMARY_GLOBAL_KEY = "__SZ_GIT_VIEW_SUMMARY__";

type GlobalWithGitViewSummary = typeof globalThis & {
  [GIT_VIEW_SUMMARY_GLOBAL_KEY]?: GitDiffSummary | null;
};

function sessionCwd(ctx: ExtensionContext): string {
  return typeof ctx.sessionManager.getCwd === "function"
    ? ctx.sessionManager.getCwd()
    : ctx.cwd;
}

function publishSummary(pi: ExtensionAPI, summary: GitDiffSummary | null): void {
  (globalThis as GlobalWithGitViewSummary)[GIT_VIEW_SUMMARY_GLOBAL_KEY] = summary;
  pi.events.emit(GIT_VIEW_UPDATE_EVENT, { summary });
}

// Publish local and external Git changes to the footer while the TUI session is alive.
export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | null = null;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let refreshTask: Promise<void> | null = null;
  let refreshAgain = false;
  let generation = 0;
  let lastSummary: string | undefined;

  // Coalesce overlapping tool events, but rescan after any changes made during a read.
  function refresh(): Promise<void> {
    if (!ctx) return Promise.resolve();
    if (refreshTask) {
      refreshAgain = true;
      return refreshTask;
    }
    refreshTask = (async () => {
      do {
        refreshAgain = false;
        const currentCtx = ctx;
        if (!currentCtx) break;
        const currentGeneration = generation;
        const summary = await collectDiffSummary(sessionCwd(currentCtx));
        if (currentGeneration !== generation) continue;
        const serialized = JSON.stringify(summary);
        if (serialized !== lastSummary) {
          lastSummary = serialized;
          publishSummary(pi, summary);
        }
      } while (refreshAgain && ctx);
    })().finally(() => {
      refreshTask = null;
    });
    return refreshTask;
  }

  pi.on("session_start", async (_event, extensionCtx) => {
    clearInterval(pollTimer);
    ctx = extensionCtx;
    generation++;
    lastSummary = undefined;
    await refresh();
    if (ctx === extensionCtx && extensionCtx.mode === "tui") {
      pollTimer = setInterval(() => {
        // A slow scan must not start concurrent Git processes or queue endless polls.
        if (!refreshTask) void refresh();
      }, 1000);
      pollTimer.unref();
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "bash" || event.toolName === "edit" || event.toolName === "write") {
      return refresh();
    }
  });

  pi.on("turn_end", refresh);

  pi.on("session_shutdown", async () => {
    clearInterval(pollTimer);
    ctx = null;
    generation++;
    refreshAgain = false;
    await refreshTask;
    publishSummary(pi, null);
  });
}
