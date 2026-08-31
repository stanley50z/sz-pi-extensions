import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_FILENAME = "pi-autoupdate.json";
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
const UPDATED_VERSION_PATTERN = /Updated pi from \S+ to (\S+)/;

interface AutoupdateState {
  lastCheckAt: number;
}

function readState(statePath: string): AutoupdateState | undefined {
  if (!existsSync(statePath)) return undefined;

  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { lastCheckAt?: unknown };
  if (typeof parsed.lastCheckAt !== "number" || !Number.isFinite(parsed.lastCheckAt)) {
    throw new Error(`Expected ${statePath} to contain a numeric lastCheckAt`);
  }
  return { lastCheckAt: parsed.lastCheckAt };
}

function writeState(statePath: string, state: AutoupdateState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, statePath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function claimDailyCheck(statePath: string, now: number): boolean {
  const state = readState(statePath);
  if (state && now - state.lastCheckAt < UPDATE_INTERVAL_MS) return false;
  writeState(statePath, { lastCheckAt: now });
  return true;
}

function releaseDailyCheck(statePath: string, claimedAt: number): void {
  const state = readState(statePath);
  if (state?.lastCheckAt === claimedAt) unlinkSync(statePath);
}

function isOffline(): boolean {
  const value = process.env.PI_OFFLINE;
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

async function updatePi(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const result = await pi.exec(process.execPath, [process.argv[1], "update", "--self"], {
    timeout: UPDATE_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(detail);
  }

  const match = result.stdout.match(UPDATED_VERSION_PATTERN);
  if (!match) return;

  ctx.ui.notify(`Pi updated to v${match[1]}. Restart Pi to use the new version.`, "info");
}

export default function (pi: ExtensionAPI): void {
  const statePath = join(getAgentDir(), STATE_FILENAME);

  pi.on("session_start", (_event, ctx) => {
    const claimedAt = Date.now();
    if (isOffline() || !claimDailyCheck(statePath, claimedAt)) return;
    void updatePi(pi, ctx).catch((error: unknown) => {
      releaseDailyCheck(statePath, claimedAt);
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Pi autoupdate failed: ${message}`, "error");
    });
  });
}
