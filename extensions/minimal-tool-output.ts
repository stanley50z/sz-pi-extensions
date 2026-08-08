import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { Box, Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
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
};

const toolCache = new Map<string, BuiltInTools>();
const toolGroups = new Map<string, ToolGroup>();
const renderInvalidators = new Map<string, () => void>();

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

function indexToolGroups(content: readonly unknown[]): void {
  const calls = content.filter(isToolCallContent);
  for (const call of calls) toolGroups.delete(call.id);

  let start = 0;
  while (start < calls.length) {
    let end = start + 1;
    while (end < calls.length && calls[end].name === calls[start].name) end += 1;

    if (end - start > 1 && calls[start].name in groupedNouns) {
      const group = { firstId: calls[start].id, count: end - start };
      for (let index = start; index < end; index += 1) {
        toolGroups.set(calls[index].id, group);
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
      const group = toolGroups.get(context.toolCallId);
      if (!context.expanded && group?.firstId !== undefined && group.firstId !== context.toolCallId) {
        return new Container();
      }

      const additionalCount = !context.expanded && group ? group.count - 1 : 0;
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
      return box;
    },
    renderResult(result, { expanded }, theme, context) {
      if (!expanded) return new Container();

      const output = result.content
        .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (!output) return new Container();

      const color = context.isError ? "error" : "toolOutput";
      const text = output
        .split("\n")
        .map((line) => theme.fg(color, line))
        .join("\n");
      return new Text(`\n${text}`, 0, 0);
    },
  });
}

export default function minimalToolOutputExtension(pi: ExtensionAPI): void {
  toolGroups.clear();
  renderInvalidators.clear();

  pi.on("message_update", (event) => {
    if (event.message.role === "assistant") indexToolGroups(event.message.content);
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") indexToolGroups(event.message.content);
  });

  pi.on("session_start", (_event, ctx) => {
    toolGroups.clear();
    renderInvalidators.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
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
