import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
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

export default function (pi: ExtensionAPI) {
  pi.registerCommand("r", {
    description: "Change reasoning level",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const values = ["o", "l", "m", "h", "xh", ...LEVELS];
      const items = values
        .filter((value) => value.startsWith(normalized))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      let level: ThinkingLevel | undefined;

      if (trimmed.length === 0) {
        const selected = await ctx.ui.select("Reasoning level", LEVELS);
        if (!selected) return;
        level = parseThinkingLevel(selected);
      } else {
        level = parseThinkingLevel(trimmed);
      }

      if (!level) {
        ctx.ui.notify(`Unknown reasoning level: ${trimmed}`, "error");
        return;
      }

      pi.setThinkingLevel(level);
      ctx.ui.notify(`Reasoning: ${level}`, "info");
    },
  });
}
