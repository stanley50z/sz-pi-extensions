import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("exit", {
    description: "Quit pi (same as /quit)",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });
}
