/**
 * turn-elapsed — shows the current agent-turn duration directly above the editor.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "sz-turn-elapsed";
const TICK_MS = 1_000;

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);

  if (totalMinutes === 0) return `${seconds}s`;

  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours === 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${hours}h ${minutes.toString().padStart(2, "0")}m ${seconds
    .toString()
    .padStart(2, "0")}s`;
}

export default function turnElapsedExtension(pi: ExtensionAPI) {
  let activeContext: ExtensionContext | null = null;
  let startedAt: number | null = null;
  let lastElapsedMs: number | null = null;
  let requestWidgetRender: (() => void) | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  function stopTicker(): void {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  }

  function startTicker(): void {
    if (ticker !== null) return;
    ticker = setInterval(() => requestWidgetRender?.(), TICK_MS);
    ticker.unref?.();
  }

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    startedAt = null;
    lastElapsedMs = null;
    stopTicker();

    if (ctx.mode !== "tui") return;

    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      const requestRender = () => tui.requestRender();
      requestWidgetRender = requestRender;

      return {
        invalidate() {},
        render(width: number): string[] {
          if (startedAt === null && lastElapsedMs === null) return [];

          const label = startedAt !== null
            ? `Agent turn · ${formatElapsed(Date.now() - startedAt)}`
            : `Last turn · ${formatElapsed(lastElapsedMs!)}`;
          const visibleLabel = truncateToWidth(label, width);
          const leftPadding = " ".repeat(Math.max(0, width - visibleWidth(visibleLabel)));
          return [leftPadding + theme.fg("dim", visibleLabel)];
        },
      };
    }, { placement: "aboveEditor" });
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "user" || activeContext?.mode !== "tui") return;

    startedAt = event.message.timestamp;
    lastElapsedMs = null;
    startTicker();
    requestWidgetRender?.();
  });

  pi.on("agent_settled", () => {
    if (startedAt === null) return;

    lastElapsedMs = Math.max(0, Date.now() - startedAt);
    startedAt = null;
    stopTicker();
    requestWidgetRender?.();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopTicker();
    requestWidgetRender = null;
    startedAt = null;
    lastElapsedMs = null;
    activeContext = null;
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}
