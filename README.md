# sz-pi-extensions

A personal Pi package with custom extensions and skills for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

This package currently includes UI/automation helpers plus a trimmed web access extension that supports **Exa** and **Brave Search** without Perplexity or Gemini dependencies.

## Features

- **Web search** via Exa or Brave Search
- **Code/documentation search** via Exa MCP
- **Readable content extraction** for web pages, PDFs, and GitHub repositories
- **Stored search/fetch results** retrievable across the current Pi session
- **Chrome DevTools MCP** integration
- **Git view** and other local workflow helpers

## Install

Install this package into Pi from GitHub:

```bash
pi install git:github.com/stanley50z/sz-pi-extensions
```

For local development, run Pi with this package path or install it locally:

```bash
pi install /path/to/sz-pi-extensions
```

Pi discovers extensions and skills from the package manifest in `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

## Configuration

Create a `.env` file in your project directory or any parent directory:

```dotenv
EXA_API_KEY=exa-...
BRAVE_API_KEY=...
```

Environment variables already exported in your shell take precedence over `.env` values.

### Provider notes

- `EXA_API_KEY` is optional for basic Exa MCP-backed search, but recommended for direct Exa API access.
- `BRAVE_API_KEY` is required when using Brave Search.
- `.env` is ignored by git. Use `.env.example` as the committed template.

## Tools

### `web_search`

Search the web with Exa or Brave Search.

```ts
web_search({ query: "Apple latest earnings" })
web_search({ queries: ["React 19 migration", "React 19 breaking changes"] })
web_search({ query: "AAPL closing price", provider: "brave" })
web_search({ query: "TypeScript release notes", provider: "exa", numResults: 10 })
```

Parameters:

| Parameter | Description |
| --- | --- |
| `query` | Single search query |
| `queries` | Multiple queries searched in sequence |
| `numResults` | Results per query, default `5`, max `20` |
| `includeContent` | Fetch source page content in the background |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains; prefix with `-` to exclude |
| `provider` | `auto`, `exa`, or `brave` |

Provider behavior in `auto` mode:

1. Try Exa first.
2. Fall back to Brave when `BRAVE_API_KEY` is configured.

### `code_search`

Search for code examples, API references, and technical documentation through Exa MCP.

```ts
code_search({ query: "TypeScript satisfies operator examples" })
code_search({ query: "Radix dialog accessibility patterns", maxTokens: 10000 })
```

Parameters:

| Parameter | Description |
| --- | --- |
| `query` | Programming question, API, library, or debugging topic |
| `maxTokens` | Maximum returned context, default `5000`, max `50000` |

### `fetch_content`

Fetch URLs and extract readable markdown content.

```ts
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["https://example.com/a", "https://example.com/b"] })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://example.com/report.pdf" })
```

Supported content:

- Regular web pages
- PDFs
- GitHub repositories, directories, and files
- Plain text / markdown / JSON responses

Parameters:

| Parameter | Description |
| --- | --- |
| `url` | Single URL |
| `urls` | Multiple URLs |
| `forceClone` | Clone GitHub repositories that exceed the default size threshold |

### `get_search_content`

Retrieve stored search or fetch results from the current Pi session.

```ts
get_search_content({ list: true })
get_search_content({ responseId: "abc123" })
get_search_content({ responseId: "abc123", urlIndex: 0 })
get_search_content({ responseId: "abc123", query: "original query" })
```

## What is intentionally excluded

This package intentionally does **not** include:

- Perplexity support
- Gemini API support
- Gemini Web/browser-cookie support
- YouTube video understanding
- Local video analysis or frame extraction
- Browser cookie extraction for Google/Gemini accounts

Those features were removed because they depend on paid API keys, account cookies, or provider-specific access outside the Exa/Brave search scope.

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Verify the web access extension loads in Pi:

```bash
pi --offline --no-extensions -e ./extensions/pi-web-access/index.ts --list-models
```

## Security

Do not commit API keys or credentials.

- `.env` is gitignored.
- `.env.example` is safe to commit and contains only empty placeholders.
- Extensions run with local system permissions, so review code before installing packages from third parties.

## Attribution

The `pi-web-access` extension in this package is based on ideas and selected non-Gemini/non-Perplexity components from [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access), adapted for this package with Exa + Brave Search support.

## License

MIT
