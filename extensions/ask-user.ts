import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CUSTOM_CHOICE = "Type my own answer";
const NUMBER_KEYS = ["1", "2", "3", "4", "5", "6"] as const;

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

      let selectedIndex: number;
      let custom: string | undefined;
      const mode = (ctx as { mode?: "tui" | "rpc" | "json" | "print" }).mode;

      // Older Pi versions expose hasUI=true only in the TUI and do not provide ctx.mode.
      if (mode === "tui" || mode === undefined) {
        type TuiAnswer =
          | { kind: "selected"; index: number }
          | { kind: "custom"; answer: string }
          | null;

        const answer = await ctx.ui.custom<TuiAnswer>((tui, theme, keybindings, done) => {
          const customIndex = params.options.length;
          const editorTheme: EditorTheme = {
            borderColor: (text) => theme.fg("accent", text),
            selectList: {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            },
          };
          const editor = new Editor(tui, editorTheme);
          let optionIndex = 0;
          let focused = false;
          let finished = false;
          let cachedWidth: number | undefined;
          let cachedLines: string[] | undefined;

          const finish = (value: TuiAnswer) => {
            if (finished) return;
            finished = true;
            signal?.removeEventListener("abort", cancel);
            done(value);
          };
          const cancel = () => finish(null);
          signal?.addEventListener("abort", cancel, { once: true });

          const refresh = () => {
            editor.focused = focused && optionIndex === customIndex;
            cachedWidth = undefined;
            cachedLines = undefined;
            tui.requestRender();
          };

          editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (trimmed) finish({ kind: "custom", answer: trimmed });
          };

          const handleInput = (data: string) => {
            if (keybindings.matches(data, "tui.select.cancel")) {
              cancel();
              return;
            }
            if (keybindings.matches(data, "tui.select.up")) {
              optionIndex = Math.max(0, optionIndex - 1);
              refresh();
              return;
            }
            if (keybindings.matches(data, "tui.select.down")) {
              optionIndex = Math.min(customIndex, optionIndex + 1);
              refresh();
              return;
            }
            if (optionIndex !== customIndex) {
              const numberedIndex = NUMBER_KEYS.findIndex((key) => matchesKey(data, key));
              if (numberedIndex >= 0 && numberedIndex <= customIndex) {
                if (numberedIndex === customIndex) {
                  optionIndex = customIndex;
                  refresh();
                } else {
                  finish({ kind: "selected", index: numberedIndex });
                }
                return;
              }
            }
            if (optionIndex === customIndex) {
              editor.handleInput(data);
              refresh();
              return;
            }
            if (keybindings.matches(data, "tui.select.confirm")) {
              finish({ kind: "selected", index: optionIndex });
            }
          };

          const render = (width: number) => {
            const renderWidth = Math.max(1, width);
            if (cachedLines && cachedWidth === renderWidth) return cachedLines;

            const lines: string[] = [theme.fg("accent", "─".repeat(renderWidth))];
            const addWrapped = (prefix: string, text: string) => {
              const prefixWidth = visibleWidth(prefix);
              const available = Math.max(1, renderWidth - prefixWidth);
              const wrapped = wrapTextWithAnsi(text, available);
              const continuation = " ".repeat(prefixWidth);
              for (let index = 0; index < wrapped.length; index++) {
                lines.push(`${index === 0 ? prefix : continuation}${wrapped[index]}`);
              }
            };

            addWrapped(" ", theme.fg("text", params.question));
            lines.push("");

            params.options.forEach((option, index) => {
              const selected = index === optionIndex;
              const prefix = selected ? theme.fg("accent", "> ") : "  ";
              addWrapped(prefix, theme.fg(selected ? "accent" : "text", `${index + 1}. ${option.label}`));
              if (option.description) {
                addWrapped("     ", theme.fg("muted", option.description));
              }
            });

            const customSelected = optionIndex === customIndex;
            const customPrefix = customSelected ? theme.fg("accent", "> ") : "  ";
            addWrapped(
              customPrefix,
              theme.fg(customSelected ? "accent" : "text", `${customIndex + 1}. ${CUSTOM_CHOICE}`),
            );
            if (customSelected) {
              const indentWidth = Math.min(5, Math.max(0, renderWidth - 3));
              const indent = " ".repeat(indentWidth);
              for (const line of editor.render(renderWidth - indentWidth)) {
                lines.push(`${indent}${line}`);
              }
            }

            lines.push("");
            addWrapped(
              " ",
              theme.fg(
                "dim",
                customSelected
                  ? "Start typing • Enter submit • ↑ choose an option • Esc cancel"
                  : "↑↓ navigate • Enter select • Esc cancel",
              ),
            );
            lines.push(theme.fg("accent", "─".repeat(renderWidth)));
            cachedWidth = renderWidth;
            cachedLines = lines.map((line) => truncateToWidth(line, renderWidth, ""));
            return cachedLines;
          };

          return {
            get focused() {
              return focused;
            },
            set focused(value: boolean) {
              focused = value;
              editor.focused = value && optionIndex === customIndex;
            },
            render,
            handleInput,
            invalidate() {
              editor.invalidate();
              cachedWidth = undefined;
              cachedLines = undefined;
            },
            dispose() {
              signal?.removeEventListener("abort", cancel);
            },
          };
        });

        if (signal?.aborted) {
          return result("cancelled", params.question, "Question cancelled.");
        }
        if (answer === null || answer === undefined) {
          return result(
            "dismissed",
            params.question,
            "User dismissed the question without choosing an answer.",
          );
        }
        if (answer.kind === "custom") custom = answer.answer;
        else selectedIndex = answer.index;
      } else {
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
          custom = answer?.trim();
          if (!custom) {
            return result(
              "dismissed",
              params.question,
              "User dismissed the question without choosing an answer.",
            );
          }
        } else {
          selectedIndex = choices.indexOf(choice);
          if (selectedIndex < 0) {
            throw new Error("ask_user received an unknown selection from the UI");
          }
        }
      }

      if (custom) {
        return result(
          "custom",
          params.question,
          `User provided a custom answer: ${custom}`,
          custom,
        );
      }

      const answer = params.options[selectedIndex!].label;
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
