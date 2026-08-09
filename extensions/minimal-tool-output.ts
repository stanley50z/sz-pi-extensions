import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { Box, Container, Markdown, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";

function createBuiltInTools(cwd: string) {
  return {
    read: createReadTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    find: createFindTool(cwd),
    grep: createGrepTool(cwd),
    ls: createLsTool(cwd),
  };
}

type BuiltInTools = ReturnType<typeof createBuiltInTools>;
type BuiltInToolName = keyof BuiltInTools;

type ToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type ToolGroup = {
  firstId: string;
  count: number;
  narrative?: string;
  narrativeType?: "assistant" | "assistant-thinking";
};

type UltraCollapsedGroup = ToolGroup & {
  callIds: Set<string>;
};

const toolCache = new Map<string, BuiltInTools>();
const collapsedGroups = new Map<string, ToolGroup>();
const ultraCollapsedGroups = new Map<string, UltraCollapsedGroup>();
const inlineNarratives = new Set<string>();
const renderInvalidators = new Map<string, () => void>();
let activeUltraCollapsedGroup: UltraCollapsedGroup | undefined;

const groupedNouns: Record<BuiltInToolName, [singular: string, plural: string]> = {
  read: ["file", "files"],
  bash: ["command", "commands"],
  edit: ["file", "files"],
  write: ["file", "files"],
  find: ["search", "searches"],
  grep: ["search", "searches"],
  ls: ["directory", "directories"],
};

class OneLine implements Component {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return width > 0 ? [truncateToWidth(this.text, width)] : [];
  }

  invalidate(): void {}
}

function getBuiltInTools(cwd: string): BuiltInTools {
  let tools = toolCache.get(cwd);
  if (!tools) {
    tools = createBuiltInTools(cwd);
    toolCache.set(cwd, tools);
  }
  return tools;
}

function isToolCallContent(value: unknown): value is ToolCallContent {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ToolCallContent>;
  return item.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string";
}

function inlineNarrative(
  content: readonly unknown[],
): { markdown: string; type: "assistant" | "assistant-thinking" } | undefined {
  const narratives = content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as { type?: unknown; text?: unknown; thinking?: unknown };
    if (value.type === "text" && typeof value.text === "string") {
      return [{ markdown: value.text, type: "assistant" as const }];
    }
    if (value.type === "thinking" && typeof value.thinking === "string") {
      return [{ markdown: value.thinking, type: "assistant-thinking" as const }];
    }
    return [];
  });
  if (narratives.length !== 1) return undefined;
  const narrative = narratives[0];
  const markdown = narrative.markdown.trim();
  return markdown && !markdown.includes("\n") ? { ...narrative, markdown } : undefined;
}

function narrativeKey(type: "assistant" | "assistant-thinking", markdown: string): string {
  return `${type}::${markdown}`;
}

function renderNarrative(
  markdown: string,
  type: "assistant" | "assistant-thinking" | undefined,
  suffix: string | undefined,
  theme: Theme,
): Component {
  const text = suffix ? `${markdown} ${suffix}` : markdown;
  const markdownTheme = {
    heading: (value: string) => theme.fg("mdHeading", value),
    link: (value: string) => theme.fg("mdLink", value),
    linkUrl: (value: string) => theme.fg("mdLinkUrl", value),
    code: (value: string) => theme.fg("mdCode", value),
    codeBlock: (value: string) => theme.fg("mdCodeBlock", value),
    codeBlockBorder: (value: string) => theme.fg("mdCodeBlockBorder", value),
    quote: (value: string) => theme.fg("mdQuote", value),
    quoteBorder: (value: string) => theme.fg("mdQuoteBorder", value),
    hr: (value: string) => theme.fg("mdHr", value),
    listBullet: (value: string) => theme.fg("mdListBullet", value),
    bold: (value: string) => theme.bold(value),
    italic: (value: string) => theme.italic(value),
    underline: (value: string) => theme.underline(value),
    strikethrough: (value: string) => theme.strikethrough(value),
  };
  const defaultStyle =
    type === "assistant-thinking"
      ? { color: (value: string) => theme.fg("thinkingText", value), italic: true }
      : undefined;
  return new Markdown(text, 0, 0, markdownTheme, defaultStyle);
}

function hasNarrativeContent(content: readonly unknown[]): boolean {
  return content.some((item) => {
    if (!item || typeof item !== "object") return false;
    const value = item as { type?: unknown; text?: unknown; thinking?: unknown };
    return (
      (value.type === "text" && typeof value.text === "string" && !!value.text.trim()) ||
      (value.type === "thinking" &&
        typeof value.thinking === "string" &&
        !!value.thinking.trim())
    );
  });
}

function indexToolGroups(content: readonly unknown[]): void {
  const calls = content.filter(isToolCallContent);
  for (const call of calls) collapsedGroups.delete(call.id);

  const builtInCalls = calls.filter((call) => call.name in groupedNouns);
  const narrative = inlineNarrative(content);
  const hasNarrative = hasNarrativeContent(content);
  if (builtInCalls.length > 0) {
    const existingGroup = builtInCalls
      .map((call) => ultraCollapsedGroups.get(call.id))
      .find((group): group is UltraCollapsedGroup => !!group);
    let group: UltraCollapsedGroup;

    if (hasNarrative && !existingGroup) {
      group = {
        firstId: builtInCalls[0].id,
        count: 0,
        narrative: narrative?.markdown,
        narrativeType: narrative?.type,
        callIds: new Set<string>(),
      };
      activeUltraCollapsedGroup = group;
      if (narrative) {
        inlineNarratives.add(narrativeKey(narrative.type, narrative.markdown));
      }
    } else {
      group = existingGroup ?? activeUltraCollapsedGroup ?? {
        firstId: builtInCalls[0].id,
        count: 0,
        callIds: new Set<string>(),
      };
      activeUltraCollapsedGroup = group;
      if (
        narrative &&
        (group.narrative !== narrative.markdown || group.narrativeType !== narrative.type)
      ) {
        if (group.narrative && group.narrativeType) {
          inlineNarratives.delete(narrativeKey(group.narrativeType, group.narrative));
        }
        group.narrative = narrative.markdown;
        group.narrativeType = narrative.type;
        inlineNarratives.add(narrativeKey(narrative.type, narrative.markdown));
      }
    }

    for (const call of builtInCalls) {
      group.callIds.add(call.id);
      ultraCollapsedGroups.set(call.id, group);
    }
    group.count = group.callIds.size;
    for (const callId of group.callIds) renderInvalidators.get(callId)?.();
  } else if (hasNarrative) {
    activeUltraCollapsedGroup = undefined;
  }

  let start = 0;
  while (start < calls.length) {
    let end = start + 1;
    while (end < calls.length && calls[end].name === calls[start].name) end += 1;

    if (end - start > 1 && calls[start].name in groupedNouns) {
      const group = { firstId: calls[start].id, count: end - start };
      for (let index = start; index < end; index += 1) {
        collapsedGroups.set(calls[index].id, group);
        renderInvalidators.get(calls[index].id)?.();
      }
    }
    start = end;
  }
}

function shortenPath(path: string): string {
  const home = homedir();
  return path.toLowerCase().startsWith(home.toLowerCase()) ? `~${path.slice(home.length)}` : path;
}

function stringArg(args: Record<string, unknown>, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === "string" && value ? value.replace(/\s+/g, " ") : fallback;
}

function firstLineArg(args: Record<string, unknown>, key: string, fallback: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value) return fallback;
  return value.split(/\r?\n/, 1)[0].trimEnd() || fallback;
}

function formatToolCall(
  name: BuiltInToolName,
  args: Record<string, unknown>,
  theme: { fg(color: "toolTitle" | "accent" | "muted" | "toolOutput", text: string): string },
  additionalCount: number,
): string {
  const path = shortenPath(stringArg(args, "path", "."));
  let title = theme.fg("toolTitle", name);
  let detail = theme.fg("accent", path);

  if (name === "bash") {
    title = theme.fg("toolTitle", "$");
    detail = theme.fg("accent", firstLineArg(args, "command", "..."));
  } else if (name === "find") {
    detail = `${theme.fg("accent", stringArg(args, "pattern", "*"))}${theme.fg("toolOutput", ` in ${path}`)}`;
  } else if (name === "grep") {
    detail = `${theme.fg("accent", `/${stringArg(args, "pattern", "")}/`)}${theme.fg("toolOutput", ` in ${path}`)}`;
  }

  if (additionalCount === 0) return `${title} ${detail}`;
  const [singular, plural] = groupedNouns[name];
  const noun = additionalCount === 1 ? singular : plural;
  return `${title} ${detail}${theme.fg("muted", ` and ${additionalCount} ${noun}`)}`;
}

function registerMinimalTool<TParams extends TSchema, TDetails>(
  pi: ExtensionAPI,
  select: (tools: BuiltInTools) => ToolDefinition<TParams, TDetails>,
): void {
  const tool = select(getBuiltInTools(process.cwd()));
  const name = tool.name as BuiltInToolName;

  pi.registerTool<TParams, TDetails>({
    ...tool,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const scopedTool = select(getBuiltInTools(ctx.cwd));
      return scopedTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      renderInvalidators.set(context.toolCallId, context.invalidate);

      // Ctrl+O still owns Pi's binary `expanded` flag: false is ultra-collapsed,
      // while true is our more detailed (but still result-free) collapsed view.
      if (!context.expanded) {
        const group = ultraCollapsedGroups.get(context.toolCallId);
        if (group && group.firstId !== context.toolCallId) return new Container();
        const count = group?.count ?? 1;
        const countText = `${count} tool ${count === 1 ? "call" : "calls"}`;
        if (group?.narrative) {
          return renderNarrative(group.narrative, group.narrativeType, countText, theme);
        }
        return new OneLine(theme.fg("muted", countText));
      }

      const group = collapsedGroups.get(context.toolCallId);
      if (group?.firstId !== undefined && group.firstId !== context.toolCallId) {
        return new Container();
      }

      const additionalCount = group ? group.count - 1 : 0;
      const line = new OneLine(
        formatToolCall(name, args as Record<string, unknown>, theme, additionalCount),
      );
      const background = context.isError
        ? "toolErrorBg"
        : context.isPartial === false
          ? "toolSuccessBg"
          : "toolPendingBg";
      const box = new Box(1, 1, (text) => theme.bg(background, text));
      box.addChild(line);

      const ultraGroup = ultraCollapsedGroups.get(context.toolCallId);
      if (ultraGroup?.firstId === context.toolCallId && ultraGroup.narrative) {
        const container = new Container();
        container.addChild(
          renderNarrative(ultraGroup.narrative, ultraGroup.narrativeType, undefined, theme),
        );
        container.addChild(box);
        return container;
      }
      return box;
    },
    renderResult() {
      return new Container();
    },
  });
}

export default function minimalToolOutputExtension(pi: ExtensionAPI): void {
  collapsedGroups.clear();
  ultraCollapsedGroups.clear();
  inlineNarratives.clear();
  renderInvalidators.clear();
  activeUltraCollapsedGroup = undefined;

  pi.registerMarkdownTransformer((markdown, context) => {
    if (
      (context.messageType === "assistant" || context.messageType === "assistant-thinking") &&
      inlineNarratives.has(narrativeKey(context.messageType, markdown))
    ) {
      return "";
    }
    return markdown;
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "user") activeUltraCollapsedGroup = undefined;
  });

  pi.on("message_update", (event) => {
    if (event.message.role === "assistant") indexToolGroups(event.message.content);
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") indexToolGroups(event.message.content);
  });

  pi.on("session_start", (_event, ctx) => {
    collapsedGroups.clear();
    ultraCollapsedGroups.clear();
    inlineNarratives.clear();
    renderInvalidators.clear();
    activeUltraCollapsedGroup = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      if (entry.message.role === "user") {
        activeUltraCollapsedGroup = undefined;
      } else if (entry.message.role === "assistant") {
        indexToolGroups(entry.message.content);
      }
    }
  });

  registerMinimalTool(pi, (tools) => tools.read);
  registerMinimalTool(pi, (tools) => tools.bash);
  registerMinimalTool(pi, (tools) => tools.edit);
  registerMinimalTool(pi, (tools) => tools.write);
  registerMinimalTool(pi, (tools) => tools.find);
  registerMinimalTool(pi, (tools) => tools.grep);
  registerMinimalTool(pi, (tools) => tools.ls);
}
