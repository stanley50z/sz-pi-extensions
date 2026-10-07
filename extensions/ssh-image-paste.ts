import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { constants, readdirSync } from "node:fs";
import { request } from "node:http";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PNG } from "pngjs";

type ClipboardConnection = { socketPath: string; token: string };
type ClipboardSource = { imageDir: string } & (ClipboardConnection | { connectionsDir: string });
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Reject non-PNG and truncated payloads before storing or attaching them.
function validatePng(bytes: Buffer) {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Screenshot exceeds the 20 MiB limit");
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND") {
    throw new Error("Clipboard helper did not return a complete PNG image");
  }
  const pixels = bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
  if (pixels === 0 || pixels > 40_000_000) throw new Error("Screenshot exceeds the 40 megapixel limit or has invalid dimensions");
  PNG.sync.read(bytes, { checkCRC: true });
}

// Reads the Windows helper through OpenSSH's per-connection Unix socket forwarding.
async function readRemoteImage(connection: ClipboardConnection, signal: AbortSignal) {
  return new Promise<Buffer>((resolve, reject) => {
    const req = request({
      socketPath: connection.socketPath,
      path: "/image",
      headers: { Authorization: `Bearer ${connection.token}` },
      signal,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(res.statusCode === 409 ? "No image on the Windows clipboard" : `Clipboard helper returned HTTP ${res.statusCode}`));
        return;
      }
      if (res.headers["content-type"] !== "image/png") {
        res.destroy();
        reject(new Error("Clipboard helper did not return PNG content"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) res.destroy(new Error("Screenshot exceeds the 20 MiB limit"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const bytes = Buffer.concat(chunks);
          validatePng(bytes);
          resolve(bytes);
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// Checks authentication and reachability without asking any client to capture its clipboard.
async function isLiveConnection(connection: ClipboardConnection, signal: AbortSignal) {
  return new Promise<boolean>((resolve, reject) => {
    const req = request({
      socketPath: connection.socketPath, path: "/health",
      headers: { Authorization: `Bearer ${connection.token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 204);
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (signal.aborted) reject(signal.reason);
      else if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ABORT_ERR"].includes(error.code ?? "")) resolve(false);
      else reject(error);
    });
    req.end();
  });
}

// Resolve afresh on each paste so persistent Herdr panes do not keep a disconnected SSH client's token.
async function resolveConnection(source: ClipboardSource, signal: AbortSignal) {
  if (!("connectionsDir" in source)) return source;
  let names: string[];
  try { names = await readdir(source.connectionsDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    names = []; // No published connection exists yet.
  }
  const candidates = await Promise.all(names.filter((name) => /^[0-9a-f]{32}\.json$/.test(name)).map(async (name) => {
    let file;
    try { file = await open(join(source.connectionsDir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // Its launcher just exited.
      throw error;
    }
    let value: unknown;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4_096 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
        throw new Error(`SSH clipboard record is not private: ${name}`);
      }
      try { value = JSON.parse(await file.readFile("utf8")); }
      catch { throw new Error(`Invalid SSH clipboard record: ${name}`); }
    } finally { await file.close(); }
    if (!value || typeof value !== "object" || !("socketPath" in value) || !("token" in value)
      || typeof value.socketPath !== "string" || !isAbsolute(value.socketPath)
      || typeof value.token !== "string" || !/^[0-9a-f]{64}$/.test(value.token)) {
      throw new Error(`Invalid SSH clipboard record: ${name}`);
    }
    const connection = { socketPath: value.socketPath, token: value.token };
    return await isLiveConnection(connection, signal) ? connection : undefined;
  }));
  signal.throwIfAborted();
  const live = candidates.filter((connection) => connection !== undefined);
  if (live.length === 0) throw new Error("No active SSH clipboard connection. Reconnect using scripts/ssh-clipboard/ssh.py");
  if (live.length > 1) throw new Error("Multiple SSH clipboard connections are active. Close the extra clipboard-enabled connections before pasting");
  return live[0];
}

// Keep failures visible and persist their stacks, without recording clipboard contents or credentials.
async function reportFailure(ctx: ExtensionContext, source: ClipboardSource, phase: "paste" | "attachment", error: unknown) {
  ctx.ui.notify(`SSH image ${phase} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  try {
    const logsDir = join(dirname(source.imageDir), "logs");
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    await appendFile(join(logsDir, "ssh-clipboard.log"),
      `${new Date().toISOString()} ${phase}: ${error instanceof Error ? error.stack : String(error)}\n`, { mode: 0o600 });
  } catch {
    ctx.ui.notify("Could not write the SSH clipboard diagnostic log", "warning");
  }
}

// Installs Alt+V for a configured connection or a discovered SSH registry, leaving ordinary Pi unchanged.
export function createSshImagePasteExtension(source: ClipboardSource | undefined) {
  return (pi: ExtensionAPI) => {
    if (!source) return;
    let active = false;
    let pending: AbortController | undefined;
    pi.on("session_start", (_event, ctx) => { active = ctx.hasUI; });
    pi.on("session_shutdown", () => {
      active = false;
      pending?.abort();
    });
    pi.registerShortcut("alt+v", {
      description: "Paste a Windows clipboard image over SSH",
      handler: async (ctx) => {
        if (!active) return;
        if (pending) {
          ctx.ui.notify("An SSH image paste is already in progress", "warning");
          return;
        }
        const controller = new AbortController();
        pending = controller;
        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
          const connection = await resolveConnection(source, signal);
          const bytes = await readRemoteImage(connection, signal);
          controller.signal.throwIfAborted();
          await mkdir(source.imageDir, { recursive: true, mode: 0o700 });
          const path = join(source.imageDir, `${randomUUID()}.png`);
          await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
          controller.signal.throwIfAborted();
          ctx.ui.pasteToEditor(` @"${path}" `);
        } catch (error) {
          // A closing session cannot receive notifications. All live failures are visible.
          if (!controller.signal.aborted) {
            await reportFailure(ctx, source, "paste", error);
          }
        } finally {
          pending = undefined;
        }
      },
    });
    pi.on("input", async (event, ctx) => {
      if (event.source !== "interactive") return;
      if (pending) {
        pending.abort();
        ctx.ui.notify("SSH image paste cancelled because you submitted before it finished", "warning");
      }
      const images = [...(event.images ?? [])];
      try {
        for (const match of event.text.matchAll(/@"([^"\n]+\.png)"/g)) {
          const path = match[1];
          if (dirname(path) !== resolve(source.imageDir)
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/.test(basename(path))) continue;
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            if ((await file.stat()).size > MAX_IMAGE_BYTES) throw new Error("Screenshot exceeds the 20 MiB limit");
            const bytes = await file.readFile();
            validatePng(bytes);
            images.push({ type: "image", mimeType: "image/png", data: bytes.toString("base64") });
          } finally {
            await file.close();
          }
        }
      } catch (error) {
        if (!ctx.ui.getEditorText()) ctx.ui.setEditorText(event.text);
        await reportFailure(ctx, source, "attachment", error);
        return { action: "handled" };
      }
      if (images.length === (event.images?.length ?? 0)) return;
      return { action: "transform", text: event.text, images };
    });
  };
}

export default function sshImagePasteExtension(pi: ExtensionAPI) {
  const socketPath = process.env.PI_SSH_CLIPBOARD_SOCKET;
  const token = process.env.PI_SSH_CLIPBOARD_TOKEN;
  const connectionsDir = join(getAgentDir(), "ssh-clipboard", "connections");
  if (!socketPath && !token) {
    try {
      if (!readdirSync(connectionsDir).some((name) => /^[0-9a-f]{32}\.json$/.test(name))) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  // Inherited socket/token values only activate discovery; never reuse stale Herdr credentials.
  createSshImagePasteExtension({ connectionsDir, imageDir: join(getAgentDir(), "ssh-images") })(pi);
}
