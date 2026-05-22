import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = `You generate concise session titles for coding assistant conversations.

Return only the title.
Rules:
- 3 to 7 words
- No quotes
- No trailing punctuation
- Be specific to the user's task
- Prefer natural sentence case`;

const MAX_FIELD_CHARS = 1200;
const MAX_TITLE_CHARS = 60;

type CompleteFunction = typeof complete;

export interface SessionAutoNameDependencies {
  complete: CompleteFunction;
}

interface ConversationRound {
  user: string;
  assistant?: string;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => {
      return Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string";
    })
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function truncateField(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_FIELD_CHARS ? `${clean.slice(0, MAX_FIELD_CHARS - 1)}…` : clean;
}

export function sanitizeTitle(text: string): string | null {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;

  const cleaned = firstLine
    .replace(/^#+\s*/, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/[.!?。！？]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return null;
  return cleaned.length > MAX_TITLE_CHARS ? cleaned.slice(0, MAX_TITLE_CHARS).trim() : cleaned;
}

function collectAnsweredRounds(ctx: ExtensionContext): ConversationRound[] {
  const rounds: ConversationRound[] = [];

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      const userText = textFromContent(message.content);
      if (userText) rounds.push({ user: userText });
    } else if (message.role === "assistant" && rounds.length > 0 && !rounds[rounds.length - 1].assistant) {
      const assistantText = textFromContent(message.content);
      if (assistantText) rounds[rounds.length - 1].assistant = assistantText;
    }
  }

  return rounds.filter((round) => round.user && round.assistant);
}

function buildNamingPrompt(rounds: ConversationRound[]): string {
  return rounds
    .slice(0, 2)
    .map((round, index) => {
      const n = index + 1;
      return [`User prompt ${n}:`, truncateField(round.user), "", `Assistant answer ${n}:`, truncateField(round.assistant ?? "")].join("\n");
    })
    .join("\n\n");
}

async function generateSessionName(ctx: ExtensionContext, deps: SessionAutoNameDependencies): Promise<string | null> {
  if (!ctx.model) return null;

  const rounds = collectAnsweredRounds(ctx);
  if (rounds.length < 2) return null;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) return null;

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: buildNamingPrompt(rounds) }],
    timestamp: Date.now(),
  };

  const response = await deps.complete(
    ctx.model,
    { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
  );

  if (response.stopReason === "aborted") return null;

  const responseText = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  return sanitizeTitle(responseText);
}

export function createSessionAutoNameExtension(deps: SessionAutoNameDependencies) {
  return function sessionAutoName(pi: ExtensionAPI) {
    let namingInFlight = false;

    async function runNaming(ctx: ExtensionContext, options: { skipExisting: boolean; notify: boolean }) {
      if (namingInFlight || (options.skipExisting && pi.getSessionName())) return;

      namingInFlight = true;
      try {
        const title = await generateSessionName(ctx, deps);
        if (!title) {
          if (options.notify) ctx.ui.notify("Could not generate a session name yet", "warning");
          return;
        }
        if (options.skipExisting && pi.getSessionName()) return;
        pi.setSessionName(title);
        if (options.notify) ctx.ui.notify(`Session name set: ${title}`, "info");
      } finally {
        namingInFlight = false;
      }
    }

    pi.registerCommand("autoname", {
      description: "Generate a session name with the current model",
      handler: async (_args, ctx) => {
        await runNaming(ctx, { skipExisting: false, notify: true });
      },
    });

    pi.on("agent_end", async (_event, ctx) => {
      await runNaming(ctx, { skipExisting: true, notify: false });
    });
  };
}

export default createSessionAutoNameExtension({ complete });
