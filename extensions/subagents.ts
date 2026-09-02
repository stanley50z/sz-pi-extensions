import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { installSubagentsExtension } from "sz-pi-subagents/extensions/subagents/index.ts";
import { claudeBackend } from "sz-pi-subagents/extensions/subagents/src/backends/claude.ts";
import { codexBackend } from "sz-pi-subagents/extensions/subagents/src/backends/codex.ts";
import { piBackend } from "sz-pi-subagents/extensions/subagents/src/backends/pi.ts";
import { SubagentManager } from "sz-pi-subagents/extensions/subagents/src/manager.ts";
import type { TSchema } from "typebox";
import {
  connectRunningSubagentStatus,
  renderSubagentResult,
  withMinimalSubagentOutput,
} from "../lib/subagent-tool-output.ts";

export default function minimalSubagentsExtension(pi: ExtensionAPI): void {
  const manager = new SubagentManager(new Map([
    ["pi", piBackend],
    ["codex", codexBackend],
    ["claude", claudeBackend],
  ]));
  const disconnectRunningStatus = connectRunningSubagentStatus(pi, manager);
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

  installSubagentsExtension(wrappedPi, manager);
  pi.registerMessageRenderer("sz-subagent-result", renderSubagentResult);
  pi.on("session_shutdown", disconnectRunningStatus);
}
