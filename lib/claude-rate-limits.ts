import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CodexRateLimits, CodexRateLimitWindow } from "./codex-rate-limits.ts";

export interface ReadClaudeRateLimitsOptions {
  query?: typeof query;
  timeoutMs?: number;
}

export interface ClaudeRateLimits extends CodexRateLimits {
  fableUsedPercent?: number;
}

/**
 * Reads the Claude plan's five-hour, weekly, and Fable allowance usage behind Claude Code's `/usage`
 * command, through a short-lived Claude Code process that never starts a turn. Resolves to null
 * when plan limits do not apply, such as API-key, Bedrock, or Vertex authentication.
 */
export async function readClaudeRateLimits(
  options: ReadClaudeRateLimitsOptions = {},
): Promise<ClaudeRateLimits | null> {
  let release = () => {};
  const idle = new Promise<void>((resolve) => { release = resolve; });
  let timer: NodeJS.Timeout | undefined;
  const session = (options.query ?? query)({
    // An input stream that never yields keeps the process open for the usage request alone.
    prompt: (async function* () { await idle; })(),
    options: {
      settingSources: [],
      persistSession: false,
      // A usage read has no reason to connect the account's claude.ai MCP servers.
      env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0" },
    },
  });

  try {
    const usage = await Promise.race([
      session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Claude Code usage request timed out")),
          options.timeoutMs ?? 10_000,
        );
      }),
    ]);
    if (!usage.rate_limits_available || !usage.rate_limits) return null;

    const windows: CodexRateLimitWindow[] = [];
    for (const [window, windowDurationMins] of [
      [usage.rate_limits.five_hour, 300],
      [usage.rate_limits.seven_day, 10080],
    ] as const) {
      const usedPercent = window?.utilization;
      if (typeof usedPercent === "number" && Number.isFinite(usedPercent)) {
        windows.push({ usedPercent, windowDurationMins });
      }
    }
    const fableUsedPercent = usage.rate_limits.model_scoped
      ?.find((window) => window.display_name.toLowerCase() === "fable")?.utilization;
    return typeof fableUsedPercent === "number" && Number.isFinite(fableUsedPercent)
      ? { windows, fableUsedPercent }
      : { windows };
  } finally {
    clearTimeout(timer);
    release();
    session.close();
  }
}
