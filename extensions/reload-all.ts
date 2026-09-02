import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const REQUEST_FILENAME = "reload-all.json";
const REMOTE_REQUEST_PREFIX = "__remote_request__=";

interface ReloadRequest {
  id: string;
  originId: string;
  requestedAt: number;
}

function isAutomodeSession(ctx: ExtensionContext): boolean {
  if (process.env.AUTOMODE_STAGE_CONFIGURATION !== undefined) return true;

  return ctx.sessionManager.getEntries().some(
    (entry) => entry.type === "custom"
      && (entry.customType === "automode.stage-configuration"
        || entry.customType === "automode.coordinator"),
  );
}

function readRequest(requestPath: string): ReloadRequest | undefined {
  try {
    const request = JSON.parse(readFileSync(requestPath, "utf8")) as Partial<ReloadRequest>;
    if (
      typeof request.id !== "string"
      || typeof request.originId !== "string"
      || typeof request.requestedAt !== "number"
      || !Number.isFinite(request.requestedAt)
    ) {
      throw new Error("expected id, originId, and requestedAt fields");
    }
    return request as ReloadRequest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read reload request from ${requestPath}: ${(error as Error).message}`);
  }
}

function writeRequest(requestPath: string, request: ReloadRequest): void {
  mkdirSync(dirname(requestPath), { recursive: true });
  const temporaryPath = `${requestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(request)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, requestPath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export default function (pi: ExtensionAPI): void {
  const instanceId = randomUUID();
  const requestPath = join(getAgentDir(), REQUEST_FILENAME);
  let lastSeenRequestId: string | undefined;
  let pendingRequestId: string | undefined;
  let requestWatcher: FSWatcher | undefined;
  let syncTimer: NodeJS.Timeout | undefined;

  function queueRemoteReload(request: ReloadRequest): void {
    if (request.id === lastSeenRequestId || request.originId === instanceId) return;
    lastSeenRequestId = request.id;
    pendingRequestId = request.id;
    pi.sendUserMessage(`/reload-all ${REMOTE_REQUEST_PREFIX}${request.id}`, {
      deliverAs: "followUp",
      expandPromptTemplates: true,
    });
  }

  function syncFromDisk(ctx: ExtensionContext): void {
    try {
      const request = readRequest(requestPath);
      if (request) queueRemoteReload(request);
    } catch (error) {
      ctx.ui.notify(`Reload-all sync failed: ${(error as Error).message}`, "error");
    }
  }

  function startWatching(ctx: ExtensionContext): void {
    mkdirSync(dirname(requestPath), { recursive: true });
    requestWatcher?.close();

    const requestBeforeWatch = readRequest(requestPath);
    lastSeenRequestId = requestBeforeWatch?.id;
    requestWatcher = watch(dirname(requestPath), { persistent: false }, (_eventType, filename) => {
      if (filename && filename.toString() !== REQUEST_FILENAME) return;
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        syncTimer = undefined;
        syncFromDisk(ctx);
      }, 20);
      syncTimer.unref();
    });
    requestWatcher.on("error", (error) => {
      ctx.ui.notify(`Reload-all sync failed: ${error.message}`, "error");
    });

    const requestAfterWatch = readRequest(requestPath);
    if (requestAfterWatch?.id !== requestBeforeWatch?.id) queueRemoteReload(requestAfterWatch);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!isAutomodeSession(ctx)) startWatching(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = undefined;
    requestWatcher?.close();
    requestWatcher = undefined;
  });

  pi.registerCommand("reload-all", {
    description: "Reload every running normal Pi instance",
    handler: async (args, ctx) => {
      const remoteRequestId = args.startsWith(REMOTE_REQUEST_PREFIX)
        ? args.slice(REMOTE_REQUEST_PREFIX.length)
        : undefined;

      if (remoteRequestId) {
        if (remoteRequestId !== pendingRequestId) return;
        pendingRequestId = undefined;
        if (isAutomodeSession(ctx)) return;
        await ctx.reload();
        return;
      }

      if (args.trim()) {
        ctx.ui.notify("Usage: /reload-all", "error");
        return;
      }

      const request = {
        id: randomUUID(),
        originId: instanceId,
        requestedAt: Date.now(),
      };
      lastSeenRequestId = request.id;
      writeRequest(requestPath, request);
      if (isAutomodeSession(ctx)) {
        ctx.ui.notify("Reloading normal Pi instances; leaving Automode unchanged...", "info");
        return;
      }
      ctx.ui.notify("Reloading all normal Pi instances...", "info");
      await ctx.reload();
      return;
    },
  });
}
