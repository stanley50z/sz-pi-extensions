import {
  CustomEditor,
  type ExtensionAPI,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type EditorComponent,
  fuzzyFilter,
} from "@earendil-works/pi-tui";

interface CursorEditor extends EditorComponent {
  getCursor(): { line: number; col: number };
  getLines(): string[];
}

function isCursorEditor(editor: EditorComponent): editor is CursorEditor {
  return "getCursor" in editor
    && typeof editor.getCursor === "function"
    && "getLines" in editor
    && typeof editor.getLines === "function";
}

function addSkillSubmitCompletion(
  editor: EditorComponent,
  keybindings: KeybindingsManager,
  hasSkillCompletions: (query: string) => boolean,
): EditorComponent {
  const handleInput = editor.handleInput.bind(editor);

  editor.handleInput = (data) => {
    if (isCursorEditor(editor)) {
      const { line, col } = editor.getCursor();
      const textBeforeCursor = (editor.getLines()[line] ?? "").slice(0, col);
      const slashQuery = line === 0
        ? textBeforeCursor.match(/^\s*\/skill:([a-z0-9-]*)$/)?.[1]
        : undefined;
      const dollarQuery = textBeforeCursor.match(/(?:^|[ \t])\$([a-z0-9-]*)$/)?.[1];
      const hasCompletion = [slashQuery, dollarQuery].some(
        (query) => query !== undefined && hasSkillCompletions(query),
      );

      if (hasCompletion && keybindings.matches(data, "tui.input.submit")) {
        handleInput("\t");
        return;
      }
    }

    handleInput(data);
  };

  return editor;
}

function extractSkillToken(lines: string[], cursorLine: number, cursorCol: number): string | undefined {
  const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
  return textBeforeCursor.match(/(?:^|[ \t])\$([a-z0-9-]*)$/)?.[1];
}

function skillName(commandName: string): string {
  return commandName.startsWith("skill:") ? commandName.slice("skill:".length) : commandName;
}

function skillItems(pi: ExtensionAPI, query: string): AutocompleteItem[] {
  const skills = pi.getCommands()
    .filter((command) => command.source === "skill")
    .map((command) => {
      const name = skillName(command.name);
      return {
        value: `$${name}`,
        label: `$${name}`,
        ...(command.description ? { description: command.description } : {}),
      };
    });

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
    pi.getCommands()
      .filter((command) => command.source === "skill")
      .map((command) => skillName(command.name)),
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
    const previousFactory = ctx.ui.getEditorComponent?.();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = previousFactory?.(tui, theme, keybindings)
        ?? new CustomEditor(tui, theme, keybindings);
      return addSkillSubmitCompletion(
        editor,
        keybindings,
        (query) => skillItems(pi, query).length > 0,
      );
    });
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
