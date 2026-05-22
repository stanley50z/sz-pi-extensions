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

// ── formatting helpers ────────────────────────────────────────────────

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function compactPath(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
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

  pi.on("thinking_level_select", async (_event, ctx) => {
    installFooter(ctx);
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
    if (elapsedSec > 0 && outputTokens > 0) {
      lastOutputTokensPerSec = outputTokens / elapsedSec;
    }

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
          // ── line 1: cwd, git branch, session name, token speed ─────
          const speedText = lastOutputTokensPerSec !== null && lastOutputTokensPerSec > 0
            ? lastOutputTokensPerSec >= 100
              ? `${Math.round(lastOutputTokensPerSec)} tok/s`
              : `${lastOutputTokensPerSec.toFixed(1)} tok/s`
            : "0 tok/s";
          const speedRight = `${speedText}  `;
          const speedW = visibleWidth(speedRight);

          const cwd = typeof ctx.sessionManager.getCwd === "function"
            ? ctx.sessionManager.getCwd()
            : ctx.cwd;
          let pwd = compactPath(cwd);
          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;
          const sessionName = typeof ctx.sessionManager.getSessionName === "function"
            ? ctx.sessionManager.getSessionName()
            : undefined;

          const minGap = 2;
          const availableBeforeSpeed = Math.max(1, width - speedW - minGap);
          const sessionText = sessionName ? truncateToWidth(sessionName, availableBeforeSpeed, "...") : "";
          const sessionW = visibleWidth(sessionText);
          const pwdMaxWidth = sessionText
            ? Math.max(1, Math.floor((availableBeforeSpeed - sessionW - minGap * 2) / 2))
            : availableBeforeSpeed;
          const pwdText = truncateToWidth(pwd, pwdMaxWidth, "...");
          const pwdW = visibleWidth(pwdText);

          let prefix: string;
          if (sessionText) {
            const targetSessionStart = Math.max(pwdW + minGap, Math.floor((width - sessionW) / 2));
            const gapAfterPwd = Math.max(minGap, targetSessionStart - pwdW);
            prefix = theme.fg("dim", pwdText) + " ".repeat(gapAfterPwd) + theme.fg("dim", sessionText);
          } else {
            prefix = theme.fg("dim", pwdText);
          }

          const pwdPad = " ".repeat(Math.max(minGap, width - visibleWidth(prefix) - speedW));
          const pwdLine = prefix + pwdPad + theme.fg("dim", speedRight);

          // ── compute token totals from all entries, like default ────
          let input = 0,
            output = 0,
            cacheRead = 0,
            cacheWrite = 0,
            cost = 0;
          const entries = typeof ctx.sessionManager.getEntries === "function"
            ? ctx.sessionManager.getEntries()
            : ctx.sessionManager.getBranch();
          for (const e of entries) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              input += m.usage.input;
              output += m.usage.output;
              cacheRead += m.usage.cacheRead || 0;
              cacheWrite += m.usage.cacheWrite || 0;
              cost += m.usage.cost.total;
            }
          }

          // ── line 2 left: original stats plus context usage ─────────
          const statsParts: string[] = [];
          if (input) statsParts.push(`↑${formatTokens(input)}`);
          if (output) statsParts.push(`↓${formatTokens(output)}`);
          if (cacheRead) statsParts.push(`R${formatTokens(cacheRead)}`);
          if (cacheWrite) statsParts.push(`W${formatTokens(cacheWrite)}`);

          const usingSubscription = ctx.model ? ctx.modelRegistry?.isUsingOAuth?.(ctx.model) : false;
          if (cost || usingSubscription) {
            statsParts.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
          }

          const contextUsage = ctx.getContextUsage?.();
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined
            ? contextPercentValue.toFixed(1)
            : "?";
          const contextDisplay = contextPercent === "?"
            ? `?/${formatTokens(contextWindow)} (auto)`
            : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
          if (contextWindow) statsParts.push(contextDisplay);

          let left = theme.fg("dim", statsParts.join(" "));

          // ── line 2 right: provider, model, reasoning, speed ────────
          const providerCount = footerData.getAvailableProviderCount?.() ?? 1;
          const modelName = ctx.model?.id || "no-model";
          const providerPrefix = providerCount > 1 && ctx.model ? `(${ctx.model.provider}) ` : "";
          const reasoningLevel = pi.getThinkingLevel();
          const statuses = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, status]) => sanitizeStatusText(status))
            .filter((status) => status.length > 0);
          const statusText = statuses.length > 0 ? ` ${statuses.join(" ")}` : "";
          const rightText = `${providerPrefix}${modelName} (${reasoningLevel})${statusText}`;
          const right = theme.fg("dim", `${rightText}  `);

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

          // ── line 2 layout: stats | centred diff | right side ───────
          const leftW = visibleWidth(left);
          const centreW = visibleWidth(centre);
          const rightW = visibleWidth(right);
          let statsLine: string;

          if (centre) {
            const available = width - leftW - rightW;
            if (available > centreW + 2) {
              const padLeft = Math.floor((available - centreW) / 2);
              const padRight = available - centreW - padLeft;
              statsLine = left + " ".repeat(padLeft) + centre + " ".repeat(padRight) + right;
            } else {
              const pad = " ".repeat(Math.max(2, width - leftW - rightW));
              statsLine = left + pad + right;
            }
          } else {
            const pad = " ".repeat(Math.max(2, width - leftW - rightW));
            statsLine = left + pad + right;
          }

          return [pwdLine, truncateToWidth(statsLine, width)];
        },
      };
    });
  }
}
