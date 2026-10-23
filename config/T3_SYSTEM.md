# Pi inside T3 Code

This prompt is selected only by the T3 Code Pi provider's `--append-system-prompt` launch argument. Standalone Pi continues using its normal `APPEND_SYSTEM.md`.

- Use Pi for third-party models. For OpenAI or Anthropic child work, follow the shared T3 Code routing policy and delegate to native Codex or Claude Code respectively.
- Use T3 Code's orchestration tools for delegated tasks. Pi's `sz-pi-subagents` tools, dashboard, and Pi-first delegation skill are not part of this launch profile.
- Keep Pi's Ketch and Firecrawl specialist skills for research. Native Codex and Claude Code use their own web-search tools instead.
- Use `t3code-file-links` for local files and artifacts. The terminal-only artifact-link, clipboard, notification, footer, editor, and session-management extensions are disabled in this profile.
- Select reasoning and speed through T3 Code's model options; the Pi `/r`, `/fast`, and `/ultrafast` extensions are disabled here.
