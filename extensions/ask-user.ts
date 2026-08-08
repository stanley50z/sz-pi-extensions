import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CUSTOM_CHOICE = "Something else…";

const AskUserParameters = Type.Object({
  question: Type.String({
    minLength: 1,
    maxLength: 500,
    description: "One decision-focused question for the user",
  }),
  options: Type.Array(
    Type.Object({
      label: Type.String({
        minLength: 1,
        maxLength: 80,
        description: "Concise answer label",
      }),
      description: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 160,
          description: "Optional one-line explanation",
        }),
      ),
    }),
    {
      minItems: 2,
      maxItems: 5,
      description: "Two to five distinct answers; a free-form choice is added automatically",
    },
  ),
});

type AskOption = { label: string; description?: string };
type AskUserInput = { question: string; options: AskOption[] };

function result(
  outcome: "selected" | "custom" | "dismissed" | "cancelled" | "no-ui",
  question: string,
  text: string,
  answer?: string,
  selectedIndex?: number,
) {
  return {
    content: [{ type: "text" as const, text }],
    details: { outcome, question, answer, selectedIndex },
  };
}

function validateInput(params: AskUserInput) {
  const question = params.question.trim();
  if (!question) throw new Error("ask_user requires a non-empty question");

  const labels = params.options.map((option) => option.label.trim());
  if (labels.some((label) => !label)) {
    throw new Error("ask_user option labels cannot be empty");
  }
  const normalized = labels.map((label) => label.toLocaleLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("ask_user option labels must be unique");
  }

  return {
    question,
    options: params.options.map((option, index) => ({
      label: labels[index],
      description: option.description?.trim(),
    })),
  };
}

export default function askUserExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask one multiple-choice question with 2-5 options. The user may choose a " +
      "listed answer, write a different answer, or dismiss the question.",
    promptSnippet: "Ask the user one structured multiple-choice question",
    promptGuidelines: [
      "Use ask_user when the next step depends on a user decision with a small set of likely answers.",
      "Ask only one decision per ask_user call; use another call for a follow-up question.",
    ],
    executionMode: "sequential",
    parameters: AskUserParameters,

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = validateInput(rawParams as AskUserInput);
      if (!ctx.hasUI) {
        return result(
          "no-ui",
          params.question,
          "Interactive UI is unavailable. Ask the question in normal conversation instead.",
        );
      }
      if (signal?.aborted) {
        return result("cancelled", params.question, "Question cancelled.");
      }

      const choices = params.options.map((option) =>
        option.description ? `${option.label} — ${option.description}` : option.label,
      );
      const choice = await ctx.ui.select(
        params.question,
        [...choices, CUSTOM_CHOICE],
        signal ? { signal } : undefined,
      );

      if (signal?.aborted) {
        return result("cancelled", params.question, "Question cancelled.");
      }
      if (choice === undefined) {
        return result(
          "dismissed",
          params.question,
          "User dismissed the question without choosing an answer.",
        );
      }

      if (choice === CUSTOM_CHOICE) {
        const answer = await ctx.ui.input(
          "Your answer",
          "Type a response",
          signal ? { signal } : undefined,
        );
        if (signal?.aborted) {
          return result("cancelled", params.question, "Question cancelled.");
        }
        const custom = answer?.trim();
        if (!custom) {
          return result(
            "dismissed",
            params.question,
            "User dismissed the question without choosing an answer.",
          );
        }
        return result(
          "custom",
          params.question,
          `User provided a custom answer: ${custom}`,
          custom,
        );
      }

      const selectedIndex = choices.indexOf(choice);
      if (selectedIndex < 0) {
        throw new Error("ask_user received an unknown selection from the UI");
      }
      const answer = params.options[selectedIndex].label;
      return result(
        "selected",
        params.question,
        `User selected option ${selectedIndex + 1}: ${answer}`,
        answer,
        selectedIndex + 1,
      );
    },
  });
}
