#!/usr/bin/env python3
"""Install the local Pi stack, or inspect it without changing installations."""
import argparse
from datetime import datetime, timezone
import json
import os
import re
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import traceback

ROOT = Path(__file__).resolve().parent
TOOLS = ("git", "node", "npm", "pi", "fd", "rg", "ketch", "claude", "codex", "firecrawl")


# WinGet can change the registry PATH without updating the running Python process.
def refresh_windows_path():
    if os.name != "nt":
        return
    import winreg
    paths = [os.environ.get("PATH", "")]
    for hive, key in ((winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
                      (winreg.HKEY_CURRENT_USER, r"Environment")):
        try:
            with winreg.OpenKey(hive, key) as handle:
                paths.append(os.path.expandvars(winreg.QueryValueEx(handle, "Path")[0]))
        except FileNotFoundError:
            pass  # A user PATH is optional; preserve the existing process and system paths.
    os.environ["PATH"] = os.pathsep.join(dict.fromkeys(entry for path in paths for entry in path.split(os.pathsep) if entry))


# One invocation owns its diagnostics and all subprocesses, including timeout cleanup.
class Setup:
    def __init__(self, timeout):
        self.timeout = timeout
        self.agent = Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi" / "agent").expanduser().resolve()
        os.environ["PI_CODING_AGENT_DIR"] = str(self.agent)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        self.logs = self.agent / "logs" / "setup" / f"{stamp}-{os.getpid()}"
        self.logs.mkdir(parents=True, mode=0o700)
        self.checks = []
        print(f"Logs: {self.logs}", flush=True)

    def log(self, text):
        with (self.logs / "setup.log").open("a", encoding="utf-8") as stream:
            stream.write(text + "\n")

    def run(self, args, *, timeout=None, env=None):
        self.log("$ " + json.dumps([str(arg) for arg in args]))
        executable = shutil.which(str(args[0]))
        if not executable:
            raise RuntimeError(f"Missing executable: {args[0]}")
        environment = {**os.environ, "GIT_TERMINAL_PROMPT": "0", **(env or {})}
        if args[0] == "brew":
            environment["HOMEBREW_NO_INSTALL_CLEANUP"] = "1"
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
        process = subprocess.Popen(
            [executable, *map(str, args[1:])], cwd=ROOT,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", env=environment, **options,
        )
        try:
            output, _ = process.communicate(timeout=timeout or self.timeout)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass  # The process group exited between the timeout and the signal.
            output, _ = process.communicate(timeout=10)
            self.log(output)
            raise
        self.log(output)
        return subprocess.CompletedProcess(args, process.returncode, output)

    def install_command(self, args, *, env=None):
        print("Running: " + " ".join(map(str, args)), flush=True)
        result = self.run(args, env=env)
        if result.returncode:
            raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(map(str, args))}. See setup.log.")
        return result.stdout.strip()

    def install(self, skip_pull):
        if platform.system() == "Darwin":
            if not shutil.which("brew"):
                raise RuntimeError("Homebrew is required. Install it from https://brew.sh, then rerun setup.")
            for name, package in (("git", "git"), ("node", "node"), ("npm", "node")):
                if not shutil.which(name):
                    self.install_command(["brew", "install", package])
        elif platform.system() == "Windows":
            packages = {"git": "Git.Git", "node": "OpenJS.NodeJS.LTS", "npm": "OpenJS.NodeJS.LTS",
                        "fd": "sharkdp.fd", "rg": "BurntSushi.ripgrep.MSVC", "go": "GoLang.Go"}
            for name, package in packages.items():
                if not shutil.which(name):
                    self.install_command(["winget", "install", "--id", package, "--exact", "--silent",
                                          "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"])
                    refresh_windows_path()
        elif platform.system() == "Linux":
            packages = {"git": "git", "node": "nodejs", "npm": "npm", "fd": "fd-find", "rg": "ripgrep", "go": "golang-go"}
            missing = [package for name, package in packages.items()
                       if not shutil.which(name) and not (name == "fd" and shutil.which("fdfind"))]
            if missing:
                if not shutil.which("apt-get"):
                    raise RuntimeError("Automatic Linux provisioning requires apt-get. Install Git, Node >=22, npm, fd, ripgrep and Go, then rerun.")
                prefix = [] if os.geteuid() == 0 else ["sudo", "-n"]
                self.install_command([*prefix, "apt-get", "update"])
                self.install_command([*prefix, "apt-get", "install", "--yes", *missing])
        else:
            raise RuntimeError(f"Unsupported platform: {platform.system()}")
        for name in ("git", "node", "npm"):
            if not shutil.which(name):
                raise RuntimeError(f"Install {name} and rerun setup.")
        if not skip_pull:
            dirty = self.run(["git", "status", "--porcelain"])
            if dirty.returncode or dirty.stdout.strip():
                raise RuntimeError("Checkout is not clean. Commit/stash your work, or use --skip-pull to install this checkout unchanged.")
            self.install_command(["git", "pull", "--ff-only"])
        node = self.install_command(["node", "--version"])
        if int(node.lstrip("v").split(".")[0]) < 22:
            raise RuntimeError("Node.js 22 or newer is required. Upgrade Node and rerun setup.")
        packages = ["@earendil-works/pi-coding-agent@latest", "firecrawl-cli@latest"]
        codex = shutil.which("codex")
        if codex and "Caskroom" in Path(codex).resolve().parts:
            self.install_command(["brew", "upgrade", "--cask", "codex"])
        else:
            packages.append("@openai/codex@latest")
        if shutil.which("claude"):
            self.install_command(["claude", "update"])
        else:
            packages.append("@anthropic-ai/claude-code@latest")
        self.install_command(["npm", "install", "--global", *packages])
        refresh_windows_path()
        if platform.system() == "Darwin":
            for package in ("fd", "ripgrep", "ketch"):
                installed = self.run(["brew", "list", "--versions", package]).returncode == 0
                self.install_command(["brew", "upgrade" if installed else "install", package])
        else:
            pi = shutil.which("pi")
            if not pi:
                raise RuntimeError("Pi is not on PATH after npm installation. Add the global npm bin directory to PATH and rerun.")
            if platform.system() == "Linux" and not shutil.which("fd") and shutil.which("fdfind"):
                (Path(pi).parent / "fd").symlink_to(shutil.which("fdfind"))
            destination = Path(shutil.which("ketch") or pi).parent
            self.install_command(["go", "install", "github.com/1broseidon/ketch@latest"],
                                 env={**os.environ, "GOBIN": str(destination)})
        self.install_command(["npm", "ci"])
        self.install_command(["pi", "install", str(ROOT)])

    def record(self, name, ok, detail):
        self.checks.append({"name": name, "ok": ok, "detail": detail})
        message = f"{'OK' if ok else 'ATTENTION'} {name}: {detail}"
        self.log(message)
        print(message, flush=True)

    def probe(self, name, args, action, accept=None):
        try:
            result = self.run(args, timeout=min(self.timeout, 30))
            output = re.sub(r"\x1b\[[0-9;]*m", "", result.stdout).strip()
            ok = result.returncode == 0 and (accept(output) if accept else True)
            self.record(name, ok, (output.splitlines()[0][:160] if output else "verified") if ok else action)
            return ok
        except Exception as error:
            with (self.logs / "crash-report.txt").open("a", encoding="utf-8") as stream:
                stream.write(traceback.format_exc() + "\n")
            self.record(name, False, f"{action} ({type(error).__name__}; see crash-report.txt)")
            return False

    def verify(self):
        available = set()
        for name in TOOLS:
            if not shutil.which(name):
                self.record(name, False, f"MISSING {name}")
                continue
            action = f"Repair {name}; see setup.log. Check for OS approval prompts if it hangs."
            accept = None
            if name == "node":
                action = "Install Node.js 22 or newer."
                accept = lambda output: int(output.lstrip("v").split(".")[0]) >= 22
            if self.probe(name, [name, "--version"], action, accept):
                available.add(name)
        if "npm" in available:
            self.probe("npm dependencies", ["npm", "ls", "--depth=0"], "Run setup again to repair package dependencies.")
        skill = ROOT / "node_modules" / "ketch" / "skills" / "ketch" / "SKILL.md"
        self.record("Ketch skill", skill.is_file(), str(skill) if skill.is_file() else "Run node scripts/install-ketch.mjs --skip-cli.")
        prompt = self.agent / "APPEND_SYSTEM.md"
        source = ROOT / "config" / "APPEND_SYSTEM.md"
        expected = f"<!-- sz-pi-extensions:begin -->\n{source.read_text(encoding='utf-8').strip()}\n<!-- sz-pi-extensions:end -->" if source.is_file() else None
        synced = expected is not None and prompt.is_file() and expected in prompt.read_text(encoding="utf-8")
        self.record("Pi prompt", synced, "synced" if synced else "Run node scripts/install-append-system.mjs.")
        if "pi" in available:
            self.probe("Pi registration", ["pi", "list"], "Run setup again to register this checkout.",
                       lambda output: str(ROOT) in [line.strip() for line in output.splitlines()])
            self.probe("Pi models", ["pi", "--offline", "--no-extensions", "-e", str(ROOT), "--list-models"],
                       "Claude bridge models are missing; see setup.log.", lambda output: "claude-bridge" in output)
            # Model listing can exit successfully despite extension load errors. Empty print mode
            # validates startup too, without sending a model prompt or saving a session.
            self.probe("Pi startup", ["pi", "--offline", "--no-extensions", "-e", str(ROOT), "--no-session", "--print"],
                       "Pi startup failed; see setup.log.",
                       lambda output: "Failed to load extension" not in output and "Extension error (" not in output)
        if "claude" in available:
            self.probe("Claude authentication", ["claude", "auth", "status"], "Run claude auth login.",
                       lambda output: json.loads(output).get("loggedIn") is True)
        if "codex" in available:
            self.probe("Codex authentication", ["codex", "login", "status"], "Run codex login.",
                       lambda output: "Logged in" in output)
        if "firecrawl" in available:
            self.probe("Firecrawl authentication", ["firecrawl", "--status"], "Run firecrawl login.",
                       lambda output: "Authenticated" in output and "Not authenticated" not in output)
        if "ketch" in available:
            self.probe("Ketch providers", ["ketch", "doctor", "--json"], "Run ketch doctor --json and fix the reported configuration problems.")

    def finish(self, status):
        report = {"status": status, "checkout": str(ROOT), "checks": self.checks}
        (self.logs / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"Result: {status}. Logs: {self.logs}", flush=True)


# The CLI returns 0 for ready, 2 for required user actions, and 1 for setup failures.
def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="check only; write diagnostics but do not install anything")
    parser.add_argument("--skip-pull", action="store_true", help="install the current checkout without updating Git")
    parser.add_argument("--timeout", type=float, default=600, help="per-command timeout in seconds; checks use at most 30 seconds")
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    setup = Setup(args.timeout)
    try:
        if not args.check:
            setup.install(args.skip_pull)
        setup.verify()
        ready = all(check["ok"] for check in setup.checks)
        setup.finish("ready" if ready else "needs-attention")
        if not args.check:
            print("Restart Pi after completing any reported actions.")
        return 0 if ready else 2
    except (Exception, KeyboardInterrupt) as error:
        (setup.logs / "crash-report.txt").write_text(traceback.format_exc(), encoding="utf-8")
        setup.log(str(error))
        print(f"ERROR: {error}", file=sys.stderr)
        setup.finish("failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
