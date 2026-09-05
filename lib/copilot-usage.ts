import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type CopilotUsage = { status: "ready"; usd: number } | { status: "unavailable" };

interface CopilotUsageOptions {
  authPath?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const unavailable: CopilotUsage = { status: "unavailable" };

// Narrow untrusted credential and API objects before reading their fields.
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

// Only the upcoming UTC monthly boundary identifies the current month's snapshot.
function currentReset(value: unknown, now: number): boolean {
  const date = new Date(now);
  return typeof value === "string" && /Z$/.test(value) &&
    Date.parse(value) === Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

// Own one reader per footer instance; peek on render, read on events, dispose at shutdown.
export function createCopilotUsageReader(options: CopilotUsageOptions = {}) {
  const now = options.now ?? Date.now;
  let identity = "";
  let cached: CopilotUsage = unavailable;
  let reset: unknown;
  let lastAttempt = -Infinity;
  let active: { controller: AbortController; task: Promise<CopilotUsage> } | undefined;
  let disposed = false;

  // Re-read Pi's effective auth file even during the request throttle window.
  function credential() {
    const path = options.authPath ?? join(getAgentDir(), "auth.json");
    const auth = record(JSON.parse(readFileSync(path, "utf8")));
    const entry = record(auth["github-copilot"]);
    if (entry.type !== "oauth" || typeof entry.refresh !== "string" ||
      !entry.refresh.trim() || entry.enterpriseUrl != null) throw new Error("Unsupported Copilot auth");
    return { token: entry.refresh, identity: createHash("sha256").update(path).update("\0").update(entry.refresh).digest("hex") };
  }

  // Invalidate outstanding results when the model leaves Copilot or auth changes.
  function cancel() {
    active?.controller.abort();
    active = undefined;
    cached = unavailable;
    identity = "";
    lastAttempt = -Infinity;
  }

  return {
    // Revalidate cached usage for rendering without starting a network request.
    peek(): CopilotUsage {
      if (disposed) return unavailable;
      try {
        if (credential().identity !== identity) cancel();
      } catch {
        cancel();
      }
      return cached;
    },
    async read(): Promise<CopilotUsage> {
      if (disposed) return unavailable;
      let auth: ReturnType<typeof credential>;
      try {
        auth = credential();
      } catch {
        cancel();
        return unavailable;
      }
      if (auth.identity !== identity) {
        cancel();
        identity = auth.identity;
      }
      if (active) return active.task;
      if (cached.status === "ready" && !currentReset(reset, now())) cached = unavailable;
      if (now() - lastAttempt < 60_000) return cached;
      lastAttempt = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
      const task = (async (): Promise<CopilotUsage> => {
        let result = unavailable;
        try {
          const response = await (options.fetch ?? fetch)("https://api.github.com/copilot_internal/user", {
            headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json", "User-Agent": "sz-pi-footer" },
            redirect: "error",
            signal: controller.signal,
          });
          if (response.ok) {
            const data = record(await response.json());
            const credits = record(record(data.quota_snapshots).premium_interactions).credits_used;
            if (data.token_based_billing === true && typeof credits === "number" &&
              Number.isFinite(credits) && credits >= 0 && currentReset(data.quota_reset_date_utc, now())) {
              result = { status: "ready", usd: credits / 100 };
              if (!controller.signal.aborted) reset = data.quota_reset_date_utc;
            }
          }
          if (credential().identity !== auth.identity) result = unavailable;
        } catch {
          // Never propagate auth contents, response bodies, or transport error messages.
          result = unavailable;
        } finally {
          clearTimeout(timer);
        }
        if (controller.signal.aborted || disposed) result = unavailable;
        return result;
      })();
      active = { controller, task };
      void task.then((result) => {
        if (active?.controller === controller) {
          cached = result;
          active = undefined;
        }
      });
      return task;
    },
    cancel,
    dispose() { disposed = true; cancel(); },
  };
}
