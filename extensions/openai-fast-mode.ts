import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "openai-fast-mode";
const SUPPORTED_APIS = new Set<Api>(["openai-responses", "openai-codex-responses"]);
type SpeedLevel = "normal" | "fast" | "ultrafast";
const SPEED_LEVELS = {
  normal: { serviceTier: undefined, status: undefined },
  fast: { serviceTier: "priority", status: "⚡fast" },
  ultrafast: { serviceTier: "ultrafast", status: "⚡ultrafast" },
} as const;

// Loads and saves one speed level for the exact working directory, not its parents.
function projectSpeed(cwd: string, save?: SpeedLevel): SpeedLevel {
  const path = join(cwd, ".pi", "openai-fast-mode.json");
  try {
    if (save !== undefined) {
      mkdirSync(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporaryPath, `${JSON.stringify({ level: save })}\n`, "utf8");
        renameSync(temporaryPath, path);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
      return save;
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "normal";
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && "level" in value &&
        (value.level === "normal" || value.level === "fast" || value.level === "ultrafast")) {
      return value.level;
    }
    throw new Error(`Invalid speed level in ${path}. Expected normal, fast, or ultrafast.`);
  } catch (error) {
    const logPath = join(cwd, ".pi", "logs", "openai-speed.log");
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`, "utf8");
    } catch (logError) {
      throw new AggregateError([error, logError], `Speed setting failed; could not write ${logPath}`);
    }
    throw error;
  }
}

// Checks request API compatibility, not account or model entitlement to a tier.
function isSupportedModel(model: Model<Api> | undefined): boolean {
  return Boolean(model && SUPPORTED_APIS.has(model.api));
}

// Adds three peer speed levels, restored per project when a session starts.
export default function (pi: ExtensionAPI) {
  pi.registerFlag("fast", {
    description: "Start with OpenAI fast mode enabled",
    type: "boolean",
    default: false,
  });

  let level: SpeedLevel = pi.getFlag("fast") === true ? "fast" : "normal";

  // Keeps the existing footer indicator aligned with the selected speed level.
  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, isSupportedModel(ctx.model) ? SPEED_LEVELS[level].status : undefined);
  }

  pi.on("before_provider_request", (event, ctx) => {
    const serviceTier = SPEED_LEVELS[level].serviceTier;
    if (!serviceTier || !isSupportedModel(ctx.model)) return;
    return { ...(event.payload as Record<string, unknown>), service_tier: serviceTier };
  });

  pi.on("session_start", async (_event, ctx) => {
    level = "normal";
    level = pi.getFlag("fast") === true ? "fast" : projectSpeed(ctx.cwd);
    updateStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });

  for (const [name, label] of [
    ["fast", "Fast"],
    ["ultrafast", "Ultrafast"],
  ] as const) {
    pi.registerCommand(name, {
      description: `Toggle OpenAI ${name} mode`,
      getArgumentCompletions: name === "fast" ? (prefix: string) => {
        const normalized = prefix.trim().toLowerCase();
        const items = ["on", "off", "status"]
          .filter((value) => value.startsWith(normalized))
          .map((value) => ({ value, label: value }));
        return items.length > 0 ? items : null;
      } : undefined,
      handler: async (args, ctx) => {
        const command = args.trim().toLowerCase();
        if (name === "ultrafast" && command !== "") {
          ctx.ui.notify("Usage: /ultrafast", "error");
          return;
        }
        if (command === "status") {
          updateStatus(ctx);
          const support = isSupportedModel(ctx.model) ? "supported" : "unsupported";
          ctx.ui.notify(`${label} mode: ${level === name ? "on" : "off"} (${support})`, "info");
          return;
        }
        let nextLevel: SpeedLevel;
        if (command === "") nextLevel = level === name ? "normal" : name;
        else if (command === "on") nextLevel = name;
        else if (command === "off") nextLevel = "normal";
        else {
          ctx.ui.notify(`Usage: /${name} [on|off|status]`, "error");
          return;
        }
        level = projectSpeed(ctx.cwd, nextLevel);
        updateStatus(ctx);
        ctx.ui.notify(`${label} mode: ${level === name ? "on" : "off"}`, "info");
      },
    });
  }
}
