import {
  getMarkdownTheme,
  keyText,
  type MessageRenderer,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import {
  withMinimalToolOutput,
  type MinimalToolOutputOptions,
} from "../extensions/minimal-tool-output.ts";

const SUBAGENTS_RUNNING_EVENT = "sz-subagents:running";

const SUBAGENT_TOOL_NAMES = new Set([
  "subagent_spawn",
  "subagent_check",
  "subagent_wait",
  "subagent_cancel",
  "subagent_list",
]);

type SubagentStatusSource = {
  list(): Array<{
    id: string;
    name: string;
    status: string;
    model?: string;
    reasoningEffort?: string;
  }>;
  subscribe(listener: () => void): () => void;
};

type EventSink = {
  events: { emit(name: string, data: unknown): void };
};

// Publish running children and their current settings for the parent session's footer.
export function connectRunningSubagentStatus(
  pi: EventSink,
  source: SubagentStatusSource,
): () => void {
  let lastSignature: string | undefined;
  const publish = () => {
    const subagents = source.list()
      .filter(({ status }) => status === "running")
      .map(({ id, name, model, reasoningEffort }) => ({ id, name, model, reasoningEffort }));
    const signature = JSON.stringify(subagents);
    if (signature === lastSignature) return;
    lastSignature = signature;
    pi.events.emit(SUBAGENTS_RUNNING_EVENT, { subagents });
  };

  const unsubscribe = source.subscribe(publish);
  publish();
  return unsubscribe;
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value ? value.replace(/\s+/g, " ") : undefined;
}

// Keep delegation settings visible in compact call rows without exposing the prompt.
function subagentRendering(name: string): MinimalToolOutputOptions {
  return {
    nouns: ["call", "calls"],
    alwaysShowCall: true,
    formatCall(args, theme) {
      let detail: string | undefined;
      if (name === "subagent_spawn") {
        const childName = stringArg(args, "name");
        const harness = stringArg(args, "harness");
        const model = stringArg(args, "model");
        const reasoning = stringArg(args, "reasoning_effort");
        detail = [
          childName && harness ? `${childName} with ${harness}` : childName ?? harness,
          model?.replace(/^[^/]+\//, ""),
          reasoning,
        ].filter(Boolean).join(" · ");
      } else if (name === "subagent_check") {
        detail = stringArg(args, "id");
      } else if (name === "subagent_wait" || name === "subagent_cancel") {
        const ids = Array.isArray(args.ids)
          ? args.ids.filter((id): id is string => typeof id === "string")
          : [];
        detail = ids.length > 0 ? ids.join(", ") : undefined;
      }

      const title = theme.fg("toolTitle", name);
      return detail ? `${title} ${theme.fg("accent", detail)}` : title;
    },
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("\n");
}

export const renderSubagentResult: MessageRenderer = (message, { expanded }, theme) => {
  const content = messageText(message.content);
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  const label = theme.fg("customMessageLabel", theme.bold("[subagent]"));

  if (!expanded) {
    const summary = content.split(/\r?\n/, 1)[0]?.trim() || "Subagent finished";
    box.addChild(new Text(
      `${label} ${theme.fg("customMessageText", summary)}`
        + theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`),
      0,
      0,
    ));
    return box;
  }

  box.addChild(new Text(label, 0, 0));
  box.addChild(new Markdown(
    content,
    0,
    0,
    getMarkdownTheme(),
    { color: (value) => theme.fg("customMessageText", value) },
  ));
  return box;
};

// Persist Pi's inherited model with the result so restored rows do not use today's parent model.
export function withMinimalSubagentOutput<TParams extends TSchema, TDetails>(
  tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
  if (!SUBAGENT_TOOL_NAMES.has(tool.name)) return tool;
  const minimal = withMinimalToolOutput(tool, subagentRendering(tool.name));
  if (tool.name !== "subagent_spawn") return minimal;

  return {
    ...minimal,
    async execute(id, params, signal, onUpdate, ctx) {
      const args = params as Record<string, unknown>;
      const inheritedModel = !args.model && args.harness === "pi" && ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
      const result = await tool.execute(id, params, signal, onUpdate, ctx);
      return inheritedModel
        ? { ...result, details: { ...result.details, subagentModel: inheritedModel } }
        : result;
    },
    renderCall(args, theme, context) {
      // The call slot renders before the result slot; read their shared state at paint time.
      return {
        render(width) {
          const model = stringArg(context.state ?? {}, "subagentModel");
          return minimal.renderCall!({ ...args, ...(model ? { model } : {}) }, theme, context).render(width);
        },
        invalidate() {},
      };
    },
    renderResult(result, options, theme, context) {
      if (result.details && typeof result.details === "object" && context.state) {
        context.state.subagentModel = stringArg(result.details as Record<string, unknown>, "subagentModel");
      }
      return minimal.renderResult!(result, options, theme, context);
    },
  };
}
