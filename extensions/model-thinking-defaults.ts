import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ModelLike = { provider: string; id: string };

function defaultThinkingLevel(model: ModelLike | undefined): ThinkingLevel | undefined {
  if (!model) return undefined;

  const modelId = model.id.toLowerCase();
  if (model.provider === "deepseek") return "max";
  if (model.provider === "openai-codex" && modelId.includes("luna")) return "max";
  if (model.provider === "openai-codex" && modelId === "gpt-5.6-sol") return "high";
  if (model.provider === "github-copilot" && modelId === "claude-fable-5") return "high";
  return undefined;
}

function applyDefault(pi: ExtensionAPI, model: ModelLike | undefined): void {
  const level = defaultThinkingLevel(model);
  if (level) pi.setThinkingLevel(level);
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    applyDefault(pi, ctx.model);
  });

  pi.on("model_select", (event) => {
    applyDefault(pi, event.model);
  });
}
