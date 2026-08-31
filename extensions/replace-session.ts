import { unlink } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function deleteSessionFile(sessionFile: string): Promise<void> {
  try {
    await unlink(sessionFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("rn", {
    description: "Start a new session and delete the session it replaces",
    handler: async (_args, ctx) => {
      const previousSessionFile = ctx.sessionManager.getSessionFile();

      await ctx.newSession({
        withSession: async () => {
          if (previousSessionFile) await deleteSessionFile(previousSessionFile);
        },
      });
    },
  });
}
