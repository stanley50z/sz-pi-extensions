# sz-pi-extensions

A personal Pi package with custom extensions and skills for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

This package includes UI and automation helpers. Live-source research is delegated to [Ketch](https://github.com/1broseidon/ketch) instead of being implemented as a separate Pi extension.

## Features

- **Web research** through Ketch, including Brave and Exa search backends
- **Code and documentation search** through Ketch
- **Web page, PDF, and site extraction** through Ketch
- **Chrome DevTools MCP** integration
- **Native multi-harness subagents** through the separate `sz-pi-subagents` package
- **Session-aware terminal titles** formatted as `Pi - <session name>`
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

Pi discovers extensions and skills from the package manifest in `package.json`:

```json
{
  "pi": {
    "extensions": [
      "./extensions",
      "node_modules/sz-pi-subagents/extensions/subagents/index.ts"
    ],
    "skills": [
      "./skills",
      "node_modules/sz-pi-subagents/skills",
      "node_modules/ketch/skills/ketch"
    ]
  }
}
```

## Subagents

[`sz-pi-subagents`](https://github.com/stanley50z/sz-pi-subagents) is maintained as an independent public package but composed here as a pinned dependency. Pi still installs only `sz-pi-extensions`; this package loads the dependency's extension and skill. It provides the complete subagent implementation through persistent native Pi, Codex, and Claude Code sessions.

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

## License

MIT
