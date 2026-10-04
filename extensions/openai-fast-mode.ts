import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "openai-fast-mode";
const SUPPORTED_APIS = new Set<Api>(["openai-responses", "openai-codex-responses"]);
type ServiceTier = "priority" | "ultrafast";

// Checks request API compatibility, not account or model entitlement to a tier.
function isSupportedModel(model: Model<Api> | undefined): boolean {
  return Boolean(model && SUPPORTED_APIS.has(model.api));
}

// Adds mutually exclusive, session-local OpenAI speed commands.
export default function (pi: ExtensionAPI) {
  pi.registerFlag("fast", {
    description: "Start with OpenAI fast mode enabled",
    type: "boolean",
    default: false,
  });

  let tier: ServiceTier | undefined = pi.getFlag("fast") === true ? "priority" : undefined;

  function updateStatus(ctx: ExtensionContext): void {
    const text = tier && isSupportedModel(ctx.model)
      ? tier === "priority" ? "⚡fast" : "⚡ultrafast"
      : undefined;
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  pi.on("before_provider_request", (event, ctx) => {
    if (!tier || !isSupportedModel(ctx.model)) return;
    return { ...(event.payload as Record<string, unknown>), service_tier: tier };
  });

  pi.on("session_start", async (_event, ctx) => {
    tier = pi.getFlag("fast") === true ? "priority" : undefined;
    updateStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });

  for (const [name, commandTier, label] of [
    ["fast", "priority", "Fast"],
    ["ultrafast", "ultrafast", "Ultrafast"],
  ] as const) {
    pi.registerCommand(name, {
      description: `Toggle OpenAI ${name} mode`,
      getArgumentCompletions: name === "fast" ? (prefix: string) => {
        const normalized = prefix.trim().toLowerCase();
        const items = ["on", "off", "status"]
          .filter((value) => value.startsWith(normalized))
          .map((value) => ({ value, label: value }));
        return items.length > 0 ? items : null;
      } : undefined,
      handler: async (args, ctx) => {
        const command = args.trim().toLowerCase();
        if (name === "ultrafast" && command !== "") {
          ctx.ui.notify("Usage: /ultrafast", "error");
          return;
        }
        if (command === "status") {
          updateStatus(ctx);
          const support = isSupportedModel(ctx.model) ? "supported" : "unsupported";
          ctx.ui.notify(`${label} mode: ${tier === commandTier ? "on" : "off"} (${support})`, "info");
          return;
        }
        if (command === "") tier = tier === commandTier ? undefined : commandTier;
        else if (command === "on") tier = commandTier;
        else if (command === "off") tier = undefined;
        else {
          ctx.ui.notify(`Usage: /${name} [on|off|status]`, "error");
          return;
        }
        updateStatus(ctx);
        ctx.ui.notify(`${label} mode: ${tier === commandTier ? "on" : "off"}`, "info");
      },
    });
  }
}
