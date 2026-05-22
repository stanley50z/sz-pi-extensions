/**
 * sz-pi-footer — enhanced pi footer with token speed and git diff stats.
 *
 * Shows the default footer info plus:
 * - Token speed (output tokens/second for the most recent turn)
 * - Git diff stats (+X −Y) centred, when in a repo with uncommitted changes
 *
 * Non-git directories and clean trees fall back to the default footer layout.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";

const STATUS_KEY = "sz-footer";
const GIT_VIEW_URL_EVENT = "sz-git-view:url";
const GIT_VIEW_URL_GLOBAL_KEY = "__SZ_GIT_VIEW_URL__";

type GlobalWithGitViewUrl = typeof globalThis & {
  [GIT_VIEW_URL_GLOBAL_KEY]?: string | null;
};

function getGlobalGitViewUrl(): string | null {
  const url = (globalThis as GlobalWithGitViewUrl)[GIT_VIEW_URL_GLOBAL_KEY];
  return typeof url === "string" && url.length > 0 ? url : null;
}

function extractGitViewUrl(data: unknown): string | null | undefined {
  if (!data || typeof data !== "object" || !("url" in data)) return undefined;
  const url = (data as { url?: unknown }).url;
  if (url === null) return null;
  return typeof url === "string" && url.length > 0 ? url : undefined;
}

// ── git diff helpers ──────────────────────────────────────────────────

function getDiffStats(): string | null {
  try {
    execSync("git rev-parse --git-dir", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    });

    const out = execSync("git diff --shortstat HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();

    const added = out.match(/(\d+) insertions?\(\+\)/);
    const deleted = out.match(/(\d+) deletions?\(-\)/);
    const a = added ? Number(added[1]) : 0;
    const d = deleted ? Number(deleted[1]) : 0;

    return `+${a} −${d}`;
  } catch {
    return null;
  }
}

// ── token speed tracking ──────────────────────────────────────────────

let lastTurnStart: number | null = null;
let lastOutputTokensPerSec: number | null = null;

function resetSpeed() {
  lastTurnStart = null;
  lastOutputTokensPerSec = null;
}

// ── extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let _ctx: ExtensionContext | null = null;
  let gitViewUrl: string | null = getGlobalGitViewUrl();

  const unsubscribeGitViewUrl = pi.events.on(GIT_VIEW_URL_EVENT, (data) => {
    const nextUrl = extractGitViewUrl(data);
    if (nextUrl === undefined) return;
    gitViewUrl = nextUrl;
    if (_ctx) installFooter(_ctx);
  });

  // ── store context ──────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    _ctx = ctx;
    gitViewUrl = getGlobalGitViewUrl() ?? gitViewUrl;
    resetSpeed();
    installFooter(ctx);
  });

  pi.on("session_shutdown", async () => {
    unsubscribeGitViewUrl();
    _ctx = null;
  });

  // ── track turn timing ──────────────────────────────────────────────
  pi.on("turn_start", async () => {
    lastTurnStart = Date.now();
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (lastTurnStart === null) return;

    // Sum output tokens for the most recent assistant message
    let outputTokens = 0;
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message.role === "assistant") {
        const m = entry.message as AssistantMessage;
        outputTokens = m.usage.output;
        break;
      }
    }

    const elapsedSec = (Date.now() - lastTurnStart) / 1000;
    lastOutputTokensPerSec = elapsedSec > 0 ? outputTokens / elapsedSec : null;

    installFooter(ctx);
  });

  // ── refresh after file-changing tools ──────────────────────────────
  pi.on("tool_execution_end", async (_event, ctx) => {
    if (
      _event.toolName === "bash" ||
      _event.toolName === "edit" ||
      _event.toolName === "write"
    ) {
      installFooter(ctx);
    }
  });

  // ── footer installation ────────────────────────────────────────────

  function installFooter(ctx: ExtensionContext) {
    const stats = getDiffStats();

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          // ── compute token totals from the full branch ──────────────
          let input = 0,
            output = 0,
            cost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              input += m.usage.input;
              output += m.usage.output;
              cost += m.usage.cost.total;
            }
          }

          // ── format helpers ────────────────────────────────────────
          const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

          // ── build left side: tokens, cost, speed ──────────────────
          let left = theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)}`);

          if (lastOutputTokensPerSec !== null && lastOutputTokensPerSec > 0) {
            const speedStr =
              lastOutputTokensPerSec >= 100
                ? `${Math.round(lastOutputTokensPerSec)} tok/s`
                : `${lastOutputTokensPerSec.toFixed(1)} tok/s`;
            left += " " + theme.fg("muted", speedStr);
          }

          left += " " + theme.fg("accent", `$${cost.toFixed(3)}`);

          // ── build right side: model ───────────────────────────────
          const branch = footerData.getGitBranch();
          const branchStr = branch ? ` (${branch})` : "";
          const right = theme.fg("dim", `${ctx.model?.id || "no-model"}${branchStr}`);

          // ── git diff stats (centre, if available) ─────────────────
          const diff = getDiffStats();
          let centre = "";
          if (diff) {
            const coloured = diff.replace(
              /^(\+\d+)\s+(−\d+)$/,
              (_, adds: string, dels: string) =>
                theme.fg("success", adds) + " " + theme.fg("dim", " ") + theme.fg("error", dels),
            );
            centre = gitViewUrl ? hyperlink(coloured, gitViewUrl) : coloured;
          }

          // ── layout: left | centre | right ────────────────────────
          const leftW = visibleWidth(left);
          const centreW = visibleWidth(centre);
          const rightW = visibleWidth(right);

          if (centre) {
            const available = width - leftW - rightW;
            if (available > centreW + 2) {
              const padLeft = Math.floor((available - centreW) / 2);
              const padRight = available - centreW - padLeft;
              return [truncateToWidth(
                left + " ".repeat(padLeft) + centre + " ".repeat(padRight) + right,
                width,
              )];
            }
          }

          // No centre stats — left | spacer | right
          const pad = " ".repeat(Math.max(1, width - leftW - rightW));
          return [truncateToWidth(left + pad + right, width)];
        },
      };
    });
  }
}
