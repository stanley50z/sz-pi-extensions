import {
  copyToClipboard,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type ClipboardWriter = (text: string) => Promise<unknown>;

function renderContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object" || !("type" in block)) return [];
      if (block.type === "text" && "text" in block && typeof block.text === "string") {
        return [block.text];
      }
      return block.type === "image" ? ["[image]"] : [];
    })
    .join("\n")
    .trim();
}

export function createCopySessionExtension({ copy }: { copy: ClipboardWriter }) {
  return (pi: ExtensionAPI) => {
    pi.registerCommand("copy-all", {
      description: "Copy this branch's user and assistant history to the clipboard",
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();

        const sections = ctx.sessionManager
          .getBranch()
          .flatMap((entry) => {
            if (entry.type !== "message") return [];
            const { message } = entry;
            if (message.role !== "user" && message.role !== "assistant") return [];
            const content = renderContent(message.content);
            return content ? [`${message.role.toUpperCase()}:\n${content}`] : [];
          });

        if (sections.length === 0) {
          ctx.ui.notify("No user or assistant messages to copy", "info");
          return;
        }

        const transcript = sections.join("\n\n---\n\n");
        try {
          await copy(transcript);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not copy session history: ${detail}`, "error");
          return;
        }
        ctx.ui.notify(
          `Copied ${sections.length} messages (${transcript.length} characters)`,
          "info",
        );
      },
    });
  };
}

export default createCopySessionExtension({ copy: copyToClipboard });
