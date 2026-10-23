import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CustomEditor, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getNativePlatformHelper } from "@earendil-works/pi-tui/dist/native-platform.js";
import { trackTerminalFocus } from "../lib/terminal-focus.ts";

type CommitButtonDeps = { isCtrlPressed?: () => boolean };

/** Adds Commit, or Exit while Ctrl is held, without changing the editor's draft or keys. */
export function createCommitButtonExtension(deps: CommitButtonDeps = {}) {
  return function commitButtonExtension(pi: ExtensionAPI): void {
    let stopPolling: (() => void) | undefined;
    pi.on("session_shutdown", () => stopPolling?.());
    pi.on("session_start", (_event, ctx) => {
      stopPolling?.();
      if (ctx.mode !== "tui") return;
      const previousFactory = ctx.ui.getEditorComponent();
      ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
        stopPolling?.();
        const editor = previousFactory?.(tui, editorTheme, keybindings)
          ?? new CustomEditor(tui, editorTheme, keybindings);
        const render = editor.render.bind(editor);
        const handleMouse = editor.handleMouse?.bind(editor);
        const native = !process.env.SSH_CONNECTION && !process.env.SSH_TTY
          ? getNativePlatformHelper() : undefined;
        const readModifier = native?.isModifierPressed;
        const isCtrlPressed = deps.isCtrlPressed ?? (readModifier ? () => readModifier("control") : undefined);
        let ctrlHeld = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        const focus = isCtrlPressed ? trackTerminalFocus(tui) : undefined;
        const stop = () => {
          clearInterval(timer);
          focus?.dispose();
        };
        stopPolling = stop;
        const poll = () => {
          if (!isCtrlPressed) return;
          try {
            const held = focus?.focused !== false && isCtrlPressed();
            if (held === ctrlHeld) return;
            ctrlHeld = held;
            tui.requestRender();
          } catch (error) {
            stop();
            ctrlHeld = false;
            tui.requestRender();
            ctx.ui.notify("Commit button key detector failed; see logs/commit-button.log", "error");
            void (async () => {
              const directory = join(getAgentDir(), "logs");
              await mkdir(directory, { recursive: true });
              await appendFile(join(directory, "commit-button.log"),
                `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`, "utf8");
            })().catch((loggingError: unknown) => console.error("Could not persist commit button error", loggingError));
          }
        };
        if (isCtrlPressed) {
          timer = setInterval(poll, 50);
          timer.unref();
          poll();
        }
        let label = "[ commit ]";
        let buttonStart = -1;
        editor.render = (width) => {
          const lines = [...render(width)];
          label = ctrlHeld ? "[ exit ]" : "[ commit ]";
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
              // Trust the click's modifier, not the last poll, including over SSH.
              // Pi wires onSubmit after the factory returns. Use its built-in /quit
              // handler: ctx.shutdown() would wait for busy work to finish instead.
              if (event.ctrl) editor.onSubmit!("/quit");
              else pi.sendUserMessage("$commit", { deliverAs: "followUp", expandPromptTemplates: true });
            }
            return { handled: true };
          }
          return handleMouse?.(event);
        };
        return editor;
      });
    });
  };
}

export default createCommitButtonExtension();
