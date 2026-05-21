// extensions/sz-git-view/index.ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGitViewServer } from "./server";
import { collectAll, getDiffForPath } from "./collector";
import type { GitData } from "./collector";
import { getHtmlTemplate } from "./template";

export default async function (pi: ExtensionAPI) {
  const server = createGitViewServer();
  let port: number | null = null;
  let ctx: ExtensionContext | null = null;

  // ── Client → Server message handler ─────────────────────────────────
  server.onMessage = (type, payload) => {
    if (type === "get-diff" && payload?.path) {
      const diff = getDiffForPath(payload.path);
      server.broadcast({ type: "diff", path: payload.path, content: diff || "" });
    } else if (type === "load-more") {
      // Re-broadcast full data (client already has it; future: pagination)
      pushData();
    }
  };

  // ── Push data to all connected clients ──────────────────────────────
  function pushData() {
    if (!server || port === null) return;
    try {
      const data: GitData = collectAll();
      const payload: any = {
        type: "full",
        repoName: data.repoName,
        commits: data.commits,
        status: data.status,
        worktrees: data.worktrees,
        error: data.error || null,
      };
      server.broadcast(payload);
    } catch (err: any) {
      server.broadcast({ type: "full", error: "Failed to collect git data: " + err.message });
    }
  }

  // ── Server lifecycle ────────────────────────────────────────────────
  pi.on("session_start", async (_event, extensionCtx) => {
    ctx = extensionCtx;
    try {
      const template = getHtmlTemplate();
      port = await server.start(template);
      if (ctx.ui?.notify) {
        ctx.ui.notify(
          `Git view: http://127.0.0.1:${port}`,
          "info"
        );
      }
      // Push initial data after a short delay to let the client connect
      setTimeout(() => pushData(), 1000);
    } catch (err: any) {
      if (ctx.ui?.notify) {
        ctx.ui.notify(`Git view failed: ${err.message}`, "error");
      }
    }
  });

  pi.on("session_shutdown", async () => {
    server.stop();
    port = null;
  });

  // ── Auto-refresh on relevant events ─────────────────────────────────
  pi.on("turn_end", async () => {
    pushData();
  });

  pi.on("tool_execution_end", async (event) => {
    if (
      event.toolName === "bash" ||
      event.toolName === "edit" ||
      event.toolName === "write"
    ) {
      pushData();
    }
  });
}
