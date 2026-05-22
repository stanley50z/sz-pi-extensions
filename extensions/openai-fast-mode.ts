import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  registerApiProvider,
  streamOpenAICodexResponses,
  streamOpenAIResponses,
  streamSimpleOpenAICodexResponses,
  streamSimpleOpenAIResponses,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
  type StreamOptions,
} from "@earendil-works/pi-ai";

type SupportedApi = "openai-responses" | "openai-codex-responses";
type StreamDelegate<TApi extends SupportedApi, TOptions extends StreamOptions> = StreamFunction<TApi, TOptions>;

const STATUS_KEY = "openai-fast-mode";
const SOURCE_ID = "sz-openai-fast-mode";
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

export function withPriorityServiceTier<TApi extends SupportedApi, TOptions extends StreamOptions>(
  delegate: StreamDelegate<TApi, TOptions>,
  isEnabled: () => boolean,
): StreamDelegate<TApi, TOptions> {
  return (model: Model<TApi>, context: Context, options?: TOptions) => {
    const nextOptions = isEnabled()
      ? ({ ...(options ?? {}), serviceTier: "priority" } as TOptions)
      : options;
    return delegate(model, context, nextOptions);
  };
}

function registerWrappedProviders(): void {
  registerApiProvider(
    {
      api: "openai-responses",
      stream: withPriorityServiceTier(streamOpenAIResponses, () => enabled),
      streamSimple: withPriorityServiceTier(
        streamSimpleOpenAIResponses as StreamDelegate<"openai-responses", SimpleStreamOptions>,
        () => enabled,
      ),
    },
    SOURCE_ID,
  );

  registerApiProvider(
    {
      api: "openai-codex-responses",
      stream: withPriorityServiceTier(streamOpenAICodexResponses, () => enabled),
      streamSimple: withPriorityServiceTier(
        streamSimpleOpenAICodexResponses as StreamDelegate<"openai-codex-responses", SimpleStreamOptions>,
        () => enabled,
      ),
    },
    SOURCE_ID,
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("fast", {
    description: "Start with OpenAI fast mode enabled",
    type: "boolean",
    default: false,
  });

  enabled = pi.getFlag("fast") === true;
  registerWrappedProviders();

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
