import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "openai-fast-mode";
const SUPPORTED_APIS = new Set<Api>(["openai-responses", "openai-codex-responses"]);

let enabled = false;

function isSupportedModel(model: Model<Api> | undefined): boolean {
  return Boolean(model && SUPPORTED_APIS.has(model.api));
}

function statusText(ctx: ExtensionContext): string | undefined {
  return enabled && isSupportedModel(ctx.model) ? "⚡ fast" : undefined;
}

function updateStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus(STATUS_KEY, statusText(ctx));
}

function notifyState(ctx: ExtensionContext): void {
  updateStatus(ctx);
  ctx.ui.notify(`Fast mode: ${enabled ? "on" : "off"}`, "info");
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("fast", {
    description: "Start with OpenAI fast mode enabled",
    type: "boolean",
    default: false,
  });

  enabled = pi.getFlag("fast") === true;

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !isSupportedModel(ctx.model)) return;
    return { ...(event.payload as Record<string, unknown>), service_tier: "priority" };
  });

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
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
        enabled = !enabled;
        notifyState(ctx);
        return;
      }

      if (command === "on") {
        enabled = true;
        notifyState(ctx);
        return;
      }

      if (command === "off") {
        enabled = false;
        notifyState(ctx);
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
