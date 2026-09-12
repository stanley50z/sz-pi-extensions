import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// npm postinstall syncs this package's prompt section while preserving user instructions.
const configuredDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const agentDir = resolve(configuredDir.replace(/^~(?=$|[\\/])/, () => homedir()));
const destination = join(agentDir, "APPEND_SYSTEM.md");
const prompt = readFileSync(new URL("../config/APPEND_SYSTEM.md", import.meta.url), "utf8").trim();
const begin = "<!-- sz-pi-extensions:begin -->";
const end = "<!-- sz-pi-extensions:end -->";
const block = `${begin}\n${prompt}\n${end}`;
const current = existsSync(destination) ? readFileSync(destination, "utf8") : "";
const start = current.indexOf(begin);
const finish = current.indexOf(end);
if ((start === -1) !== (finish === -1)
  || finish < start
  || current.lastIndexOf(begin) !== start
  || current.lastIndexOf(end) !== finish) {
  throw new Error(`Invalid sz-pi-extensions markers in ${destination}; file left unchanged.`);
}
const updated = start === -1
  ? `${current}${current && !current.endsWith("\n\n") ? "\n\n" : ""}${block}\n`
  : current.slice(0, start) + block + current.slice(finish + end.length);

if (updated !== current) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(destination, updated, "utf8");
}
console.log(`Installed Pi prompt preferences in ${destination}`);
