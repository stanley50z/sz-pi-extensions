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
  type ToolRenderers,
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
  expanded?: boolean;
};

type SkillReadGroup = {
  firstId: string;
  callIds: Set<string>;
  names: Map<string, string>;
};

type ToolRenderTheme = {
  fg(color: "toolTitle" | "accent" | "muted" | "toolOutput" | "error" | "warning", text: string): string;
};

export type MinimalToolOutputOptions = {
  nouns?: [singular: string, plural: string];
  formatCall?: (args: Record<string, unknown>, theme: ToolRenderTheme) => string;
  alwaysShowCall?: boolean;
};

type CodemodeCall = {
  id: string;
  name: string;
  args: string;
  status: "running" | "ok" | "error" | "cancelled";
};

type CodemodeCallMetadata = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  skillName?: string;
};

type MinimalToolOutputState = {
  codemodeCalls: Map<string, CodemodeCall[]>;
  codemodeMetadata: Map<string, Map<string, CodemodeCallMetadata>>;
  codemodeScriptErrors: Set<string>;
  collapsedGroups: Map<string, ToolGroup>;
  ultraCollapsedGroups: Map<string, UltraCollapsedGroup>;
  skillReadGroups: Map<string, SkillReadGroup>;
  inlineNarratives: Set<string>;
  renderInvalidators: Map<string, () => void>;
  renderedExpansion: Map<string, boolean>;
  minimalToolOptions: Map<string, MinimalToolOutputOptions>;
  activeUltraCollapsedGroup?: UltraCollapsedGroup;
};

type MinimalToolOutputGlobal = typeof globalThis & {
  __szPiMinimalToolOutputStateV1?: MinimalToolOutputState;
};

const sharedGlobal = globalThis as MinimalToolOutputGlobal;
const sharedState = sharedGlobal.__szPiMinimalToolOutputStateV1 ??= {
  codemodeCalls: new Map<string, CodemodeCall[]>(),
  codemodeMetadata: new Map<string, Map<string, CodemodeCallMetadata>>(),
  codemodeScriptErrors: new Set<string>(),
  collapsedGroups: new Map<string, ToolGroup>(),
  ultraCollapsedGroups: new Map<string, UltraCollapsedGroup>(),
  skillReadGroups: new Map<string, SkillReadGroup>(),
  inlineNarratives: new Set<string>(),
  renderInvalidators: new Map<string, () => void>(),
  renderedExpansion: new Map<string, boolean>(),
  minimalToolOptions: new Map<string, MinimalToolOutputOptions>(),
};

sharedState.codemodeCalls ??= new Map<string, CodemodeCall[]>();
sharedState.codemodeMetadata ??= new Map<string, Map<string, CodemodeCallMetadata>>();
sharedState.codemodeScriptErrors ??= new Set<string>();
sharedState.skillReadGroups ??= new Map<string, SkillReadGroup>();
sharedState.renderedExpansion ??= new Map<string, boolean>();

const toolCache = new Map<string, BuiltInTools>();
const {
  codemodeCalls,
  codemodeMetadata,
  codemodeScriptErrors,
  collapsedGroups,
  ultraCollapsedGroups,
  skillReadGroups,
  inlineNarratives,
  renderInvalidators,
  renderedExpansion,
  minimalToolOptions,
} = sharedState;

const builtInNouns: Record<BuiltInToolName, [singular: string, plural: string]> = {
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

// Handles group clicks before Pi's per-call click region, keeping every member in sync.
class ToolGroupToggle implements Component {
  private readonly child: Component;
  private readonly group: UltraCollapsedGroup;
  private readonly expanded: boolean;

  constructor(child: Component, group: UltraCollapsedGroup, expanded: boolean) {
    this.child = child;
    this.group = group;
    this.expanded = expanded;
  }

  render(width: number): string[] {
    return this.child.render(width);
  }

  invalidate(): void {
    this.child.invalidate();
  }

  handleMouse(event: { type: string; button?: string }) {
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.group.expanded = !this.expanded;
    for (const id of this.group.callIds) renderInvalidators.get(id)?.();
    return { handled: true };
  }
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
  const narratives = content.flatMap<{ markdown: string; type: "assistant" | "assistant-thinking" }>((item) => {
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

function isSkillRead(name: string, args: Record<string, unknown>): boolean {
  const path = args.path;
  return name === "read"
    && typeof path === "string"
    && /(?:^|[\\/])SKILL\.md$/i.test(path);
}

function isMinimalCall(call: ToolCallContent): boolean {
  const options = minimalToolOptions.get(call.name);
  return !!options && !options.alwaysShowCall && !isSkillRead(call.name, call.arguments);
}

function skillNameFromPath(path: string): string {
  return path.split(/[\\/]/).at(-2) ?? "skill";
}

function indexSkillReadGroups(calls: ToolCallContent[]): void {
  for (const call of calls) skillReadGroups.delete(call.id);

  let start = 0;
  while (start < calls.length) {
    if (!isSkillRead(calls[start].name, calls[start].arguments)) {
      start += 1;
      continue;
    }

    let end = start + 1;
    while (
      end < calls.length
      && isSkillRead(calls[end].name, calls[end].arguments)
    ) {
      end += 1;
    }

    if (end - start > 1) {
      const groupedCalls = calls.slice(start, end);
      const group: SkillReadGroup = {
        firstId: groupedCalls[0].id,
        callIds: new Set(groupedCalls.map((call) => call.id)),
        names: new Map(groupedCalls.map((call) => [
          call.id,
          skillNameFromPath(call.arguments.path as string),
        ])),
      };
      for (const call of groupedCalls) {
        skillReadGroups.set(call.id, group);
        renderInvalidators.get(call.id)?.();
      }
    }
    start = end;
  }
}

function indexToolGroups(content: readonly unknown[]): void {
  const calls = content.filter(isToolCallContent);
  for (const call of calls) {
    collapsedGroups.delete(call.id);
    if (call.name === "codemode" && !codemodeCalls.has(call.id)) codemodeCalls.set(call.id, []);
  }
  indexSkillReadGroups(calls);

  const builtInCalls = calls.filter(isMinimalCall);
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
      sharedState.activeUltraCollapsedGroup = group;
      if (narrative) {
        inlineNarratives.add(narrativeKey(narrative.type, narrative.markdown));
      }
    } else {
      group = existingGroup ?? sharedState.activeUltraCollapsedGroup ?? {
        firstId: builtInCalls[0].id,
        count: 0,
        callIds: new Set<string>(),
      };
      sharedState.activeUltraCollapsedGroup = group;
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
    group.count = [...group.callIds].reduce((count, id) => count + callCount(id), 0);
    for (const callId of group.callIds) renderInvalidators.get(callId)?.();
  } else if (hasNarrative) {
    sharedState.activeUltraCollapsedGroup = undefined;
  }

  let start = 0;
  while (start < calls.length) {
    if (!isMinimalCall(calls[start])) {
      start += 1;
      continue;
    }

    let end = start + 1;
    while (
      end < calls.length
      && calls[end].name === calls[start].name
      && isMinimalCall(calls[end])
    ) {
      end += 1;
    }

    if (end - start > 1) {
      const group = { firstId: calls[start].id, count: end - start };
      for (let index = start; index < end; index += 1) {
        collapsedGroups.set(calls[index].id, group);
        renderInvalidators.get(calls[index].id)?.();
      }
    }
    start = end;
  }
}

function skillReadName(path: string, content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const declaredName = frontmatter?.[1]
    .match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1]
    .trim();
  return declaredName || skillNameFromPath(path);
}

function skillReadText(result: { content?: readonly unknown[] }): string {
  return result.content?.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("\n") ?? "";
}

function renderSkillNames(names: string, theme: Theme): Component {
  const label = theme.fg("customMessageLabel", theme.bold("[skill]"));
  const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
  box.addChild(new OneLine(`${label} ${theme.fg("customMessageText", names)}`));
  return box;
}

function renderSkillGroup(group: SkillReadGroup, theme: Theme): Component {
  const names = [...group.callIds].map((id) => group.names.get(id)).filter(Boolean).join(", ");
  return renderSkillNames(names, theme);
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
  theme: ToolRenderTheme,
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

  return `${title} ${detail}`;
}

// Shares compact call rendering with tools whose execution must remain untouched.
function minimalToolRenderers(
  name: string,
  options: MinimalToolOutputOptions = {},
): ToolRenderers {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      renderInvalidators.set(context.toolCallId, context.invalidate);

      if (isSkillRead(name, args as Record<string, unknown>)) {
        return new Container();
      }

      const ultraGroup = ultraCollapsedGroups.get(context.toolCallId);
      const previousExpanded = renderedExpansion.get(context.toolCallId);
      renderedExpansion.set(context.toolCallId, context.expanded);
      // Ctrl+O resets a local click override and retains the global compact-card view.
      if (
        ultraGroup?.expanded !== undefined &&
        previousExpanded !== undefined && previousExpanded !== context.expanded
      ) {
        delete ultraGroup.expanded;
        for (const id of ultraGroup.callIds) {
          if (id !== context.toolCallId) renderInvalidators.get(id)?.();
        }
      }
      const expanded = ultraGroup?.expanded ?? context.expanded;
      const clickable = (component: Component) => ultraGroup
        ? new ToolGroupToggle(component, ultraGroup, expanded)
        : component;

      if (!expanded && !options.alwaysShowCall) {
        const group = ultraGroup;
        if (group && group.firstId !== context.toolCallId) return new Container();
        const count = group?.count ?? callCount(context.toolCallId);
        const countText = `+ ${count} tool ${count === 1 ? "call" : "calls"}`
          + codemodeStatus(group?.callIds ?? new Set([context.toolCallId]));
        if (group?.narrative) {
          return clickable(renderNarrative(group.narrative, group.narrativeType, countText, theme));
        }
        return clickable(new OneLine(theme.fg("muted", countText)));
      }

      // A group click reveals each counted call, including consecutive same-tool calls.
      const group = ultraGroup?.expanded ? undefined : collapsedGroups.get(context.toolCallId);
      if (group?.firstId !== undefined && group.firstId !== context.toolCallId) {
        return new Container();
      }

      const additionalCount = group ? group.count - 1 : 0;
      let text = options.formatCall?.(args as Record<string, unknown>, theme) ??
        theme.fg("toolTitle", name);
      if (additionalCount > 0) {
        const [singular, plural] = options.nouns ?? ["call", "calls"];
        const noun = additionalCount === 1 ? singular : plural;
        text += theme.fg("muted", ` and ${additionalCount} ${noun}`);
      }
      const line = new OneLine(text);
      const background = context.isError
        ? "toolErrorBg"
        : context.isPartial === false
          ? "toolSuccessBg"
          : "toolPendingBg";
      const box = new Box(1, 1, (text) => theme.bg(background, text));
      box.addChild(line);

      if (ultraGroup?.firstId === context.toolCallId && ultraGroup.narrative) {
        const container = new Container();
        container.addChild(
          renderNarrative(ultraGroup.narrative, ultraGroup.narrativeType, undefined, theme),
        );
        container.addChild(box);
        return clickable(container);
      }
      return clickable(box);
    },
    renderResult(result, _options, theme, context) {
      const args = (context.args ?? {}) as Record<string, unknown>;
      if (isSkillRead(name, args)) {
        const path = args.path as string;
        const name = skillReadName(path, skillReadText(result));
        const group = skillReadGroups.get(context.toolCallId);
        if (group) {
          const previousName = group.names.get(context.toolCallId);
          group.names.set(context.toolCallId, name);
          if (previousName !== name) renderInvalidators.get(group.firstId)?.();
          return group.firstId === context.toolCallId
            ? renderSkillGroup(group, theme)
            : new Container();
        }
        return renderSkillNames(name, theme);
      }
      return new Container();
    },
  };
}

export function withMinimalToolOutput<TParams extends TSchema, TDetails>(
  tool: ToolDefinition<TParams, TDetails>,
  options: MinimalToolOutputOptions = {},
): ToolDefinition<TParams, TDetails> {
  minimalToolOptions.set(tool.name, options);
  return { ...tool, ...minimalToolRenderers(tool.name, options) };
}

function registerMinimalTool<TParams extends TSchema, TDetails>(
  pi: ExtensionAPI,
  select: (tools: BuiltInTools) => ToolDefinition<TParams, TDetails>,
): void {
  const tool = select(getBuiltInTools(process.cwd()));
  const name = tool.name as BuiltInToolName;

  pi.registerTool<TParams, TDetails>(
    withMinimalToolOutput(
      {
        ...tool,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const scopedTool = select(getBuiltInTools(ctx.cwd));
          return scopedTool.execute(toolCallId, params, signal, onUpdate, ctx);
        },
      },
      {
        nouns: builtInNouns[name],
        formatCall: (args, theme) => formatToolCall(name, args, theme),
      },
    ),
  );
}

function callCount(id: string): number {
  return Math.max(1, codemodeCalls.get(id)?.length ?? 1);
}

// Consume codemode's structured progress, never its script or model-facing output.
function updateCodemodeCalls(id: string, details: unknown, isError?: boolean): void {
  if (!details || typeof details !== "object" || !("calls" in details) || !Array.isArray(details.calls)) return;
  if ("minimalCalls" in details && Array.isArray(details.minimalCalls)) {
    const metadata = details.minimalCalls.filter((item): item is CodemodeCallMetadata =>
      !!item && typeof item === "object" && typeof item.id === "string"
      && typeof item.name === "string" && !!item.args && typeof item.args === "object");
    codemodeMetadata.set(id, new Map(metadata.map((item) => [item.id, item])));
  }
  const calls = details.calls.filter((call): call is CodemodeCall =>
    !!call && typeof call === "object" && typeof call.id === "string"
    && typeof call.name === "string" && typeof call.args === "string"
    && ["running", "ok", "error", "cancelled"].includes(call.status));
  const errorChanged = isError !== undefined && codemodeScriptErrors.has(id) !== isError;
  if (isError === true) codemodeScriptErrors.add(id);
  if (isError === false) codemodeScriptErrors.delete(id);
  if (!errorChanged && JSON.stringify(codemodeCalls.get(id)) === JSON.stringify(calls)) return;
  codemodeCalls.set(id, calls);
  const group = ultraCollapsedGroups.get(id);
  if (group) {
    group.count = [...group.callIds].reduce((total, callId) => total + callCount(callId), 0);
    for (const callId of group.callIds) {
      if (callId !== id) renderInvalidators.get(callId)?.();
    }
  }
}

function codemodeStatus(ids: Set<string>): string {
  const calls = [...ids].flatMap((id) => codemodeCalls.get(id) ?? []);
  const scriptErrors = [...ids].filter((id) => codemodeScriptErrors.has(id)).length;
  const scriptStatus = scriptErrors === 1 ? " · script failed"
    : scriptErrors > 1 ? ` · ${scriptErrors} scripts failed` : "";
  return (["running", "error", "cancelled"] as const).flatMap((status) => {
    const count = calls.filter((call) => call.status === status).length;
    return count ? [` · ${count} ${status === "error" ? "failed" : status}`] : [];
  }).join("") + scriptStatus;
}

// Older sessions may have only a truncated JSON preview. Omitted arguments stay omitted.
function codemodeArguments(parentId: string, call: CodemodeCall): Record<string, unknown> {
  const metadata = codemodeMetadata.get(parentId)?.get(call.id);
  if (metadata) return metadata.args;
  try {
    const args: unknown = JSON.parse(call.args);
    return args && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

// Persist only arguments used by compact cards, never write content or delegated prompts.
function compactCodemodeArguments(input: Record<string, unknown>): Record<string, unknown> {
  const keys = ["path", "pattern", "command", "glob", "id", "ids", "name", "harness", "model", "reasoning_effort"];
  return Object.fromEntries(keys.filter((key) => key in input).map((key) => [
    key, key === "command" ? firstLineArg(input, key, "...") : input[key],
  ]));
}

// Draw nested calls inside their parent's group without adding synthetic transcript entries.
function minimalCodemodeRenderers(): ToolRenderers {
  minimalToolOptions.set("codemode", {});
  const minimal = minimalToolRenderers("codemode");
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      let child: Component = new Container();
      return {
        render(width) {
          const header = minimal.renderCall!(args, theme, context);
          const group = ultraCollapsedGroups.get(context.toolCallId);
          const expanded = group?.expanded ?? context.expanded;
          const calls = codemodeCalls.get(context.toolCallId) ?? [];
          const container = new Container();
          if (!expanded && calls.length === 0 && (!group || group.callIds.size === 1)) {
            const label = "codemode" + codemodeStatus(new Set([context.toolCallId]));
            container.addChild(group?.narrative
              ? renderNarrative(group.narrative, group.narrativeType, label, theme)
              : new OneLine(theme.fg(context.isError ? "error" : "toolTitle", label)));
          } else if (!expanded || calls.length === 0) container.addChild(header);
          else if (group?.firstId === context.toolCallId && group.narrative) {
            container.addChild(renderNarrative(group.narrative, group.narrativeType, undefined, theme));
          }
          if (expanded && calls.length > 0 && codemodeScriptErrors.has(context.toolCallId)) {
            container.addChild(new OneLine(theme.fg("error", "codemode · script failed")));
          }
          let skillNames: string[] = [];
          const flushSkills = () => {
            if (skillNames.length) container.addChild(renderSkillNames(skillNames.join(", "), theme));
            skillNames = [];
          };
          for (const call of calls) {
            const input = codemodeArguments(context.toolCallId, call);
            const options = minimalToolOptions.get(call.name) ?? {};
            if (isSkillRead(call.name, input)) {
              skillNames.push(codemodeMetadata.get(context.toolCallId)?.get(call.id)?.skillName
                ?? skillNameFromPath(input.path as string));
              continue;
            }
            flushSkills();
            if (!expanded && !options.alwaysShowCall) continue;
            const renderer = minimalToolRenderers(call.name, {
              ...options,
              formatCall(input, theme) {
                const text = Object.keys(input).length && options.formatCall
                  ? options.formatCall(input, theme) : theme.fg("toolTitle", call.name);
                const status = call.status === "error" ? theme.fg("error", "✗ ")
                  : call.status === "running" ? theme.fg("warning", "… ")
                    : call.status === "cancelled" ? theme.fg("muted", "⊘ ") : "";
                return status + text;
              },
            });
            container.addChild(renderer.renderCall!(input, theme, {
              ...context, args: input, toolCallId: call.id, expanded: true,
              isPartial: call.status === "running", isError: call.status === "error",
            }));
          }
          flushSkills();
          child = group ? new ToolGroupToggle(container, group, expanded) : container;
          return child.render(width);
        },
        invalidate() { child.invalidate(); },
        handleMouse(event) { return child.handleMouse?.(event); },
      };
    },
    renderResult(result, _options, _theme, context) {
      updateCodemodeCalls(context.toolCallId, result.details, context.isError);
      return new Container();
    },
  };
}

export default function minimalToolOutputExtension(pi: ExtensionAPI): void {
  codemodeCalls.clear();
  codemodeMetadata.clear();
  codemodeScriptErrors.clear();
  const codemode = minimalCodemodeRenderers();
  pi.registerToolRenderer((name, next) => name === "codemode" ? codemode : next());
  collapsedGroups.clear();
  ultraCollapsedGroups.clear();
  skillReadGroups.clear();
  inlineNarratives.clear();
  renderInvalidators.clear();
  renderedExpansion.clear();
  sharedState.activeUltraCollapsedGroup = undefined;

  pi.registerMarkdownTransformer((markdown, context) => {
    if (
      (context.messageType === "assistant" || context.messageType === "assistant-thinking") &&
      inlineNarratives.has(narrativeKey(context.messageType, markdown))
    ) {
      return "";
    }
    return markdown;
  });

  pi.on("tool_execution_update", (event) => {
    if (event.toolName === "codemode") updateCodemodeCalls(event.toolCallId, event.partialResult.details);
  });

  pi.on("tool_call", (event) => {
    const parentId = event.parentToolCallId;
    if (!parentId || !codemodeCalls.has(parentId)) return;
    const metadata = codemodeMetadata.get(parentId) ?? new Map<string, CodemodeCallMetadata>();
    metadata.set(event.toolCallId, {
      id: event.toolCallId, name: event.toolName, args: compactCodemodeArguments(event.input),
    });
    codemodeMetadata.set(parentId, metadata);
  });

  pi.on("tool_result", (event) => {
    const metadata = event.parentToolCallId
      ? codemodeMetadata.get(event.parentToolCallId)?.get(event.toolCallId) : undefined;
    if (metadata) {
      if (isSkillRead(event.toolName, event.input)) {
        metadata.skillName = skillReadName(event.input.path as string, skillReadText(event));
      }
      if (event.details && typeof event.details === "object" && "subagentModel" in event.details
        && typeof event.details.subagentModel === "string") {
        metadata.args.model = event.details.subagentModel;
      }
    }
    if (event.toolName === "codemode") {
      const minimalCalls = [...(codemodeMetadata.get(event.toolCallId)?.values() ?? [])];
      if (minimalCalls.length && event.details && typeof event.details === "object") {
        return { details: { ...event.details, minimalCalls } };
      }
    }
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "user") sharedState.activeUltraCollapsedGroup = undefined;
  });

  pi.on("message_update", (event) => {
    if (event.message.role === "assistant") indexToolGroups(event.message.content);
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") indexToolGroups(event.message.content);
  });

  pi.on("session_start", (_event, ctx) => {
    codemodeCalls.clear();
    codemodeMetadata.clear();
    codemodeScriptErrors.clear();
    collapsedGroups.clear();
    ultraCollapsedGroups.clear();
    skillReadGroups.clear();
    inlineNarratives.clear();
    renderInvalidators.clear();
    renderedExpansion.clear();
    sharedState.activeUltraCollapsedGroup = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      if (entry.message.role === "user") {
        sharedState.activeUltraCollapsedGroup = undefined;
      } else if (entry.message.role === "assistant") {
        indexToolGroups(entry.message.content);
      } else if (entry.message.role === "toolResult" && entry.message.toolName === "codemode") {
        updateCodemodeCalls(entry.message.toolCallId, entry.message.details, entry.message.isError);
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
