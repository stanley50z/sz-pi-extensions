import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
}

export interface CodexRateLimits {
  windows: CodexRateLimitWindow[];
}

export interface ReadCodexRateLimitsOptions {
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = "";
  private closed = false;

  constructor(options: ReadCodexRateLimitsOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.child = spawn(options.command ?? "codex", options.args ?? ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.once("error", (error) => this.rejectAll(error));
    this.child.once("exit", (code, signal) => {
      if (!this.closed) {
        this.rejectAll(new Error(`Codex app-server exited (${signal ?? `code ${code ?? "unknown"}`})`));
      }
    });
  }

  async readRateLimits(): Promise<CodexRateLimits> {
    await this.request("initialize", {
      clientInfo: { name: "sz-pi-footer", title: "SZ Pi Footer", version: "1.0.0" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: null },
    });
    this.write({ method: "initialized" });
    const result = await this.request("account/rateLimits/read");
    return decodeRateLimits(result);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("Codex app-server client closed"));
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: unknown): void {
    if (this.closed) throw new Error("Codex app-server client is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.rejectAll(new Error("Codex app-server returned invalid JSON"));
        continue;
      }
      this.handle(message);
    }
  }

  private handle(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id === "number" && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = message.error;
      if (error && typeof error === "object") {
        const text = (error as { message?: unknown }).message;
        pending.reject(new Error(typeof text === "string" ? text : "Codex app-server request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (id !== undefined && typeof message.method === "string") {
      this.write({ id, error: { code: -32601, message: "Unsupported request" } });
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function decodeRateLimits(value: unknown): CodexRateLimits {
  if (!value || typeof value !== "object") {
    throw new Error("Codex app-server returned an invalid rate-limit response");
  }
  const rateLimits = (value as { rateLimits?: unknown }).rateLimits;
  if (!rateLimits || typeof rateLimits !== "object") {
    throw new Error("Codex app-server response did not include rate limits");
  }

  const source = rateLimits as { primary?: unknown; secondary?: unknown };
  const windows: CodexRateLimitWindow[] = [];
  for (const candidate of [source.primary, source.secondary]) {
    if (candidate === null || candidate === undefined) continue;
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Codex app-server returned an invalid rate-limit window");
    }
    const { usedPercent, windowDurationMins } = candidate as Record<string, unknown>;
    if (
      typeof usedPercent !== "number" ||
      !Number.isFinite(usedPercent) ||
      usedPercent < 0 ||
      usedPercent > 100 ||
      typeof windowDurationMins !== "number" ||
      !Number.isSafeInteger(windowDurationMins) ||
      windowDurationMins <= 0
    ) {
      throw new Error("Codex app-server returned an invalid rate-limit window");
    }
    windows.push({ usedPercent, windowDurationMins });
  }

  if (windows.length === 0) {
    throw new Error("Codex app-server did not return any rate-limit windows");
  }
  return { windows };
}

export async function readCodexRateLimits(
  options: ReadCodexRateLimitsOptions = {},
): Promise<CodexRateLimits> {
  const client = new CodexAppServerClient(options);
  try {
    return await client.readRateLimits();
  } finally {
    client.close();
  }
}
