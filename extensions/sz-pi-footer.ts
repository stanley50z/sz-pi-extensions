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
import { execFileSync } from "node:child_process";
import {
  readCodexRateLimits,
  type CodexRateLimitWindow,
} from "../lib/codex-rate-limits.ts";

const STATUS_KEY = "sz-footer";
const GIT_VIEW_URL_EVENT = "sz-git-view:url";
const CODEX_RATE_LIMITS_EVENT = "sz-codex-rate-limits:update";
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

function extractCodexRateLimitWindows(data: unknown): CodexRateLimitWindow[] | undefined {
  if (!data || typeof data !== "object" || !("windows" in data)) return undefined;
  const windows = (data as { windows?: unknown }).windows;
  if (!Array.isArray(windows)) return undefined;

  const parsed: CodexRateLimitWindow[] = [];
  for (const window of windows) {
    if (!window || typeof window !== "object") return undefined;
    const { usedPercent, windowDurationMins } = window as Record<string, unknown>;
    if (
      typeof usedPercent !== "number" ||
      !Number.isFinite(usedPercent) ||
      typeof windowDurationMins !== "number" ||
      !Number.isSafeInteger(windowDurationMins) ||
      windowDurationMins <= 0
    ) {
      return undefined;
    }
    parsed.push({ usedPercent, windowDurationMins });
  }
  return parsed;
}

function formatCodexRateLimits(
  status: "hidden" | "loading" | "ready" | "error",
  windows: CodexRateLimitWindow[] | null,
): string | null {
  if (status === "hidden") return null;
  if (status === "loading") return "5h:… wk:…";
  if (status === "error") return "5h:! wk:!";

  const percentageFor = (duration: number) => {
    const window = windows?.find((candidate) => candidate.windowDurationMins === duration);
    return window ? `${Math.round(window.usedPercent)}%` : "—";
  };
  return `5h:${percentageFor(300)} wk:${percentageFor(10080)}`;
}

// ── git diff helpers ──────────────────────────────────────────────────

function getDiffStats(cwd: string): string | null {
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--git-dir"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    });

    const out = execFileSync("git", ["-C", cwd, "diff", "--shortstat", "HEAD"], {
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

const costFormatter = new Intl.NumberFormat("en-US", {
  minimumSignificantDigits: 3,
  maximumSignificantDigits: 3,
  useGrouping: false,
});

function formatCost(cost: number): string {
  return costFormatter.format(cost);
}

function compactPath(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatProviderName(provider: string): string {
  return provider === "openai-codex" ? "OpenAI" : provider;
}

function formatModelName(model: string): string {
  if (model === "gpt-5.6-sol") return "5.6 Sol";
  if (model === "gpt-5.6-luna") return "5.6 Luna";
  return model;
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
  let codexRateLimitWindows: CodexRateLimitWindow[] | null = null;
  let codexRateLimitStatus: "hidden" | "loading" | "ready" | "error" = "hidden";
  let rateLimitRefresh: Promise<void> | null = null;

  const unsubscribeGitViewUrl = pi.events.on(GIT_VIEW_URL_EVENT, (data) => {
    const nextUrl = extractGitViewUrl(data);
    if (nextUrl === undefined) return;
    gitViewUrl = nextUrl;
    if (_ctx) installFooter(_ctx);
  });

  const unsubscribeCodexRateLimits = pi.events.on(CODEX_RATE_LIMITS_EVENT, (data) => {
    const windows = extractCodexRateLimitWindows(data);
    if (windows === undefined) return;
    codexRateLimitWindows = windows;
    codexRateLimitStatus = "ready";
    if (_ctx) installFooter(_ctx);
  });

  function usesChatGptSubscription(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === "openai-codex" &&
      Boolean(ctx.modelRegistry?.isUsingOAuth?.(ctx.model));
  }

  function refreshCodexRateLimits(ctx: ExtensionContext): void {
    if (!usesChatGptSubscription(ctx)) {
      codexRateLimitStatus = "hidden";
      codexRateLimitWindows = null;
      return;
    }
    if (rateLimitRefresh) return;

    if (codexRateLimitStatus !== "ready") codexRateLimitStatus = "loading";
    const task = (async () => {
      try {
        const limits = await readCodexRateLimits();
        pi.events.emit(CODEX_RATE_LIMITS_EVENT, limits);
      } catch {
        codexRateLimitStatus = "error";
        codexRateLimitWindows = null;
        if (_ctx) installFooter(_ctx);
      }
    })();
    rateLimitRefresh = task;
    void task.finally(() => {
      if (rateLimitRefresh === task) rateLimitRefresh = null;
    });
  }

  // ── store context ──────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    _ctx = ctx;
    gitViewUrl = getGlobalGitViewUrl();
    resetSpeed();
    codexRateLimitStatus = usesChatGptSubscription(ctx) ? "loading" : "hidden";
    codexRateLimitWindows = null;
    installFooter(ctx);
    refreshCodexRateLimits(ctx);
  });

  pi.on("session_shutdown", async () => {
    unsubscribeGitViewUrl();
    unsubscribeCodexRateLimits();
    _ctx = null;
  });

  // ── track turn timing ──────────────────────────────────────────────
  pi.on("turn_start", async () => {
    lastTurnStart = Date.now();
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    installFooter(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    codexRateLimitStatus = usesChatGptSubscription(ctx) ? "loading" : "hidden";
    codexRateLimitWindows = null;
    installFooter(ctx);
    refreshCodexRateLimits(ctx);
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
    refreshCodexRateLimits(ctx);
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
          const speedRight = speedText;
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
          const sessionMaxWidth = Math.max(1, availableBeforeSpeed - minGap - 1);
          const sessionText = sessionName
            ? truncateToWidth(sessionName, sessionMaxWidth, "...")
            : "";
          const sessionW = visibleWidth(sessionText);
          const pwdMaxWidth = sessionText
            ? Math.max(1, availableBeforeSpeed - sessionW - minGap)
            : availableBeforeSpeed;
          const pwdText = truncateToWidth(pwd, pwdMaxWidth, "...");
          const pwdW = visibleWidth(pwdText);

          let prefix: string;
          if (sessionText) {
            const centeredStart = Math.floor((width - sessionW) / 2);
            const minimumStart = pwdW + minGap;
            const maximumStart = availableBeforeSpeed - sessionW;
            const sessionStart = Math.min(Math.max(centeredStart, minimumStart), maximumStart);
            prefix = theme.fg("dim", pwdText) +
              " ".repeat(Math.max(minGap, sessionStart - pwdW)) +
              theme.fg("dim", sessionText);
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
          statsParts.push(`$${formatCost(cost)}`);

          const contextPercent = ctx.getContextUsage?.()?.percent;
          if (contextPercent !== null && contextPercent !== undefined) {
            statsParts.push(`ctx:${Math.round(contextPercent)}%`);
          }

          let left = theme.fg("dim", statsParts.join(" "));

          // ── line 2 right: provider, model, reasoning, speed ────────
          const providerCount = footerData.getAvailableProviderCount?.() ?? 1;
          const modelName = formatModelName(ctx.model?.id || "no-model");
          const providerPrefix = providerCount > 1 && ctx.model
            ? `(${formatProviderName(ctx.model.provider)}) `
            : "";
          const reasoningLevel = pi.getThinkingLevel();
          const statuses = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, status]) => sanitizeStatusText(status))
            .filter((status) => status.length > 0);
          const statusText = statuses.length > 0 ? ` ${statuses.join(" ")}` : "";
          const rightText = `${providerPrefix}${modelName} @${reasoningLevel}${statusText}`;
          const right = theme.fg("dim", rightText);

          // ── centred git diff and subscription usage ──────────────
          const centreParts: string[] = [];
          const diff = getDiffStats(cwd);
          if (diff) {
            const coloured = diff.replace(
              /^(\+\d+)\s+(−\d+)$/,
              (_, adds: string, dels: string) =>
                theme.fg("success", adds) + " " + theme.fg("dim", " ") + theme.fg("error", dels),
            );
            centreParts.push(gitViewUrl ? hyperlink(coloured, gitViewUrl) : coloured);
          }
          const rateLimitsText = formatCodexRateLimits(codexRateLimitStatus, codexRateLimitWindows);
          if (usingSubscription && rateLimitsText) {
            centreParts.push(theme.fg("dim", rateLimitsText));
          } else if (!usingSubscription) {
            centreParts.push(theme.fg("dim", "API"));
          }
          const centre = centreParts.join("  ");

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
