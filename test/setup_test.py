"""Test the setup CLI with isolated executables at the external-command boundary."""
import json
import os
from pathlib import Path
import subprocess
import sys
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


# Every invocation uses an isolated PATH and agent directory, never the user's tools.
class SetupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sz-stack-setup-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.checkout = self.home / "checkout with spaces"
        self.checkout.mkdir()
        shutil.copyfile(ROOT / "setup.py", self.checkout / "setup.py")
        self.env = {
            **os.environ,
            "PATH": str(self.bin),
            "PI_CODING_AGENT_DIR": str(self.home / "agent"),
            "SETUP_TEST_HOME": str(self.home),
        }

    def run_setup(self, *args, platform=None):
        entry = str(self.checkout / "setup.py")
        command = [sys.executable, "-B", entry, *args]
        if platform or os.name == "nt":
            prelude = "import runpy, sys, platform; "
            if platform:
                prelude += f"platform.system=lambda: {platform!r}; "
            if os.name == "nt":
                # Model registry PATH reads too, so a Windows fixture cannot discover real tools.
                prelude += "import types, contextlib; sys.modules['winreg']=types.SimpleNamespace(HKEY_LOCAL_MACHINE=1, HKEY_CURRENT_USER=2, OpenKey=lambda *a: contextlib.nullcontext(None), QueryValueEx=lambda *a: ('', 1)); "
            command = [sys.executable, "-B", "-c", prelude + f"sys.argv=[{entry!r}, *sys.argv[1:]]; runpy.run_path({entry!r}, run_name='__main__')", *args]
        return subprocess.run(
            command,
            env=self.env, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, timeout=30,
        )

    # Fake binaries model package-manager side effects without mocking setup internals.
    def tools(self):
        handler = self.bin / "tool.py"
        handler.write_text('''import json, os, pathlib, shutil, sys, time
home = pathlib.Path(os.environ["SETUP_TEST_HOME"])
name, *args = sys.argv[1:]
with (home / "commands.jsonl").open("a") as log:
    log.write(json.dumps([name, *args]) + "\\n")
if name == "codex" and os.environ.get("SETUP_TEST_HANG"):
    import subprocess
    subprocess.Popen([sys.executable, "-c", "import pathlib, time; time.sleep(3); pathlib.Path(" + repr(str(home / "orphan-marker")) + ").touch()"])
    print("simulated hung CLI", flush=True)
    time.sleep(10)
elif name == "npm" and args[:2] == ["install", "--global"]:
    for package in args[2:]:
        tool = {"@earendil-works/pi-coding-agent@latest": "pi", "@openai/codex@latest": "codex", "@anthropic-ai/claude-code@latest": "claude", "firecrawl-cli@latest": "firecrawl"}[package]
        template = home / "templates" / (tool + (".cmd" if os.name == "nt" else ""))
        shutil.copy2(template, home / "bin" / template.name)
elif name == "sudo":
    os.execv(shutil.which(args[1]), args[1:])
elif name == "apt-get" and "install" in args:
    for package in args[args.index("install") + 2:]:
        tool = {"nodejs": "node", "ripgrep": "rg", "fd-find": "fdfind", "golang-go": "go"}.get(package, package)
        shutil.copy2(home / "templates" / tool, home / "bin" / tool)
elif name == "winget":
    package = args[args.index("--id") + 1]
    tools = {"Git.Git": ["git"], "OpenJS.NodeJS.LTS": ["node", "npm"], "sharkdp.fd": ["fd"], "BurntSushi.ripgrep.MSVC": ["rg"], "GoLang.Go": ["go"]}[package]
    for tool in tools:
        template = home / "templates" / (tool + (".cmd" if os.name == "nt" else ""))
        shutil.copy2(template, home / "bin" / template.name)
elif name == "go" and args[0] == "install":
    template = home / "templates" / ("ketch.cmd" if os.name == "nt" else "ketch")
    shutil.copy2(template, pathlib.Path(os.environ["GOBIN"]) / template.name)
elif name == "brew" and args[0] in ("install", "upgrade"):
    for package in args[1:]:
        tools = {"node": ["node", "npm"], "ripgrep": ["rg"]}.get(package, [package])
        for tool in tools:
            for template in (home / "templates").glob(tool + ".*"):
                shutil.copy2(template, home / "bin" / template.name)
            if (home / "templates" / tool).exists():
                shutil.copy2(home / "templates" / tool, home / "bin" / tool)
elif name == "node":
    print("v24.18.0")
elif name == "git" and args == ["status", "--porcelain"]:
    print(os.environ.get("SETUP_TEST_DIRTY", ""), end="")
elif name == "npm" and args == ["ci"]:
    if os.environ.get("SETUP_TEST_NPM_FAIL"):
        print("simulated registry failure")
        sys.exit(1)
    target = pathlib.Path.cwd() / "node_modules/ketch/skills/ketch/SKILL.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("Ketch skill")
    agent = pathlib.Path(os.environ["PI_CODING_AGENT_DIR"])
    (agent / "APPEND_SYSTEM.md").write_text("<!-- sz-pi-extensions:begin -->\\npreferences\\n<!-- sz-pi-extensions:end -->\\n")
elif name == "pi" and args[:1] == ["install"]:
    (home / "registered").write_text(args[1])
elif name == "pi" and "--print" in args:
    if os.environ.get("SETUP_TEST_EXTENSION_FAIL"):
        print("Failed to load extension: fixture failure")
        sys.exit(1)
elif name == "pi" and "--list-models" in args:
    print("claude-bridge claude-fable-5-1")
elif name == "pi" and args == ["list"]:
    print((home / "registered").read_text() if (home / "registered").exists() else "User packages:")
elif name == "claude" and args == ["auth", "status"]:
    print(json.dumps({"loggedIn": not bool(os.environ.get("SETUP_TEST_SIGNED_OUT"))}))
elif name == "codex" and args == ["login", "status"]:
    print("Logged in using ChatGPT")
elif name == "firecrawl" and args == ["--status"]:
    print("Not authenticated" if os.environ.get("SETUP_TEST_SIGNED_OUT") else "Authenticated via stored credentials")
elif name == "ketch" and args == ["doctor", "--json"]:
    print("[]")
else:
    print(name + " 1.0.4")
''', encoding="utf-8")
        for name in ("git", "node", "npm", "pi", "fd", "rg", "ketch", "claude", "codex", "firecrawl", "brew", "go", "winget", "apt-get", "sudo", "fdfind"):
            if os.name == "nt":
                (self.bin / f"{name}.cmd").write_text(f'@"{sys.executable}" "{handler}" {name} %*\n', encoding="utf-8")
            else:
                executable = self.bin / name
                executable.write_text(f"#!{sys.executable}\nimport runpy, sys\nsys.argv = [{str(handler)!r}, {name!r}, *sys.argv[1:]]\nrunpy.run_path({str(handler)!r}, run_name='__main__')\n", encoding="utf-8")
                executable.chmod(0o755)
        shutil.copytree(self.bin, self.home / "templates")
        (self.checkout / "package-lock.json").write_text("{}", encoding="utf-8")
        (self.checkout / "config").mkdir()
        (self.checkout / "config/APPEND_SYSTEM.md").write_text("preferences\n", encoding="utf-8")

    def commands(self):
        return [json.loads(line) for line in (self.home / "commands.jsonl").read_text().splitlines()]

    def report(self):
        paths = list((self.home / "agent" / "logs" / "setup").glob("*/report.json"))
        self.assertEqual(len(paths), 1)
        return json.loads(paths[0].read_text(encoding="utf-8"))

    def test_check_reports_all_missing_dependencies_without_installing(self):
        result = self.run_setup("--check")
        self.assertEqual(result.returncode, 2, result.stdout)
        report = self.report()
        self.assertEqual(report["status"], "needs-attention")
        for name in ("git", "node", "npm", "pi", "fd", "rg", "ketch", "claude", "codex", "firecrawl"):
            self.assertIn(f"MISSING {name}", result.stdout)
        self.assertFalse((ROOT / "setup.log").exists())

    def test_install_registers_and_verifies_the_locked_stack(self):
        self.tools()
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.report()["status"], "ready")
        commands = self.commands()
        self.assertIn(["git", "pull", "--ff-only"], commands)
        self.assertIn(["npm", "ci"], commands)
        self.assertIn(["pi", "install", str(self.checkout)], commands)
        for tool in ("claude", "codex", "firecrawl", "ketch"):
            self.assertTrue(any(check["name"] == tool and check["ok"] for check in self.report()["checks"]))
        self.assertTrue((self.checkout / "node_modules/ketch/skills/ketch/SKILL.md").exists())
        self.assertEqual((self.checkout / "package-lock.json").read_text(), "{}")

    @unittest.skipUnless(sys.platform == "darwin", "Homebrew platform integration")
    def test_installs_missing_system_tools_before_installing_stack(self):
        self.tools()
        for name in ("git", "node", "npm", "fd", "rg", "ketch"):
            (self.bin / name).unlink()
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stdout)
        commands = self.commands()
        self.assertIn(["brew", "install", "git"], commands)
        self.assertIn(["brew", "install", "node"], commands)
        self.assertIn(["npm", "ci"], commands)
        for name in ("git", "node", "npm", "fd", "rg", "ketch"):
            self.assertTrue((self.bin / name).exists())

    def test_check_verifies_auth_and_registration_without_mutating_installations(self):
        self.tools()
        self.env["SETUP_TEST_SIGNED_OUT"] = "1"
        result = self.run_setup("--check")
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("claude auth login", result.stdout)
        self.assertIn("firecrawl login", result.stdout)
        checks = {check["name"]: check for check in self.report()["checks"]}
        self.assertFalse(checks["Pi registration"]["ok"])
        self.assertFalse(checks["Ketch skill"]["ok"])
        for command in self.commands():
            self.assertNotIn("install", command)
            self.assertNotIn("upgrade", command)
            self.assertNotIn("update", command)
            self.assertNotIn("ci", command)

    def test_windows_provisions_missing_tools_with_winget_and_ketch_with_go(self):
        self.tools()
        for name in ("git", "node", "npm", "fd", "rg", "go", "ketch"):
            (self.bin / (name + (".cmd" if os.name == "nt" else ""))).unlink()
        result = self.run_setup(platform="Windows")
        self.assertEqual(result.returncode, 0, result.stdout)
        commands = self.commands()
        installed = {command[command.index("--id") + 1] for command in commands if command[0] == "winget"}
        self.assertEqual(installed, {"Git.Git", "OpenJS.NodeJS.LTS", "sharkdp.fd", "BurntSushi.ripgrep.MSVC", "GoLang.Go"})
        self.assertIn(["go", "install", "github.com/1broseidon/ketch@latest"], commands)

    @unittest.skipIf(os.name == "nt", "Linux package-manager boundary")
    def test_linux_provisions_missing_tools_and_makes_fdfind_available_as_fd(self):
        self.tools()
        for name in ("git", "node", "npm", "fd", "fdfind", "rg", "go", "ketch"):
            (self.bin / name).unlink()
        result = self.run_setup(platform="Linux")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn(["apt-get", "install", "--yes", "git", "nodejs", "npm", "fd-find", "ripgrep", "golang-go"], self.commands())
        self.assertTrue((self.bin / "fd").exists())
        self.assertTrue((self.bin / "ketch").exists())

    def test_fresh_install_includes_all_native_clis(self):
        self.tools()
        for name in ("pi", "claude", "codex", "firecrawl"):
            (self.bin / (name + (".cmd" if os.name == "nt" else ""))).unlink()
        result = self.run_setup("--skip-pull")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn(["npm", "install", "--global", "@earendil-works/pi-coding-agent@latest", "firecrawl-cli@latest", "@openai/codex@latest", "@anthropic-ai/claude-code@latest"], self.commands())
        self.assertNotIn(["git", "pull", "--ff-only"], self.commands())

    def test_dirty_checkout_is_not_pulled_or_reset(self):
        self.tools()
        self.env["SETUP_TEST_DIRTY"] = " M README.md\\n"
        result = self.run_setup()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("--skip-pull", result.stdout)
        self.assertNotIn(["git", "pull", "--ff-only"], self.commands())
        self.assertNotIn(["npm", "ci"], self.commands())

    def test_install_failure_preserves_output_and_traceback_without_registering(self):
        self.tools()
        self.env["SETUP_TEST_NPM_FAIL"] = "1"
        result = self.run_setup("--skip-pull")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertEqual(self.report()["status"], "failed")
        logs = next((self.home / "agent/logs/setup").iterdir())
        self.assertIn("simulated registry failure", (logs / "setup.log").read_text())
        self.assertIn("Traceback", (logs / "crash-report.txt").read_text())
        self.assertFalse((self.home / "registered").exists())

    @unittest.skipIf(os.name == "nt", "POSIX process-group timeout cleanup")
    def test_hung_cli_is_reported_and_its_children_are_stopped(self):
        self.tools()
        self.env["SETUP_TEST_HANG"] = "1"
        result = self.run_setup("--check", "--timeout", "1")
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("TimeoutExpired", result.stdout)
        logs = next((self.home / "agent/logs/setup").iterdir())
        self.assertIn("simulated hung CLI", (logs / "setup.log").read_text())
        self.assertIn("TimeoutExpired", (logs / "crash-report.txt").read_text())
        import time
        time.sleep(3)
        self.assertFalse((self.home / "orphan-marker").exists())

    def test_startup_errors_are_detected_even_when_model_listing_succeeds(self):
        self.tools()
        self.env["SETUP_TEST_EXTENSION_FAIL"] = "1"
        result = self.run_setup("--skip-pull")
        self.assertEqual(result.returncode, 2, result.stdout)
        checks = {check["name"]: check for check in self.report()["checks"]}
        self.assertTrue(checks["Pi models"]["ok"])
        self.assertFalse(checks["Pi startup"]["ok"])


if __name__ == "__main__":
    unittest.main()
