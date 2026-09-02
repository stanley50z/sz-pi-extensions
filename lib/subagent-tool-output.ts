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

const SUBAGENT_TOOL_NAMES = new Set([
  "subagent_spawn",
  "subagent_check",
  "subagent_wait",
  "subagent_cancel",
  "subagent_list",
]);

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value ? value.replace(/\s+/g, " ") : undefined;
}

function subagentRendering(name: string): MinimalToolOutputOptions {
  return {
    nouns: ["call", "calls"],
    formatCall(args, theme) {
      let detail: string | undefined;
      if (name === "subagent_spawn") {
        const childName = stringArg(args, "name");
        const harness = stringArg(args, "harness");
        detail = childName && harness ? `${childName} with ${harness}` : childName ?? harness;
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

export function withMinimalSubagentOutput<TParams extends TSchema, TDetails>(
  tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
  return SUBAGENT_TOOL_NAMES.has(tool.name)
    ? withMinimalToolOutput(tool, subagentRendering(tool.name))
    : tool;
}
