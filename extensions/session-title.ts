import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const RESTORE_TERMINAL_TITLE_EVENT = "sz:restore-terminal-title";

/** Formats titles for session updates and notification-target restoration. */
export function formatTerminalTitle(sessionName: string | undefined): string {
  const name = sessionName?.trim() || "Untitled session";
  return process.env.HERDR_ENV === "1" ? name : `Pi - ${name}`;
}

export default function sessionTitle(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;

  const updateTitle = (name = pi.getSessionName()) => {
    ctx?.ui.setTitle(formatTerminalTitle(name));
  };

  const unsubscribeRestore = pi.events.on(RESTORE_TERMINAL_TITLE_EVENT, () => {
    updateTitle();
  });

  pi.on("session_start", (_event, sessionCtx) => {
    ctx = sessionCtx;
    updateTitle();
  });

  pi.on("session_info_changed", (event, sessionCtx) => {
    ctx = sessionCtx;
    updateTitle(event.name);
  });

  pi.on("session_shutdown", () => {
    unsubscribeRestore();
    ctx = undefined;
  });
}
