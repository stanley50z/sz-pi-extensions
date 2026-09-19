import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPOSITORY = "https://github.com/1broseidon/ketch";
const GO_PACKAGE = "github.com/1broseidon/ketch@latest";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DESTINATION = join(packageRoot, "node_modules", "ketch");

function readOptions(args) {
  const options = {
    repository: DEFAULT_REPOSITORY,
    destination: DEFAULT_DESTINATION,
    goPackage: GO_PACKAGE,
    skipCli: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--skip-cli") {
      options.skipCli = true;
      continue;
    }
    if (option !== "--repository" && option !== "--destination" && option !== "--go-package") {
      throw new Error(`Unknown option: ${option}`);
    }

    const value = args[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${option.slice(2)}`);
    }
    options[option.slice(2)] = value;
    index += 1;
  }

  options.destination = resolve(options.destination);
  return options;
}

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function findOnPath(executable) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, executable + suffix);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Step 1: clone (or update) the ketch repo so pi can load its skill.
// Must never throw: a postinstall failure would abort the whole npm install.
function installSkillRepo({ repository, destination }) {
  const gitDirectory = join(destination, ".git");

  try {
    if (existsSync(gitDirectory)) {
      console.log(`Updating Ketch in ${destination}`);
      run("git", ["pull", "--ff-only"], destination);
    } else {
      if (existsSync(destination)) {
        throw new Error(`Ketch destination exists but is not a Git checkout: ${destination}`);
      }
      mkdirSync(dirname(destination), { recursive: true });
      console.log(`Cloning Ketch into ${destination}`);
      run("git", ["clone", "--depth", "1", repository, destination], packageRoot);
    }
  } catch (error) {
    console.warn(
      `[install-ketch] Failed to clone/update the Ketch skill repo: ${error.message}\n` +
        `[install-ketch] Run "node scripts/install-ketch.mjs" manually, then restart pi.`,
    );
  }
}

// Step 2: make sure the ketch CLI binary is on PATH via `go install`.
// Best effort only — prints instructions when Go is unavailable.
function goBinDirectory() {
  try {
    const gopath = execFileSync("go", ["env", "GOPATH"], { encoding: "utf8" }).trim();
    return gopath ? join(gopath, "bin") : null;
  } catch {
    return null;
  }
}

function installCli({ goPackage }) {
  if (findOnPath("ketch")) {
    console.log("[install-ketch] ketch CLI already on PATH, skipping go install");
    return;
  }

  if (!findOnPath("go")) {
    console.warn(
      "[install-ketch] ketch CLI not found and Go is not installed.\n" +
        "[install-ketch] Install it later with one of:\n" +
        `  go install ${goPackage}\n` +
        "  brew install 1broseidon/tap/ketch\n" +
        "  curl -fsSL https://raw.githubusercontent.com/1broseidon/ketch/main/install.sh | sh",
    );
    return;
  }

  try {
    console.log(`Installing ketch CLI (${goPackage})`);
    run("go", ["install", goPackage], packageRoot);
  } catch (error) {
    console.warn(
      `[install-ketch] go install failed: ${error.message}\n` +
        `[install-ketch] Retry manually with: go install ${goPackage}`,
    );
    return;
  }

  if (findOnPath("ketch")) {
    console.log("[install-ketch] ketch CLI installed");
    return;
  }

  const bin = goBinDirectory();
  console.warn(
    `[install-ketch] ketch was installed but ${bin ?? "the Go bin directory"} is not on PATH.\n` +
      "[install-ketch] Add it to PATH, then restart your shell and pi.",
  );
}

const options = readOptions(process.argv.slice(2));
installSkillRepo(options);
if (!options.skipCli) {
  installCli(options);
}
