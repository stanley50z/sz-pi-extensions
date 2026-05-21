// extensions/chrome-devtools/index.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TObject } from "typebox";
import { McpClient, type McpConfig, type McpToolDefinition } from "./mcp-client.js";
import { jsonSchemaToTypeBox } from "./schema-convert.js";

// ── Configuration ──────────────────────────────────────────────

function readConfig(): McpConfig {
  const cfg: Record<string, unknown> = {};
  const sources = [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(process.cwd(), ".pi", "settings.json"),
  ];
  for (const path of sources) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.chromeDevtools) Object.assign(cfg, parsed.chromeDevtools);
    } catch { /* skip */ }
  }

  return {
    headless: envBool("PI_CHROME_HEADLESS") ?? (cfg.headless as boolean) ?? false,
    viewport: envStr("PI_CHROME_VIEWPORT") ?? (cfg.viewport as string) ?? "1280x900",
    browserUrl: envStr("PI_CHROME_BROWSER_URL") ?? (cfg.browserUrl as string) ?? undefined,
    executablePath: envStr("PI_CHROME_EXECUTABLE") ?? (cfg.executablePath as string) ?? undefined,
    userDataDir: envStr("PI_CHROME_USER_DATA_DIR") ?? (cfg.userDataDir as string) ?? undefined,
    isolated: envBool("PI_CHROME_ISOLATED") ?? (cfg.isolated as boolean) ?? false,
    channel: envStr("PI_CHROME_CHANNEL") ?? (cfg.channel as string) ?? "stable",
    experimentalVision: envBool("PI_CHROME_EXPERIMENTAL_VISION") ?? (cfg.experimentalVision as boolean) ?? false,
    categoryEmulation: envBool("PI_CHROME_CAT_EMULATION") ?? (cfg.categoryEmulation as boolean) ?? true,
    categoryPerformance: envBool("PI_CHROME_CAT_PERFORMANCE") ?? (cfg.categoryPerformance as boolean) ?? true,
    categoryNetwork: envBool("PI_CHROME_CAT_NETWORK") ?? (cfg.categoryNetwork as boolean) ?? true,
    quiet: envBool("PI_CHROME_QUIET") ?? (cfg.quiet as boolean) ?? true,
  };
}

function envBool(key: string): boolean | undefined {
  const val = process.env[key];
  if (val === undefined) return undefined;
  return val !== "0" && val !== "false" && val !== "";
}

function envStr(key: string): string | undefined {
  return process.env[key] || undefined;
}

// ── Extension ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let client: McpClient | null = null;
  let registeredTools: string[] = [];

  async function registerTools(): Promise<void> {
    if (!client) return;

    const tools = await client.listTools();

    for (const mcpTool of tools) {
      const piName = "mcp_" + mcpTool.name;

      if (registeredTools.includes(piName)) continue;

      const params: TObject = jsonSchemaToTypeBox(mcpTool.inputSchema);

      pi.registerTool({
        name: piName,
        label: `MCP: ${mcpTool.name}`,
        description: mcpTool.description || `Chrome DevTools: ${mcpTool.name}`,
        parameters: params,
        async execute(_toolCallId, argsObj) {
          if (!client) throw new Error("MCP client not initialized");
          await client.ensureRunning();

          const result = await client.callTool(mcpTool.name, argsObj as Record<string, unknown>);

          if (result.isError) {
            const errorText = result.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
            return {
              content: [{ type: "text" as const, text: `MCP tool error: ${errorText}` }],
              details: { isError: true as const },
            };
          }

          const content = result.content.map((c) => {
            if (c.type === "image") {
              return { type: "image" as const, data: c.data, mimeType: c.mimeType };
            }
            return { type: "text" as const, text: c.text };
          });
          return { content, details: {} } as any;
        },
      });

      registeredTools.push(piName);
    }
  }

  // ── Auto-connect on session start ─────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const config = readConfig();
    client = new McpClient(config);

    client.ensureRunning()
      .then(() => registerTools())
      .then(() => ctx.ui?.notify?.("Chrome DevTools MCP ready", "info"))
      .catch((err: any) => ctx.ui?.notify?.(`Chrome DevTools MCP: ${err.message}`, "error"));
  });

  pi.on("session_shutdown", () => {
    if (client) {
      client.shutdown();
      client = null;
    }
    registeredTools = [];
  });
}
