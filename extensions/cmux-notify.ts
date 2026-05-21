/**
 * cmux-notify — fires a Cmux desktop notification when Pi finishes a turn
 * and is ready for input.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";

function cmuxNotify(title: string, body: string): void {
  execFile("cmux", ["notify", "--title", title, "--body", body], (err) => {
    if (err) {
      // Silently ignore — Cmux may not be running or the socket may be unavailable
    }
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async () => {
    cmuxNotify("Pi", "Ready for input");
  });
}
