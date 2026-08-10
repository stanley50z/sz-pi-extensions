import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  fuzzyFilter,
} from "@earendil-works/pi-tui";

function extractSkillToken(lines: string[], cursorLine: number, cursorCol: number): string | undefined {
  const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
  return textBeforeCursor.match(/(?:^|[ \t])\$([a-z0-9-]*)$/)?.[1];
}

function skillItems(pi: ExtensionAPI, query: string): AutocompleteItem[] {
  const skills = pi.getCommands()
    .filter((command) => command.source === "skill")
    .map((command) => ({
      value: `$${command.name}`,
      label: `$${command.name}`,
      ...(command.description ? { description: command.description } : {}),
    }));

  if (!query) return skills;
  return fuzzyFilter(skills, query, (item) => item.value.slice(1));
}

function createSkillAutocompleteProvider(pi: ExtensionAPI, current: AutocompleteProvider): AutocompleteProvider {
  return {
    triggerCharacters: ["$"],

    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const query = extractSkillToken(lines, cursorLine, cursorCol);
      if (query === undefined) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const items = skillItems(pi, query);
      return items.length > 0 ? { prefix: `$${query}`, items } : null;
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!prefix.startsWith("$")) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }

      const currentLine = lines[cursorLine] ?? "";
      const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
      const afterCursor = currentLine.slice(cursorCol).replace(/^[ \t]+/, "");
      const completedLines = [...lines];
      completedLines[cursorLine] = `${beforePrefix}${item.value} ${afterCursor}`;
      return {
        lines: completedLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 1,
      };
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

interface SkillMention {
  name: string;
  index: number;
  length: number;
}

function firstLoadedSkillMention(pi: ExtensionAPI, text: string): SkillMention | undefined {
  const loadedSkills = new Set(
    pi.getCommands().filter((command) => command.source === "skill").map((command) => command.name),
  );
  const mentions = text.matchAll(/\$([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?=\s|$)/g);
  for (const mention of mentions) {
    const index = mention.index;
    const name = mention[1];
    if (index === undefined || !name) continue;
    if (index > 0 && !/\s/.test(text[index - 1] ?? "")) continue;
    if (loadedSkills.has(name)) return { name, index, length: mention[0].length };
  }
  return undefined;
}

export default function skillInvocationExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(pi, current));
  });

  pi.on("input", (event) => {
    const mention = firstLoadedSkillMention(pi, event.text);
    if (!mention) return { action: "continue" };

    const before = event.text.slice(0, mention.index).trimEnd();
    const after = event.text.slice(mention.index + mention.length).trimStart();
    const prompt = [before, after].filter(Boolean).join(" ");
    return {
      action: "transform",
      text: `/skill:${mention.name}${prompt ? ` ${prompt}` : ""}`,
    };
  });
}
