import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";
type ModelLike = {
  provider: string;
  id: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

const LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];
const SHORTHANDS: Record<string, ThinkingLevel> = {
  o: "off",
  l: "low",
  m: "medium",
  h: "high",
  xh: "xhigh",
};

function parseThinkingLevel(input: string): ThinkingLevel | undefined {
  const normalized = input.trim().toLowerCase();
  if (normalized in SHORTHANDS) return SHORTHANDS[normalized];
  return LEVELS.includes(normalized as ThinkingLevel) ? (normalized as ThinkingLevel) : undefined;
}

function availableLevels(model: ModelLike | undefined): ThinkingLevel[] {
  if (!model) return LEVELS;
  if (!model.reasoning) return ["off"];

  return LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function successMessage(level: ThinkingLevel, model: ModelLike | undefined): string {
  const providerEffort = model?.thinkingLevelMap?.[level];
  return typeof providerEffort === "string" && providerEffort !== level
    ? `Reasoning: ${level} (provider effort: ${providerEffort})`
    : `Reasoning: ${level}`;
}

export default function (pi: ExtensionAPI) {
  let currentModel: ModelLike | undefined;

  pi.on("session_start", (_event, ctx) => {
    currentModel = ctx.model;
  });

  pi.on("model_select", (event) => {
    currentModel = event.model;
  });

  pi.registerCommand("r", {
    description: "Change reasoning level",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const supported = new Set(availableLevels(currentModel));
      const values = ["o", "l", "m", "h", "xh", ...LEVELS];
      const items = values
        .filter((value) => {
          const level = parseThinkingLevel(value);
          return level && supported.has(level) && value.startsWith(normalized);
        })
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const supported = availableLevels(ctx.model);
      let level: ThinkingLevel | undefined;

      if (trimmed.length === 0) {
        const selected = await ctx.ui.select("Reasoning level", supported);
        if (!selected) return;
        level = parseThinkingLevel(selected);
      } else {
        level = parseThinkingLevel(trimmed);
      }

      if (!level) {
        ctx.ui.notify(`Unknown reasoning level: ${trimmed}`, "error");
        return;
      }

      if (!supported.includes(level)) {
        const modelName = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the active model";
        ctx.ui.notify(
          `Reasoning ${level} is unsupported by ${modelName}. Available: ${supported.join(", ")}`,
          "error",
        );
        return;
      }

      pi.setThinkingLevel(level);
      ctx.ui.notify(successMessage(level, ctx.model), "info");
    },
  });
}
