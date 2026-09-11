import { randomUUID } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { request } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PNG } from "pngjs";

type ClipboardConnection = { socketPath: string; token: string; imageDir: string };
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

// Installs Alt+V only in explicitly configured SSH clients; ordinary Pi stays unchanged.
export function createSshImagePasteExtension(connection: ClipboardConnection | undefined) {
  return (pi: ExtensionAPI) => {
    if (!connection) return;
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
          const bytes = await readRemoteImage(connection, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
          controller.signal.throwIfAborted();
          await mkdir(connection.imageDir, { recursive: true, mode: 0o700 });
          const path = join(connection.imageDir, `${randomUUID()}.png`);
          await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
          controller.signal.throwIfAborted();
          ctx.ui.pasteToEditor(` @"${path}" `);
        } catch (error) {
          // A closing session cannot receive notifications. All live failures are visible.
          if (!controller.signal.aborted) {
            ctx.ui.notify(`SSH image paste failed: ${error instanceof Error ? error.message : String(error)}`, "error");
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
          if (dirname(path) !== resolve(connection.imageDir)
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
        ctx.ui.notify(`SSH image attachment failed: ${error instanceof Error ? error.message : String(error)}`, "error");
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
  if (!socketPath && !token) return;
  if (!socketPath || !token || !/^[0-9a-f]{64}$/.test(token)) {
    throw new Error("Incomplete SSH clipboard configuration. Reconnect using scripts/ssh-clipboard/ssh.py");
  }
  createSshImagePasteExtension({ socketPath, token, imageDir: join(getAgentDir(), "ssh-images") })(pi);
}
