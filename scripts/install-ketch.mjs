import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPOSITORY = "https://github.com/1broseidon/ketch";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DESTINATION = join(packageRoot, "node_modules", "ketch");

function readOptions(args) {
  const options = {
    repository: DEFAULT_REPOSITORY,
    destination: DEFAULT_DESTINATION,
  };

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option !== "--repository" && option !== "--destination") {
      throw new Error(`Unknown option: ${option}`);
    }

    const value = args[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${option}`);
    }

    options[option.slice(2)] = value;
    index += 1;
  }

  options.destination = resolve(options.destination);
  return options;
}

function runGit(args, cwd) {
  execFileSync("git", args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

const { repository, destination } = readOptions(process.argv.slice(2));
const gitDirectory = join(destination, ".git");

if (existsSync(gitDirectory)) {
  console.log(`Updating Ketch in ${destination}`);
  runGit(["pull", "--ff-only"], destination);
} else {
  if (existsSync(destination)) {
    throw new Error(`Ketch destination exists but is not a Git checkout: ${destination}`);
  }

  mkdirSync(dirname(destination), { recursive: true });
  console.log(`Cloning Ketch into ${destination}`);
  runGit(["clone", "--depth", "1", repository, destination], packageRoot);
}
