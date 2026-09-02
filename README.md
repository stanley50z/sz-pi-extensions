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
- **Cwd-aware new sessions** through a `/new` TUI selector, with the current cwd preselected and recent project directories ranked next
- **First-class local search** through `find_files` and `search_text`
- **Compact tool output** for built-ins and local search, with short subagent call lines kept visible without exposing their prompts
- **Native multi-harness subagents** through the separate `sz-pi-subagents` package
- **Session-aware terminal titles** formatted as `Pi - <session name>`
- **Live agent-turn timing** above the prompt editor, retained as the most recent completed turn duration
- **State-aware Windows notifications** with click-to-focus behavior, persistent background alerts, and inactive-tab attention rings
- **Daily background Pi self-updates** with a restart notification when a new version installs
- **Persistent, synchronized OpenAI fast mode** through `/fast`
- **Cross-instance runtime reloads** through `/reload-all`
- **Synced Pi keybinding defaults**, including Ctrl+Backspace for deleting the previous word
- **Toggleable skill suites** through `/ss`, grouping optional skills and tools
- **Codex-style manual skill invocation** through `$skill-name` with `$` autocomplete
- **Model-aware reasoning controls** through `/r`, with Luna/DeepSeek defaulting to `max` and Sol/Fable 5 to `high`
- **Git view** and other local workflow helpers

## Install

Clone the repo to your user root, then install the local path:

```bash
git clone https://github.com/stanley50z/sz-pi-extensions.git ~/sz-pi-extensions
cd ~/sz-pi-extensions
npm install
pi install ~/sz-pi-extensions
```

This keeps the package editable — changes you make are live after restarting Pi. No sync step needed. The npm install fetches the pinned public [`sz-pi-subagents`](https://github.com/stanley50z/sz-pi-subagents) dependency, clones [Ketch](https://github.com/1broseidon/ketch) into `node_modules/ketch`, and exposes both packages' Pi resources. Because `node_modules/` is ignored, generated dependency contents remain separate from this repository's tracked files.

On Windows, session startup registers a per-user `pi-notify:` URI handler under `HKCU`. Notification clicks launch the bundled hidden focus helper with a one-time token, which selects the existing Pi tab without opening another Terminal window. No administrator access is required.

Pi discovers extensions and skills from the package manifest in `package.json`:

```json
{
  "pi": {
    "extensions": [
      "./extensions"
    ],
    "skills": [
      "./skills",
      "node_modules/sz-pi-subagents/skills",
      "node_modules/ketch/skills/ketch"
    ]
  }
}
```

## Local workflow tools

`ask_user` presents two to five choices and always includes a free-form answer. In the TUI, highlight "Type my own answer" and begin typing immediately; Pi's configured clipboard shortcut can paste text or attach an image there. `/copy-all` copies the active branch's user and assistant messages while omitting tool output and hidden reasoning.

`/new` opens a working-directory selector before creating the session. The active session cwd is selected by default; other existing cwds found in session history are deduplicated and ordered by most recent activity.

`/reload-all` reloads extensions, skills, prompts, themes, and context files in every running normal Pi instance that has this package loaded. Busy instances reload after their current turn settles; Automode sessions are left unchanged.

`find_files` and `search_text` provide structured wrappers around [`fd`](https://github.com/sharkdp/fd) and [`ripgrep`](https://github.com/BurntSushi/ripgrep). Both executables must be available on `PATH`; search output is bounded, with complete truncated results saved to a temporary file.

Built-in file and shell tools, local search tools, and subagent tools do not render result bodies or image previews. Agent reads of `SKILL.md` render as highlighted `[skill]` invocation lines outside tool-call groups, but never show the skill body. Consecutive skill reads share one line. Press Ctrl+O to switch between grouped one-line tool cards and the ultra-collapsed `+ N tool calls` summary. Subagent calls always keep a short line with their topic and harness visible, but never show the full delegated prompt. Background subagent completions show one summary line when collapsed and their full returned text when expanded. While children are running, the footer adds a third line with the active count and abbreviated topics; it disappears when all children finish.

Git View and the footer's clickable change count activate only when the current session working directory belongs to a Git repository.

## Manual skill invocation

Type `$` in the prompt editor to autocomplete loaded skills, then submit `$skill-name` with any additional instructions. While a `$skill` or `/skill:` completion is available, Enter accepts it without submitting, just like Tab; press Enter again to send the completed prompt. A loaded `$skill-name` mention at the start or within a prompt invokes the same Pi skill expansion as `/skill:skill-name`; unknown `$name` text is left unchanged.

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

Use `/fast`, `/fast on`, or `/fast off` to control OpenAI priority processing. The setting is stored in `~/.pi/agent/openai-fast-mode.json` (or the configured `PI_CODING_AGENT_DIR`) and restored when Pi starts. Changes are synchronized to every currently running Pi session, including native Pi subagents. Codex subagents inherit the same state as Codex's `priority` service tier and refresh it before every turn. The Pi provider hook applies only to models using the OpenAI Responses or OpenAI Codex Responses APIs.

## Subagents

[`sz-pi-subagents`](https://github.com/stanley50z/sz-pi-subagents) is maintained as an independent public package but composed here as a pinned dependency. Pi still installs only `sz-pi-extensions`; a local wrapper loads the dependency's extension with the shared compact renderer, while the dependency's skill is discovered directly. It provides the complete subagent implementation through persistent native Pi, Codex, and Claude Code sessions.

Native Pi subagents load the fast-mode extension and share its synchronized state. Codex subagents receive that state through the Codex app-server `serviceTier` setting. Claude Code uses its own harness, so Pi's `/fast` setting does not apply to Claude children.

## Ketch

Pi discovers Ketch's bundled skill from the ignored checkout and uses the `ketch` CLI as its research transport. The CLI must be available on `PATH`; install it using one of Ketch's supported methods if needed:

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

- Extensions run with local system permissions, so review code before installing packages from third parties.
- Ketch configuration stores provider credentials outside this repository.

## Acknowledgments

The native workflow-tool ideas were inspired by [Ben Davis's `my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup) and independently implemented here.

## License

MIT
