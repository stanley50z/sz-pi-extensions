import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KEYBINDINGS_FILENAME = "keybindings.json";
const DELETE_WORD_BACKWARD = "tui.editor.deleteWordBackward";
const CTRL_BACKSPACE_BINDINGS = ["ctrl+backspace", "ctrl+w", "alt+backspace"];

type KeybindingsConfig = Record<string, string | string[]>;

function readConfig(path: string): KeybindingsConfig {
  if (!existsSync(path)) return {};

  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected ${path} to contain a JSON object`);
  }
  return parsed as KeybindingsConfig;
}

function writeConfig(path: string, config: KeybindingsConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export default function (_pi: ExtensionAPI): void {
  const configPath = join(getAgentDir(), KEYBINDINGS_FILENAME);
  const config = readConfig(configPath);
  const current = config[DELETE_WORD_BACKWARD];
  const currentBindings = current === undefined ? [] : Array.isArray(current) ? current : [current];

  if (currentBindings.includes("ctrl+backspace")) return;

  config[DELETE_WORD_BACKWARD] = current === undefined
    ? [...CTRL_BACKSPACE_BINDINGS]
    : ["ctrl+backspace", ...currentBindings];
  writeConfig(configPath, config);
}
