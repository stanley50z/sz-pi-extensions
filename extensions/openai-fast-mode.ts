import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "openai-fast-mode";
const STATE_FILENAME = "openai-fast-mode.json";
const FAST_MODE_ENV = "PI_OPENAI_FAST_MODE";
const SUPPORTED_APIS = new Set<Api>(["openai-responses", "openai-codex-responses"]);

function readEnabled(statePath: string): boolean {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { enabled?: unknown };
    if (typeof state.enabled !== "boolean") throw new Error('expected an "enabled" boolean');
    return state.enabled;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Cannot read fast mode state from ${statePath}: ${(error as Error).message}`);
  }
}

function writeEnabled(statePath: string, enabled: boolean): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({ enabled })}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, statePath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function isSupportedModel(model: Model<Api> | undefined): boolean {
  return Boolean(model && SUPPORTED_APIS.has(model.api));
}

function statusText(enabled: boolean, ctx: ExtensionContext): string | undefined {
  return enabled && isSupportedModel(ctx.model) ? "⚡fast" : undefined;
}

export default function (pi: ExtensionAPI) {
  const statePath = join(getAgentDir(), STATE_FILENAME);
  const persistedEnabled = readEnabled(statePath);

  pi.registerFlag("fast", {
    description: "Start with OpenAI fast mode enabled",
    type: "boolean",
    default: persistedEnabled,
  });

  let enabled = pi.getFlag("fast") === true;
  const hasStartupOverride = enabled !== persistedEnabled;
  let sessionContext: ExtensionContext | undefined;
  let stateWatcher: FSWatcher | undefined;
  let syncTimer: NodeJS.Timeout | undefined;

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, statusText(enabled, ctx));
  }

  function notifyState(ctx: ExtensionContext): void {
    updateStatus(ctx);
    ctx.ui.notify(`Fast mode: ${enabled ? "on" : "off"}`, "info");
  }

  function applyEnabled(nextEnabled: boolean): void {
    enabled = nextEnabled;
    process.env[FAST_MODE_ENV] = nextEnabled ? "1" : "0";
  }

  function setEnabled(nextEnabled: boolean, ctx: ExtensionContext): void {
    writeEnabled(statePath, nextEnabled);
    applyEnabled(nextEnabled);
    notifyState(ctx);
  }

  function syncFromDisk(): void {
    const nextEnabled = readEnabled(statePath);
    if (nextEnabled === enabled) return;
    applyEnabled(nextEnabled);
    if (sessionContext) updateStatus(sessionContext);
  }

  function startWatching(ctx: ExtensionContext): void {
    sessionContext = ctx;
    mkdirSync(dirname(statePath), { recursive: true });
    stateWatcher?.close();
    stateWatcher = watch(dirname(statePath), { persistent: false }, (_eventType, filename) => {
      if (filename && filename.toString() !== STATE_FILENAME) return;
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        syncTimer = undefined;
        try {
          syncFromDisk();
        } catch (error) {
          ctx.ui.notify(`Fast mode sync failed: ${(error as Error).message}`, "error");
        }
      }, 20);
      syncTimer.unref();
    });
    stateWatcher.on("error", (error) => {
      ctx.ui.notify(`Fast mode sync failed: ${error.message}`, "error");
    });
  }

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !isSupportedModel(ctx.model)) return;
    return { ...(event.payload as Record<string, unknown>), service_tier: "priority" };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (hasStartupOverride) writeEnabled(statePath, enabled);
    else enabled = readEnabled(statePath);
    applyEnabled(enabled);
    startWatching(ctx);
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = undefined;
    stateWatcher?.close();
    stateWatcher = undefined;
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.registerCommand("fast", {
    description: "Toggle OpenAI fast mode",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const values = ["on", "off", "status"];
      const items = values
        .filter((value) => value.startsWith(normalized))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();

      if (command === "") {
        setEnabled(!enabled, ctx);
        return;
      }

      if (command === "on") {
        setEnabled(true, ctx);
        return;
      }

      if (command === "off") {
        setEnabled(false, ctx);
        return;
      }

      if (command === "status") {
        updateStatus(ctx);
        const support = isSupportedModel(ctx.model) ? "supported" : "unsupported";
        ctx.ui.notify(`Fast mode: ${enabled ? "on" : "off"} (${support})`, "info");
        return;
      }

      ctx.ui.notify("Usage: /fast [on|off|status]", "error");
    },
  });
}
