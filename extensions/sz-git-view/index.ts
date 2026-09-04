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

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | null = null;

  function refresh(): void {
    publishSummary(pi, ctx ? collectDiffSummary(sessionCwd(ctx)) : null);
  }

  pi.on("session_start", (_event, extensionCtx) => {
    ctx = extensionCtx;
    refresh();
  });

  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "bash" || event.toolName === "edit" || event.toolName === "write") {
      refresh();
    }
  });

  pi.on("turn_end", refresh);

  pi.on("session_shutdown", () => {
    ctx = null;
    publishSummary(pi, null);
  });
}
