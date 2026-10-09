import { constants } from "node:fs";
import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REMOTE_GUIDELINE = "The artifact preview service is active. Put user-facing previews/reports and their relative assets in the current project's data/previews or .pi/artifacts. Call artifact_link before handing off each file and use its HTTP URL, including before ask_user. For this workflow these browser URLs replace local paths and file:/// handoff links. Do not expose the project or home directory.";

// State is private control data, not a user-supplied URL or proxy destination.
async function readServiceState(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || (process.platform !== "win32"
      && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      throw new Error("Artifact preview state must be a private regular file owned by you");
    }
    let value: unknown;
    try { value = JSON.parse(await file.readFile("utf8")); }
    catch { throw new Error("Invalid artifact preview state; inspect server.log"); }
    if (!value || typeof value !== "object" || !("port" in value) || !("token" in value)
      || typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
      || typeof value.token !== "string" || !/^[0-9a-f]{64}$/.test(value.token)) {
      throw new Error("Invalid artifact preview state; inspect server.log");
    }
    return { port: value.port, token: value.token };
  } finally { await file.close(); }
}

// Use a direct loopback HTTP request so environment proxies cannot receive the control token.
async function publishArtifact(state: Awaited<ReturnType<typeof readServiceState>>, cwd: string, path: string, signal: AbortSignal) {
  const body = JSON.stringify({ cwd, path });
  return new Promise<string>((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1", port: state.port, path: "/publish", method: "POST", signal,
      headers: { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16_384) res.destroy(new Error("Artifact preview response exceeded 16 KiB"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) throw new Error(`Artifact publication failed (HTTP ${res.statusCode}): ${text}`);
          let value: unknown;
          try { value = JSON.parse(text); }
          catch { throw new Error("Invalid artifact preview response"); }
          if (!value || typeof value !== "object" || !("url" in value) || typeof value.url !== "string"
            || !value.url.startsWith(`http://127.0.0.1:${state.port}/`)
            || !/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/[^\s]+$/.test(value.url)) {
            throw new Error("Invalid artifact preview URL");
          }
          resolve(value.url);
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

// Probe without proxies; a refused listener is expected after a crash until the next SSH reconnect.
async function serviceIsLive(state: Awaited<ReturnType<typeof readServiceState>>) {
  return new Promise<boolean>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: state.port, path: "/health",
      headers: { Authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(1_000) }, (res) => {
      res.resume();
      if (res.statusCode === 204) resolve(true);
      else reject(new Error(`Artifact preview health check failed (HTTP ${res.statusCode})`));
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
    req.end();
  });
}

// Register the model-facing seam; the standalone Python service owns serving and lifecycle.
export function createArtifactLinkExtension(agentDir: string) {
  return (pi: ExtensionAPI) => {
    const statePath = join(agentDir, "artifact-preview", "server.json");
    pi.on("before_agent_start", async (event) => {
      try { await stat(join(agentDir, "artifact-preview", "server.ready")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // No preview service is configured.
        throw error;
      }
      if (await serviceIsLive(await readServiceState(statePath))) {
        event.systemPromptOptions.promptGuidelines.push(REMOTE_GUIDELINE);
      }
    });
    pi.registerTool({
      name: "artifact_link",
      label: "Artifact link",
      description: "Publish a preview/report file from the current project's data/previews or .pi/artifacts and return a browser URL usable over the SSH preview tunnel. Relative images/CSS in that preview directory are served too. Requires scripts/artifact-preview/start.py on the remote host; the clipboard-enabled SSH launcher starts it automatically. Other files must first be placed in a designated preview directory.",
      promptSnippet: "Return a browser link for a remote preview or report",
      parameters: Type.Object({ path: Type.String({ description: "Existing artifact file, absolute or relative to the current working directory" }) }),
      outputSchema: Type.Object({ url: Type.String() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        try {
          let state;
          try { state = await readServiceState(statePath); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              throw new Error("Artifact preview service is not running. Reconnect with scripts/ssh-clipboard/ssh.py, or run scripts/artifact-preview/start.py on the remote host");
            }
            throw error;
          }
          const timeout = AbortSignal.timeout(10_000);
          const url = await publishArtifact(state, ctx.cwd, params.path,
            signal ? AbortSignal.any([signal, timeout]) : timeout);
          return { content: [{ type: "text", text: url }], details: { url }, structuredContent: { url } };
        } catch (error) {
          const logs = join(agentDir, "logs");
          await mkdir(logs, { recursive: true, mode: 0o700 });
          await appendFile(join(logs, "artifact-link.log"),
            `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`, { mode: 0o600 });
          throw error;
        }
      },
    });
  };
}

// Pi loads this entry point on every platform without starting a server or socket.
export default function artifactLinkExtension(pi: ExtensionAPI) {
  createArtifactLinkExtension(getAgentDir())(pi);
}
