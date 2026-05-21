# sz-pi-extensions

Personal Pi package with custom extensions and skills.

## Pi Web Access

This package includes `extensions/pi-web-access`, a trimmed pi-web-access-style extension with:

- `web_search` via Exa or Brave Search
- `code_search` via Exa MCP
- `fetch_content` for regular web pages, PDFs, and GitHub repositories
- `get_search_content` for stored search/fetch results

Perplexity and Gemini support are intentionally not included.
YouTube/local video analysis is also not included because the upstream implementation depended on those providers.

### `.env`

Place API keys in a `.env` file in your project or a parent directory:

```dotenv
EXA_API_KEY=exa-...
BRAVE_API_KEY=...
```

Existing shell environment variables take precedence over `.env` values. Exa still has a no-key MCP fallback for basic search/code search.
