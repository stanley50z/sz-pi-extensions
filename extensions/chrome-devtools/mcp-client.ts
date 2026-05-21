// src/mcp-client.ts
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ──────────────────────────────────────────────────────

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
}

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

export interface McpConfig {
  headless?: boolean;
  viewport?: string;
  autoConnect?: boolean;
  browserUrl?: string;
  executablePath?: string;
  userDataDir?: string;
  isolated?: boolean;
  channel?: string;
  experimentalVision?: boolean;
  categoryEmulation?: boolean;
  categoryPerformance?: boolean;
  categoryNetwork?: boolean;
  quiet?: boolean;
}

// ── Client ─────────────────────────────────────────────────────

export class McpClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private buffer = "";
  private crashed = false;
  private config: McpConfig;
  private serverCapabilities: Record<string, unknown> = {};

  constructor(config: McpConfig = {}) {
    this.config = config;
  }

  // ── CLI argument building ────────────────────────────────────

  private buildArgs(): string[] {
    const args: string[] = [];
    const c = this.config;

    // Suppress info banners
    args.push("--no-performance-crux");

    if (c.headless) args.push("--headless");
    if (c.viewport) args.push("--viewport", c.viewport);
    if (c.autoConnect) args.push("--auto-connect");
    if (c.browserUrl) args.push("--browserUrl", c.browserUrl);
    if (c.executablePath) args.push("--executablePath", c.executablePath);
    if (c.userDataDir) args.push("--userDataDir", c.userDataDir);
    if (c.isolated) args.push("--isolated");
    if (c.channel) args.push("--channel", c.channel);
    if (c.experimentalVision) args.push("--experimentalVision");
    if (c.categoryEmulation === false) args.push("--categoryEmulation", "false");
    if (c.categoryPerformance === false) args.push("--categoryPerformance", "false");
    if (c.categoryNetwork === false) args.push("--categoryNetwork", "false");

    return args;
  }

  private resolveBinary(): string {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const localBin = join(__dirname, "..", "..", "node_modules", ".bin", "chrome-devtools-mcp");
    try {
      statSync(localBin);
      return localBin;
    } catch {
      return "npx";
    }
  }

  // ── Process lifecycle ────────────────────────────────────────

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const binary = this.resolveBinary();
      const cliArgs = this.buildArgs();
      // npx needs "chrome-devtools-mcp@latest" as first arg
      const cmdArgs = binary === "npx" ? ["chrome-devtools-mcp@latest", "--no-usage-statistics", ...cliArgs] : cliArgs;
      this.process = spawn(binary, cmdArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Attach stdout handler FIRST (before sending anything) to avoid race
      this.process.stdout!.on("data", (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) this.handleLine(line);
        }
      });

      this.process.stderr!.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg && !this.config.quiet) console.error("[chrome-devtools-mcp]", msg);
      });

      this.process.on("error", (err) => {
        this.crashed = true;
        reject(err);
      });

      this.process.on("exit", (code) => {
        this.crashed = true;
        this.process = null;
        for (const [, p] of this.pending) {
          p.reject(new Error(`MCP process exited with code ${code}`));
        }
        this.pending.clear();
      });

      // Send initialize AFTER stdout handler is attached
      this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-chrome-devtools", version: "0.1.0" },
      })
        .then((result: any) => {
          this.serverCapabilities = result.capabilities || {};
          this.sendNotification("notifications/initialized", {});
          resolve();
        })
        .catch(reject);
    });
  }

  isRunning(): boolean {
    return this.process !== null && !this.crashed;
  }

  async ensureRunning(): Promise<void> {
    if (!this.isRunning()) {
      this.crashed = false;
      this.nextId = 1;
      await this.start();
    }
  }

  shutdown(): void {
    if (this.process) {
      // Reject all pending
      for (const [, p] of this.pending) {
        p.reject(new Error("MCP client shutting down"));
      }
      this.pending.clear();
      this.process.kill("SIGTERM");
      this.process = null;
      this.crashed = true;
    }
  }

  // ── JSON-RPC protocol ────────────────────────────────────────

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} });
    this.process!.stdin!.write(request + "\n");

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      // Timeout after 60s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request '${method}' timed out`));
        }
      }, 60_000);
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notification = JSON.stringify({ jsonrpc: "2.0", method, params: params || {} });
    this.process!.stdin!.write(notification + "\n");
  }

  // ── MCP methods ──────────────────────────────────────────────

  async listTools(): Promise<McpToolDefinition[]> {
    const result = (await this.sendRequest("tools/list", {})) as { tools: McpToolDefinition[] };
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = (await this.sendRequest("tools/call", {
      name,
      arguments: args,
    })) as McpToolResult;
    return result;
  }
}
