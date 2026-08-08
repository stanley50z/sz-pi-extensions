import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RESTORE_TERMINAL_TITLE_EVENT } from "../session-title.ts";

export function announceChromeReady(pi: ExtensionAPI, ctx: ExtensionContext) {
  pi.events.emit(RESTORE_TERMINAL_TITLE_EVENT, undefined);
  ctx.ui.notify("Chrome DevTools MCP ready", "info");
}
