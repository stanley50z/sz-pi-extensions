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
import { Container, Text } from "@earendil-works/pi-tui";
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

const toolCache = new Map<string, BuiltInTools>();

function getBuiltInTools(cwd: string): BuiltInTools {
  let tools = toolCache.get(cwd);
  if (!tools) {
    tools = createBuiltInTools(cwd);
    toolCache.set(cwd, tools);
  }
  return tools;
}

function registerMinimalTool<TParams extends TSchema, TDetails>(
  pi: ExtensionAPI,
  select: (tools: BuiltInTools) => ToolDefinition<TParams, TDetails>,
): void {
  const tool = select(getBuiltInTools(process.cwd()));

  pi.registerTool<TParams, TDetails>({
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const scopedTool = select(getBuiltInTools(ctx.cwd));
      return scopedTool.execute(toolCallId, params, signal, onUpdate, ctx);
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
  registerMinimalTool(pi, (tools) => tools.read);
  registerMinimalTool(pi, (tools) => tools.bash);
  registerMinimalTool(pi, (tools) => tools.edit);
  registerMinimalTool(pi, (tools) => tools.write);
  registerMinimalTool(pi, (tools) => tools.find);
  registerMinimalTool(pi, (tools) => tools.grep);
  registerMinimalTool(pi, (tools) => tools.ls);
}
