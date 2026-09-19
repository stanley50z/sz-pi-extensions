import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REPLACED_OPTIONS = new Set([
  "--session", "--session-id", "--fork", "--name", "-n", "--provider", "--model", "--thinking", "--mode",
]);
const VALUE_OPTIONS = new Set([
  "--api-key", "--system-prompt", "--append-system-prompt", "--session-dir", "--models",
  "--tools", "-t", "--exclude-tools", "-xt", "--extension", "-e", "--skill",
  "--prompt-template", "--theme", "--use-theme", "--tui-mode",
]);
const PATH_OPTIONS = new Set(["--session-dir", "--extension", "-e", "--skill", "--prompt-template", "--theme"]);
const BOOLEAN_OPTIONS = new Set([
  "--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--no-extensions", "-ne",
  "--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-themes", "--no-context-files", "-nc",
  "--verbose", "--approve", "-a", "--no-approve", "-na", "--offline",
]);

// Preserve CLI configuration, not one-shot prompts or session selection actions.
function launchOptions(): string[] {
  const args: string[] = [];
  const original = process.argv.slice(2);
  for (let i = 0; i < original.length; i++) {
    const arg = original[i];
    if (arg === "--") break;
    if (REPLACED_OPTIONS.has(arg)) { i++; continue; }
    if (["--continue", "-c", "--resume", "-r", "--no-session"].includes(arg)) continue;
    if (BOOLEAN_OPTIONS.has(arg)) {
      args.push(arg);
    } else if (VALUE_OPTIONS.has(arg)) {
      let value = original[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      if (PATH_OPTIONS.has(arg)) {
        value = value.replace(/^~(?=[/\\]|$)/, homedir());
        value = resolve(value);
      }
      args.push(arg, value);
    } else if (arg.startsWith("--")) {
      // Extension flags use Pi's unknown-flag parsing rules.
      args.push(arg);
      const next = original[i + 1];
      if (!arg.includes("=") && next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
        args.push(next);
        i++;
      }
    }
  }
  return args;
}

// Relaunch only after Pi has restored the terminal and finished extension cleanup.
export default function (pi: ExtensionAPI): void {
  let restart: { args: string[]; cwd: string } | undefined;

  pi.registerCommand("reopen", {
    description: "Restart Pi in this terminal and resume the current conversation",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/reopen is only available in an interactive Pi terminal.", "error");
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait for Pi to finish or cancel the current turn before /reopen.", "error");
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile || !existsSync(sessionFile)) {
        ctx.ui.notify("This session is not saved yet. /reopen cannot safely resume it.", "error");
        return;
      }
      if (restart) return;
      const args = [process.argv[1], ...launchOptions(), "--session", sessionFile];
      if (ctx.model) args.push("--provider", ctx.model.provider, "--model", ctx.model.id);
      if (ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
      restart = { args, cwd: ctx.cwd };
      ctx.shutdown();
    },
  });

  pi.on("session_shutdown", (event) => {
    const launch = restart;
    restart = undefined;
    if (event.reason !== "quit" || !launch) return;

    process.once("exit", (code) => {
      if (code !== 0) return;
      // Waiting synchronously keeps the invoking shell from taking back stdin.
      // The old runtime is already disposed and runs no timers while waiting.
      const result = spawnSync(process.execPath, launch.args, {
        cwd: launch.cwd,
        stdio: "inherit",
      });
      if (result.error) {
        console.error(`Could not reopen Pi: ${result.error.message}`);
        process.exitCode = 1;
      } else {
        process.exitCode = result.status ?? 1;
      }
    });
  });
}
