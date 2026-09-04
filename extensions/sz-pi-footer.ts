/**
 * sz-pi-footer — enhanced pi footer with token speed and git diff stats.
 *
 * Shows the default footer info plus:
 * - Token speed (live output tokens/second, finalized for the most recent response)
 * - Clickable Git diff stats (+X −Y) centred when the session is in a repository
 * - Up to five changed files below the footer when the Git stats are expanded
 * - A temporary line naming any running subagents
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  estimateTokens,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  readCodexRateLimits,
  type CodexRateLimitWindow,
} from "../lib/codex-rate-limits.ts";
import type { GitDiffSummary } from "./sz-git-view/collector.ts";
import {
  GIT_VIEW_SUMMARY_GLOBAL_KEY,
  GIT_VIEW_UPDATE_EVENT,
} from "./sz-git-view/index.ts";

const CODEX_RATE_LIMITS_EVENT = "sz-codex-rate-limits:update";
const SUBAGENTS_RUNNING_EVENT = "sz-subagents:running";

type GlobalWithGitViewSummary = typeof globalThis & {
  [GIT_VIEW_SUMMARY_GLOBAL_KEY]?: GitDiffSummary | null;
};

function getGlobalGitViewSummary(): GitDiffSummary | null {
  return (globalThis as GlobalWithGitViewSummary)[GIT_VIEW_SUMMARY_GLOBAL_KEY] ?? null;
}

function extractGitViewSummary(data: unknown): GitDiffSummary | null | undefined {
  if (!data || typeof data !== "object" || !("summary" in data)) return undefined;
  const summary = (data as { summary?: unknown }).summary;
  if (summary === null) return null;
  if (!summary || typeof summary !== "object") return undefined;

  const candidate = summary as Partial<GitDiffSummary>;
  if (
    typeof candidate.added !== "number" ||
    typeof candidate.deleted !== "number" ||
    !Array.isArray(candidate.files) ||
    candidate.files.some((file) =>
      !file ||
      typeof file.path !== "string" ||
      typeof file.added !== "number" ||
      typeof file.deleted !== "number"
    )
  ) {
    return undefined;
  }
  return candidate as GitDiffSummary;
}

type RunningSubagent = { id: string; name: string };

function extractRunningSubagents(data: unknown): RunningSubagent[] | undefined {
  if (!data || typeof data !== "object" || !("subagents" in data)) return undefined;
  const subagents = (data as { subagents?: unknown }).subagents;
  if (!Array.isArray(subagents)) return undefined;

  const parsed: RunningSubagent[] = [];
  for (const subagent of subagents) {
    if (!subagent || typeof subagent !== "object") return undefined;
    const { id, name } = subagent as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string") return undefined;
    parsed.push({ id, name });
  }
  return parsed;
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
let generationStart: number | null = null;
let liveOutputTokensPerSec: number | null = null;
let lastOutputTokensPerSec: number | null = null;
let speedFinalizedForTurn = false;

function resetSpeed() {
  lastTurnStart = null;
  generationStart = null;
  liveOutputTokensPerSec = null;
  lastOutputTokensPerSec = null;
  speedFinalizedForTurn = false;
}

// ── extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let _ctx: ExtensionContext | null = null;
  let gitDiffSummary = getGlobalGitViewSummary();
  let gitDetailsExpanded = false;
  let codexRateLimitWindows: CodexRateLimitWindow[] | null = null;
  let codexRateLimitStatus: "hidden" | "loading" | "ready" | "error" = "hidden";
  let runningSubagents: RunningSubagent[] = [];
  let rateLimitRefresh: Promise<void> | null = null;
  let requestFooterRender: (() => void) | null = null;

  const unsubscribeGitView = pi.events.on(GIT_VIEW_UPDATE_EVENT, (data) => {
    const summary = extractGitViewSummary(data);
    if (summary === undefined) return;
    gitDiffSummary = summary;
    if (summary === null) gitDetailsExpanded = false;
    requestFooterRender?.();
  });

  const unsubscribeCodexRateLimits = pi.events.on(CODEX_RATE_LIMITS_EVENT, (data) => {
    const windows = extractCodexRateLimitWindows(data);
    if (windows === undefined) return;
    codexRateLimitWindows = windows;
    codexRateLimitStatus = "ready";
    if (_ctx) installFooter(_ctx);
  });

  const unsubscribeRunningSubagents = pi.events.on(SUBAGENTS_RUNNING_EVENT, (data) => {
    const subagents = extractRunningSubagents(data);
    if (subagents === undefined) return;
    runningSubagents = subagents;
    requestFooterRender?.();
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
    gitDiffSummary = getGlobalGitViewSummary();
    gitDetailsExpanded = false;
    resetSpeed();
    runningSubagents = [];
    codexRateLimitStatus = usesChatGptSubscription(ctx) ? "loading" : "hidden";
    codexRateLimitWindows = null;
    installFooter(ctx);
    refreshCodexRateLimits(ctx);
  });

  pi.on("session_shutdown", async () => {
    unsubscribeGitView();
    unsubscribeCodexRateLimits();
    unsubscribeRunningSubagents();
    requestFooterRender = null;
    _ctx = null;
  });

  // ── track token speed ──────────────────────────────────────────────
  pi.on("turn_start", async () => {
    lastTurnStart = Date.now();
    speedFinalizedForTurn = false;
  });

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    generationStart = Date.now();
    liveOutputTokensPerSec = null;
    requestFooterRender?.();
  });

  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant") return;
    generationStart ??= Date.now();

    const elapsedSec = (Date.now() - generationStart) / 1000;
    const reportedTokens = event.message.usage.output;
    const outputTokens = reportedTokens > 0 ? reportedTokens : estimateTokens(event.message);
    if (elapsedSec > 0 && outputTokens > 0) {
      liveOutputTokensPerSec = outputTokens / elapsedSec;
      requestFooterRender?.();
    }
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;

    const elapsedSec = generationStart === null
      ? 0
      : (Date.now() - generationStart) / 1000;
    const outputTokens = event.message.usage.output;
    if (elapsedSec > 0 && outputTokens > 0) {
      lastOutputTokensPerSec = outputTokens / elapsedSec;
      speedFinalizedForTurn = true;
    } else if (liveOutputTokensPerSec !== null && liveOutputTokensPerSec > 0) {
      lastOutputTokensPerSec = liveOutputTokensPerSec;
    }

    generationStart = null;
    liveOutputTokensPerSec = null;
    requestFooterRender?.();
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
    // Compatibility fallback for runtimes that do not emit assistant message
    // lifecycle events. Current runtimes finalize from message_end instead so
    // provider wait time and tool execution are excluded from generation speed.
    if (!speedFinalizedForTurn && lastTurnStart !== null) {
      const message = _event.message;
      if (message.role === "assistant") {
        const elapsedSec = (Date.now() - lastTurnStart) / 1000;
        const outputTokens = message.usage.output;
        if (elapsedSec > 0 && outputTokens > 0) {
          lastOutputTokensPerSec = outputTokens / elapsedSec;
        }
      }
    }

    generationStart = null;
    liveOutputTokensPerSec = null;
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
      const renderFooter = () => tui.requestRender();
      requestFooterRender = renderFooter;
      const unsub = footerData.onBranchChange(renderFooter);
      let diffHitbox: { start: number; end: number; row: number } | null = null;

      return {
        dispose() {
          unsub();
          if (requestFooterRender === renderFooter) requestFooterRender = null;
        },
        invalidate() {},
        handleMouse(event: TuiMouseEvent) {
          if (
            event.type !== "click" ||
            event.button !== "left" ||
            !diffHitbox ||
            event.y !== diffHitbox.row ||
            event.x < diffHitbox.start ||
            event.x >= diffHitbox.end
          ) {
            return undefined;
          }

          gitDetailsExpanded = !gitDetailsExpanded;
          tui.requestRender();
          return { handled: true, render: false };
        },
        render(width: number): string[] {
          diffHitbox = null;
          // ── line 1: cwd, git branch, session name, token speed ─────
          const outputTokensPerSec = liveOutputTokensPerSec ?? lastOutputTokensPerSec;
          const speedText = outputTokensPerSec !== null && outputTokensPerSec > 0
            ? outputTokensPerSec >= 100
              ? `${Math.round(outputTokensPerSec)} tok/s`
              : `${outputTokensPerSec.toFixed(1)} tok/s`
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

          // ── centred Git diff and subscription usage ──────────────
          const centreParts: string[] = [];
          let colouredDiff = "";
          if (gitDiffSummary) {
            colouredDiff = theme.underline(
              theme.fg("success", `+${gitDiffSummary.added}`) +
              "  " +
              theme.fg("error", `−${gitDiffSummary.deleted}`),
            );
            centreParts.push(colouredDiff);
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
              if (colouredDiff) {
                const start = leftW + padLeft;
                diffHitbox = { start, end: start + visibleWidth(colouredDiff), row: 1 };
              }
            } else {
              const pad = " ".repeat(Math.max(2, width - leftW - rightW));
              statsLine = left + pad + right;
            }
          } else {
            const pad = " ".repeat(Math.max(2, width - leftW - rightW));
            statsLine = left + pad + right;
          }

          const lines = [pwdLine, truncateToWidth(statsLine, width)];
          if (gitDetailsExpanded && gitDiffSummary) {
            const mostChanged = [...gitDiffSummary.files]
              .sort((a, b) =>
                (b.added + b.deleted) - (a.added + a.deleted) || a.path.localeCompare(b.path)
              )
              .slice(0, 5);
            for (const file of mostChanged) {
              const counts = `+${file.added} -${file.deleted}`;
              const countsWidth = visibleWidth(counts);
              if (width <= countsWidth + 4) {
                lines.push(truncateToWidth(theme.fg("success", counts), width, ""));
                continue;
              }
              const path = truncateToWidth(file.path, width - countsWidth - 4, "...");
              lines.push(
                "  " +
                theme.fg("dim", path) +
                "  " +
                theme.fg("success", `+${file.added}`) +
                " " +
                theme.fg("error", `-${file.deleted}`),
              );
            }
          }
          if (runningSubagents.length > 0) {
            const count = runningSubagents.length;
            const topics = runningSubagents
              .map(({ name }) => truncateToWidth(sanitizeStatusText(name), 24, "..."))
              .join(", ");
            const label = `${count} subagent${count === 1 ? "" : "s"} running · ${topics}`;
            lines.push(theme.fg("dim", truncateToWidth(label, width)));
          }
          return lines;
        },
      };
    });
  }
}
