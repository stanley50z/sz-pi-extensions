import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Adds a commit action to the existing editor without changing its draft or key handling. */
export default function commitButtonExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const previousFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      const editor = previousFactory?.(tui, editorTheme, keybindings)
        ?? new CustomEditor(tui, editorTheme, keybindings);
      const render = editor.render.bind(editor);
      const handleMouse = editor.handleMouse?.bind(editor);
      const label = "[ commit ]";
      let buttonStart = -1;
      editor.render = (width) => {
        const lines = [...render(width)];
        buttonStart = width >= label.length + 4 && lines.length > 0 ? width - label.length : -1;
        if (buttonStart >= 0) {
          const prefix = truncateToWidth(lines[0], buttonStart, "");
          lines[0] = prefix + " ".repeat(buttonStart - visibleWidth(prefix))
            + ctx.ui.theme.fg("accent", label);
        }
        return lines;
      };
      editor.handleMouse = (event) => {
        if (buttonStart >= 0 && event.y === 0 && event.x >= buttonStart
          && event.x < buttonStart + label.length && event.button === "left") {
          if (event.type === "click") {
            pi.sendUserMessage("$commit", { deliverAs: "followUp", expandPromptTemplates: true });
          }
          return { handled: true };
        }
        return handleMouse?.(event);
      };
      return editor;
    });
  });
}
