# sz-pi-extensions

A personal Pi package with custom extensions and skills for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

This package includes UI and automation helpers. Live-source research is delegated to [Ketch](https://github.com/1broseidon/ketch) instead of being implemented as a separate Pi extension.

## Features

- **Web research** through Ketch, including Brave and Exa search backends
- **Code and documentation search** through Ketch
- **Web page, PDF, and site extraction** through Ketch
- **Credit-aware Firecrawl specialist** for managed extraction, crawling, monitoring, and parsing
- **Structured user questions** through the `ask_user` tool
- **Session transcript copying** through `/copy-all`
- **Windows-to-Mac SSH image paste** through Alt+V and a small Windows clipboard helper
- **Cwd-aware new sessions** through a `/new` TUI selector, with the current cwd preselected and recent project directories ranked next
- **First-class local search** through `find_files` and `search_text`
- **Compact tool output** for built-ins and local search, with short subagent call lines kept visible without exposing their prompts
- **Native multi-harness subagents** through the separate `sz-pi-subagents` package
- **Claude Code-backed models** through the bundled `pi-claude-bridge` provider, with its optional `AskClaude` tool left off
- **Herdr question notifications** via its installed Pi integration. `ask_user` reports the built-in blocked state while a terminal question is open and clears it on answer, dismissal, cancellation, or UI failure. Notifications follow Herdr's settings.
- **Session-aware terminal titles** showing just the session name inside Herdr (`HERDR_ENV=1`), or `Pi - <session name>` in standalone terminals
- **Live agent-turn timing** above the prompt editor, retained as the most recent completed turn duration
- **State-aware Windows notifications** with click-to-focus behavior, persistent background alerts, and inactive-tab attention rings. Questions waiting for input show the same solid ring until answered or dismissed, even in the active tab. Pi's busy-indicator keepalive is paused during the question so it cannot overwrite the ring; answering restores the prior busy-indicator state.
- **Daily background Pi self-updates** with a restart notification when a new version installs
- **Session-local OpenAI speed modes** through `/fast` and `/ultrafast`
- **Same-terminal Pi restarts** through `/reopen`, resuming the current conversation
- **Cross-instance runtime reloads** through `/reload-all`
- **Synced Pi keybinding defaults**, including Ctrl+Backspace for deleting the previous word
- **Toggleable skill suites** through `/ss`, grouping optional skills and tools
- **Codex-style manual skill invocation** through `$skill-name` with `$` autocomplete
- **Model-aware reasoning controls** through `/r`, with Luna/DeepSeek defaulting to `max` and Sol/Fable 5.1 to `high`. Completed arguments such as `/r l` submit with one Enter. `minimal` is excluded.
- **Git view** and other local workflow helpers

## Install

Clone the repo to your user root, then run the setup script:

```bash
git clone https://github.com/stanley50z/sz-pi-extensions.git ~/sz-pi-extensions
cd ~/sz-pi-extensions
python3 setup.py
```

On Windows, use `python setup.py`. Setup requires Python 3.10 or newer. It pulls the latest checkout with `git pull --ff-only`, installs the locked npm dependencies, installs or updates Pi and its companion CLIs, registers this local package, and checks package loading, tools, and authentication. It includes Firecrawl, but does not install unrelated applications such as Herdr, local search servers, or the standalone Chrome extension.

Platform prerequisites:

- **macOS:** Install [Homebrew](https://brew.sh/) first. Setup uses it to install missing Git and Node, and install or update `fd`, `ripgrep`, and Ketch. A Homebrew-managed Codex stays managed by Homebrew.
- **Windows:** WinGet must be available for missing Git, Node, `fd`, `ripgrep`, and Go. Approve any Windows elevation prompts. Setup refreshes its process PATH after WinGet installs; reopen your shell afterward so it sees those changes too.
- **Linux:** Debian/Ubuntu systems can provision missing tools with `apt-get`. Run `sudo -v` first if they need installing. Other distributions must provide Git, Node, npm, `fd`, `ripgrep`, and Go themselves. Node must be 22 or newer; if the distribution supplies an older release, install a supported Node version before rerunning. Global npm installs must be writable by your account; use a user-owned Node installation rather than running this whole script as root.

Outside macOS, setup builds the latest Ketch with Go and places it in the existing Ketch directory, or beside Pi when installing it for the first time. On Debian/Ubuntu, it exposes `fdfind` as `fd` beside Pi when necessary. Existing Claude Code installations use `claude update`; fresh Claude Code, Pi, Firecrawl, and non-Homebrew Codex installations use npm. Existing Node and Git are retained when present; Node's minimum version is checked. Setup never forces an overwrite of a conflicting global executable.

Run the same command again to update or repair the stack. A dirty checkout stops the Git update; setup never stashes, resets, or discards your changes. To install your current checkout without pulling, or just inspect the installation:

```bash
python3 setup.py --skip-pull
python3 setup.py --check
```

Checks report remaining actions such as `claude auth login`, `codex login`, `firecrawl login`, or unavailable Ketch backends. Setup does not copy credentials, open login flows, select a paid plan, or bypass OS approval. Once any reported actions are complete, rerun `--check`, then restart Pi. Check mode does not install tools or pull Git; provider health checks can contact their services. Verification includes a no-prompt Pi startup check and never sends a model prompt.

Exit codes are `0` for ready, `2` for remaining user actions or failed checks, and `1` for installation errors. Commands time out after 600 seconds, with checks limited to 30 seconds. Override the ceiling with `--timeout SECONDS`. Timed-out commands and their child processes are stopped.

Each run saves `setup.log`, `report.json`, and, on exceptions, `crash-report.txt` with Python stack traces under `~/.pi/agent/logs/setup/<UTC-timestamp>-<pid>/`. `PI_CODING_AGENT_DIR` changes that root. These reports replace native crash dumps for the installer. Full command output is preserved; review logs before sharing them. Installer regression-test logs are kept locally under `~/.pi/agent/logs/setup-validation/` when validation output is captured there.

For a package-only install without provisioning external tools, the original commands still work:

```bash
npm install
pi install ~/sz-pi-extensions
```

This keeps the package editable — changes you make are live after restarting Pi. No sync step needed. The npm install fetches the pinned public [`sz-pi-subagents`](https://github.com/stanley50z/sz-pi-subagents) and [`pi-claude-bridge`](https://www.npmjs.com/package/pi-claude-bridge) dependencies, clones [Ketch](https://github.com/1broseidon/ketch) into `node_modules/ketch`, installs the `ketch` CLI with Go when it is missing from `PATH`, and exposes their Pi resources. Because `node_modules/` is ignored, generated dependency contents remain separate from this repository's tracked files.

On Windows, session startup registers a per-user `pi-notify:` URI handler under `HKCU`. Notification clicks launch the bundled hidden focus helper with a one-time token, which selects the existing Pi tab without opening another Terminal window, brings its window forward, and focuses the terminal text area for immediate typing. No administrator access is required.

Pi discovers extensions and skills from the package manifest in `package.json`:

```json
{
  "pi": {
    "extensions": [
      "./extensions",
      "node_modules/pi-claude-bridge/src/index.ts"
    ],
    "skills": [
      "./skills",
      "node_modules/sz-pi-subagents/skills",
      "node_modules/ketch/skills/ketch"
    ]
  }
}
```

## Pi-specific system instructions

`npm install` also installs the tracked `config/APPEND_SYSTEM.md` into `~/.pi/agent/APPEND_SYSTEM.md`, or the directory selected by `PI_CODING_AGENT_DIR`. The installer creates or updates only the `sz-pi-extensions` marked section, preserves unrelated instructions, and avoids duplicates on repeat installs.

The prompt records preferred subagent harnesses, providers, models, and reasoning levels. These are agent instructions, not enforced tool defaults or changes to the current session's model. The subagent tool and global `AGENTS.md` remain unchanged.

Edit `config/APPEND_SYSTEM.md` to change these preferences across machines. To sync just the prompt, including after installing with lifecycle scripts disabled, run:

```bash
node scripts/install-append-system.mjs
```

Run `/reload` in existing Pi sessions afterward. Pi uses the exact filename `APPEND_SYSTEM.md`. A trusted project's `.pi/APPEND_SYSTEM.md` or an explicit `--append-system-prompt` overrides global file discovery.

## Local workflow tools

`ask_user` presents two to five choices and always includes a free-form answer. In the TUI, highlight "Type my own answer" and begin typing immediately; Pi's configured clipboard shortcut can paste text or attach an image there. Up/Down move the cursor within multiline and wrapped answers. Up at the very start returns to the options without discarding the draft. `/copy-all` copies the active branch's user and assistant messages while omitting tool output and hidden reasoning.

Sessions are automatically named after the first answered prompt using the active model. Bare `/name` regenerates the title; `/name <title>` keeps Pi's manual naming behavior. Naming requests preserve the endpoint resolved by authentication, so Copilot business accounts do not use the catalog's default individual endpoint. Provider errors are reported rather than silently leaving the session unnamed.

`/new` opens a working-directory selector before creating the session. The active session cwd is selected by default; other existing cwds found in session history are deduplicated and ordered by most recent activity. `/neww` starts a new session in the active cwd immediately, skipping the selector.

`/reopen` launches a fresh Pi process in the same terminal and project, resuming the exact saved conversation with the current model and reasoning level. Use it after updating Pi itself; `/reload` only refreshes resources. It preserves CLI configuration without replaying startup prompts, attachments, or session-selection actions. The command requires an idle TUI session saved to disk and refuses RPC, active turns, and queued messages. Pi finishes terminal and extension cleanup before relaunching. The disposed process waits synchronously for its replacement so the shell cannot steal terminal input; repeated reopens retain one waiting parent per restart until you quit.

`/reload-all` reloads extensions, skills, prompts, themes, and context files in every running normal Pi instance that has this package loaded. Busy instances reload after their current turn settles; Automode sessions are left unchanged.

`find_files` and `search_text` provide structured wrappers around [`fd`](https://github.com/sharkdp/fd) and [`ripgrep`](https://github.com/BurntSushi/ripgrep). Both executables must be available on `PATH`; search output is bounded, with complete truncated results saved to a temporary file.

Built-in file and shell tools, local search tools, and subagent tools do not render result bodies or image previews. Agent reads of `SKILL.md` render as highlighted `[skill]` invocation lines outside tool-call groups, but never show the skill body. Consecutive skill reads share one line. Press Ctrl+O to switch between grouped one-line tool cards and the ultra-collapsed `+ N tool calls` summary. In fullscreen mode, clicking a summary reveals every call in that group; clicking any revealed card collapses the whole group. Result bodies stay hidden. Subagent calls always keep a short line with their topic and harness visible. Spawn lines show the model name without its provider or `claude-` prefix and the reasoning level when supplied, but never show the full delegated prompt. Spawn results record Pi's inherited model or the model reported during native CLI startup, including Claude Code's default when no model is supplied. Native spawn calls return once the model is known or startup ends; the child task continues in the background. The recorded model remains visible after session restore. Background subagent completions show one summary line when collapsed and their full returned text when expanded. While children are running, the footer adds a third line with the active count and abbreviated topics, each followed by its model name without the provider or `claude-` prefix and its reasoning level when available, separated by ` · `. It updates as child settings change and disappears when all children finish.

Codemode follows the same minimal tool view. Its scripts and result bodies stay hidden in both views. Minimized groups count nested calls rather than the codemode wrapper and show running, failed, or cancelled counts. Expansion reveals compact nested-call cards. Nested skill and subagent calls retain their visible invocation lines. Scripts without nested calls show a compact `codemode` line. Compact rendering metadata is saved with the result so restored sessions retain useful arguments without storing write content or delegated prompts in that metadata.

Run `node --test test/codemode-minimal-output.test.mjs test/codemode-minimal-runtime.test.mjs` to validate codemode rendering. The runtime check runs the real session and sandbox against repository files with a scripted model response, without a paid model call. It saves its event log and rendered views to `~/.pi/agent/logs/codemode-minimal-validation/latest.json`, and failure stack traces to `~/.pi/agent/logs/codemode-minimal-validation/crash-report.txt`.

Tool-group click validation logs and failure stack traces are saved in `~/.pi/agent/logs/tool-expansion-validation/`.

Click the underlined cwd path in the footer in fullscreen mode to open the session folder in Explorer, Finder, or the Linux file manager. Shortened paths still open the full directory; the branch and session name are not clickable.

The Git Diff Viewer activates when the session working directory belongs to a Git repository. Click the underlined, centered `+X −Y` footer totals in fullscreen mode to show or hide up to five files, ordered by total lines changed. The viewer runs entirely in Pi's TUI and does not start a localhost server. Idle TUI sessions check Git every second, so commits and file changes from another session or editor update the footer without a new turn. Git reads run asynchronously, scans do not overlap, and unchanged totals do not trigger a repaint. Polling stops on shutdown or reload.

Validate with `node --test test/sz-git-view.test.mjs test/sz-pi-footer.test.mjs`. Validation output and assertion failure stack traces are saved under `~/.pi/agent/logs/git-footer-validation/` when the command output is captured there. `red.txt` records the original stale-footer reproduction; `green.txt` records the focused suite, and `full.txt` records the full suite.

When a GitHub Copilot model is selected, the centered subscription slot shows monthly consumption, for example `Copilot month:$43.93`. The session's calculated cost stays on the left, and Codex usage is unchanged. Copilot consumption is `quota_snapshots.premium_interactions.credits_used / 100` in USD, including included consumption and overage already. It is not an amount due. Valid zero displays `$0.00`; loading displays `…`; missing credentials, unsupported API-key or enterprise auth, invalid data, and failed requests display `unavailable`.

The footer reads Pi's existing GitHub Copilot OAuth `refresh` credential from the effective `PI_CODING_AGENT_DIR/auth.json`, defaulting to `~/.pi/agent/auth.json`. It calls only `https://api.github.com/copilot_internal/user`, refuses redirects, and requires token-based billing and the upcoming UTC monthly reset date. It uses no billing API, `gh`, or bridge process. Session start, model selection, and turn completion trigger reads, with requests deduplicated and throttled to once per 60 seconds per unchanged credential. Auth changes are checked on every trigger; model changes and shutdown invalidate pending results. Requests time out after 10 seconds. This endpoint is undocumented, and GitHub's update latency is unspecified; the throttle is local policy, not a freshness guarantee. The existing narrow-terminal layout may omit the centered slot when it does not fit.

When a `claude-bridge` model is selected, the same slot shows the Claude plan's five-hour and weekly usage in the Codex format, for example `5h:12% wk:34%`. The footer starts a short-lived Claude Code process through the bundled Claude Agent SDK and sends the request behind `/usage`, without starting a turn or saving a session. Session start, model selection, and turn completion trigger a read, which times out after 10 seconds. `…` means loading, `!` means the read failed, and `—` means Claude Code reported no value for that window. When Claude Code authenticates with an API key, Bedrock, or Vertex, the slot shows `API`. The SDK marks this request experimental, so an SDK update can break it, and the slot then shows `5h:! wk:!`.

Claude Bridge's session cost on the left is the API-equivalent value of its recorded tokens, not your subscription bill or Extra Usage charges. The footer prices each message using its own model's current Anthropic rates from Pi's model registry, including input, output, cache reads, and cache writes. It also reprices resumed zero-cost history without changing saved messages. Other providers keep their reported costs. If a Bridge model is absent from the catalog, the total shows `cost:unavailable` instead of a misleading zero or partial sum. Costs retain three significant figures.

Claude cost validation output and failure stack traces are saved in `~/.pi/agent/logs/claude-cost-validation/`: `red.txt`, `green.txt`, `full.txt`, and `e2e.json`. The real-session check uses a disposable copy and records only usage totals and footer lines. A failed real-session check writes `crash-report.txt` there.

## Image paste over SSH

To paste Windows screenshots into Pi running on a Mac, start the connection from Windows Terminal with `python scripts\ssh-clipboard\ssh.py my-mac`. Copy a screenshot and press Alt+V in Pi. The helper transfers the image through SSH and adds it to the draft without submitting. Clipboard paste survives reconnects when Pi runs inside Herdr or tmux. Normal text paste is unchanged.

See [setup, session resuming, and privacy details](scripts/ssh-clipboard/README.md). This needs the helper on Windows; installing the Mac extension alone cannot read the Windows clipboard.

## Manual skill invocation

Type `$` in the prompt editor to autocomplete loaded skills, then submit `$skill-name` with any additional instructions. While a `$skill` or `/skill:` completion is available, Enter accepts it without submitting, just like Tab; press Enter again to send the completed prompt. A loaded `$skill-name` mention at the start or within a prompt invokes the same Pi skill expansion as `/skill:skill-name`; unknown `$name` text is left unchanged.

The input's top-right `[ commit ]` button submits `$commit` without changing your draft. Clicks work in fullscreen mode; when Pi is busy, the commit is queued as a follow-up. In regular scrollback mode, type `$commit` instead.

Explicitly invoking `$commit` or `/skill:commit`, including through the commit button, keeps the current model and temporarily uses its lowest supported reasoning level, including `off` when supported. After the run settles, even on failure or cancellation, the previous reasoning is restored unless you selected another model in the meantime. Invocations during ongoing work wait until that work settles before lowering reasoning. The agent reading the commit skill on its own does not change reasoning.

The real-session regression test writes evidence to `~/.pi/agent/logs/commit-reasoning-validation/latest.json` and stack traces on failure to `~/.pi/agent/logs/commit-reasoning-validation/crash-report.txt`.

## Skill suites

Run `/ss` to open a multi-select panel. Move with ↑/↓, press Space to toggle suites independently, then press Enter to apply. Each suite can control both skill paths and registered Pi tool names.

Selections are remembered per resolved project cwd. Every project's selection and all suite definitions live together in the single global file `~/.pi/agent/skill-suites.json`; Pi does not create a config file inside each project or session directory.

Run `/ss <description>` to ask the agent to propose a new suite or edits to existing suites. The agent receives the current configuration and registered tool names, presents the exact JSON change, and waits for approval before editing.

The extension filters disabled suite skills out of the model system prompt and disables their managed tools. To also hide optional skills from Pi's default discovery, add exclusions to `~/.pi/agent/settings.json`:

```json
{
  "skills": ["!lark-*", "!remotion-*"]
}
```

Selected suite skills are re-added dynamically. Each `skill-suites.json` suite has a label, description, `skillPaths`, and `tools`. Skill-path wildcards are supported in the final path segment.

## Synced keybindings

The package merges its preferred keybindings into `~/.pi/agent/keybindings.json` whenever Pi loads it. Existing unrelated user bindings are preserved. Currently it adds Ctrl+Backspace to `tui.editor.deleteWordBackward`, alongside Pi's Ctrl+W and Alt+Backspace defaults.

Because this preference lives in the tracked extension, installing the package on another machine recreates it without separately syncing `keybindings.json`.

## Pi autoupdate

On session startup, the package runs `pi update --self` in the background when it has not checked during the previous 24 hours. Startup is not blocked, already-current versions stay silent, and a successful update displays a notification asking you to restart Pi. Failures are reported without stopping the session, and the next session retries instead of waiting 24 hours. Autoupdate honors `PI_OFFLINE=1` (as well as `true` or `yes`) and stores its last-check time in `~/.pi/agent/pi-autoupdate.json` or the configured `PI_CODING_AGENT_DIR`.

## Fast mode

Use `/fast` for OpenAI priority processing or `/ultrafast` for the `ultrafast` service tier. Each command toggles its mode on or off. Enabling either replaces the other. `/ultrafast` takes no arguments; `/fast` also accepts `on`, `off`, and `status`. The footer shows `⚡fast` or `⚡ultrafast` for compatible request APIs.

Speed is one of three peer levels: `normal`, `fast`, or `ultrafast`. Commands save the selected level to `<project-directory>/.pi/openai-fast-mode.json`, for example `{"level":"fast"}`. New sessions in that exact working directory, including Pi subagents, restore the saved level. Other directories and already-running sessions are unaffected. Without a saved choice, sessions start at `normal`. `--fast` overrides the saved level for that invocation without changing the file. `/fast off` or toggling the active mode off saves `normal`.

The old global `~/.pi/agent/openai-fast-mode.json` and `PI_OPENAI_FAST_MODE` are still ignored. The provider hook applies only to models using the OpenAI Responses or OpenAI Codex Responses APIs. Switching to an incompatible model does not erase the saved speed level.

[Ultrafast in Codex](https://learn.chatgpt.com/docs/agent-configuration/speed) requires GPT-6 Astra and Pro $500 or an eligible Enterprise/Edu plan. [API availability](https://developers.openai.com/api/docs/guides/ultrafast-mode) differs. The extension requests the selected tier; OpenAI enforces model and account eligibility and reports request failures. A `supported` status means the request API is compatible, not that the account has access.

Invalid project settings and failed saves are reported as extension errors, with stack traces in `<project-directory>/.pi/logs/openai-speed.log` when writable. A failed save leaves the active level unchanged. Validation logs and test failure stack traces are saved in `~/.pi/agent/logs/fast-mode-validation/`.

## Subagents

[`sz-pi-subagents`](https://github.com/stanley50z/sz-pi-subagents) is maintained as an independent public package but composed here as a pinned dependency. Pi still installs only `sz-pi-extensions`; a local wrapper loads the dependency's extension with the shared compact renderer, while the dependency's skill is discovered directly. It provides the complete subagent implementation through persistent native Pi, Codex, and Claude Code sessions.

Native Pi subagents load the speed-mode extension with their own session-local state. The parent's `/fast` and `/ultrafast` settings do not propagate to Pi, Codex, or Claude Code children.

Model-display validation logs, saved spawn metadata, and failure stack traces are kept in `~/.pi/agent/logs/subagent-model-validation/`. Native Claude Code transcripts are managed by Claude Code under `~/.claude/projects/`; subagent completion output includes the transcript path.

## Claude Code provider

[`pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge) is pinned to `0.9.1`, bundled in this package, and discovered directly through the manifest. No separate `pi install` is needed. It requires Pi 0.86.1 or newer and an authenticated Claude Code installation. Check authentication with `claude auth status`, then run `/reload` and select a model such as `claude-bridge/claude-fable-5-1` with `/model`. Installing the provider does not change your default model. The package's synced instructions prefer Pi subagents with `claude-bridge` for Claude models, with native Claude Code as an alternative.

The optional `AskClaude` tool stays off by default because this stack already provides native subagents. Machine-specific subscription settings belong in `~/.pi/agent/claude-bridge.json`, not this repository. For a Max subscription, use:

```json
{
  "askClaude": { "enabled": false },
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "strictMcpConfig": true
  }
}
```

Use `"pro"` for a Pro subscription. `longContextExtraUsage` stays off to avoid opting into metered long-context usage. Project `.pi/claude-bridge.json` settings override the global file. Session naming uses the session model registry so extension providers work; bridge naming requests run as isolated one-off summaries instead of modifying the conversation.

For debugging, start Pi with `CLAUDE_BRIDGE_DEBUG=1`. The bridge persists diagnostics and error stack traces to `~/.pi/agent/claude-bridge.log`, with Claude Code subprocess logs in `~/.pi/agent/cc-cli-logs/`. `PI_CODING_AGENT_DIR` changes that root, and `CLAUDE_BRIDGE_DEBUG_PATH` overrides the bridge log path. Debug logs can contain conversation and file content; review them before sharing. The bridge does not configure native crash dumps.

Local installation validation logs, JSONL smoke-test events, and failure stack traces are saved in `~/.pi/agent/logs/claude-bridge-validation/`. Validation covers model discovery, a real Claude Code-backed response with a Pi `read` call, automatic naming, and npm tarball inclusion.

## Ketch

Pi discovers Ketch's bundled skill from the ignored checkout and uses the `ketch` CLI as its research transport. `npm install` clones the skill checkout and runs `go install github.com/1broseidon/ketch@latest` when the CLI is not already on `PATH`. That step is best effort, so a missing Go toolchain or a failed clone warns instead of aborting the install; install the CLI by hand in that case:

```bash
go install github.com/1broseidon/ketch@latest
```

Configure providers through Ketch rather than this package:

```bash
ketch config
ketch config set backend brave
ketch config set brave_api_key <key>
ketch config set exa_api_key <key>
ketch doctor --json
```

Ketch also supports keyless backends such as DuckDuckGo and Keenable. Pi's Ketch skill routes live web search, code search, documentation lookup, page scraping, and site crawling to the appropriate Ketch surface.

## Firecrawl specialist

Ketch remains the default research path. The compact `firecrawl-specialist` skill routes managed rendering, broad crawls, monitoring, structured extraction, and local document parsing to the optional Firecrawl CLI without installing Firecrawl's large global skill pack.

Install and authenticate the CLI separately when this specialist capability is needed, then verify it with:

```bash
firecrawl --status
```

The skill checks available credits and concurrency, keeps requests narrow, and routes authenticated user-browser work to browser-harness instead.

## Chrome Annotation MVP

This repo includes a standalone Chrome extension at `chrome-extensions/sz-annotate/` for local UI annotation. It is not a Pi extension yet. Load it unpacked in Chrome, annotate localhost pages, copy the generated Markdown prompt, and attach the combined highlighted screenshot manually.

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Verify the package loads in Pi:

```bash
pi --offline --no-extensions -e . --list-models
```

## Security

Do not commit API keys or credentials.

Run `npm audit` to check dependency advisories. After compatible security updates, rerun `npm test` and a live Claude bridge file-read check. Audit reports, test output, bridge diagnostics, and smoke-test events are saved in `~/.pi/agent/logs/dependency-security-validation/` for local update validation.

- Extensions run with local system permissions, so review code before installing packages from third parties.
- Ketch configuration stores provider credentials outside this repository.

## Acknowledgments

The native workflow-tool ideas were inspired by [Ben Davis's `my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup) and independently implemented here.

## License

MIT
