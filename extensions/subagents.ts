import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "sz-pi-subagents/extensions/subagents/index.ts";
import type { TSchema } from "typebox";
import {
  renderSubagentResult,
  withMinimalSubagentOutput,
} from "../lib/subagent-tool-output.ts";

export default function minimalSubagentsExtension(pi: ExtensionAPI): void {
  const wrappedPi = new Proxy(pi, {
    get(target, property) {
      if (property === "registerTool") {
        return <TParams extends TSchema, TDetails>(
          tool: ToolDefinition<TParams, TDetails>,
        ): void => {
          target.registerTool(withMinimalSubagentOutput(tool));
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExtensionAPI;

  subagentsExtension(wrappedPi);
  pi.registerMessageRenderer("sz-subagent-result", renderSubagentResult);
}
