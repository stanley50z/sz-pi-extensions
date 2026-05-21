# Pi Web Access Brave Design

## User Requirements

- Add a version of `nicobailon/pi-web-access` under `sz-pi-extensions`: user's initial request and follow-up.
- Remove Perplexity support: user's initial request.
- Remove Gemini support entirely if Gemini-dependent features require API/account/payment: user's follow-up.
- Add Brave Search support: user's initial request.
- Use `.env` for configuration: user's follow-up.

## Agent Design Decisions

- Implement the extension as `extensions/pi-web-access/` and let the existing package manifest load it through the existing `./extensions` package entry; serves adding the extension under `sz-pi-extensions`.
- Keep zero-config Exa MCP plus optional `EXA_API_KEY`, and add Brave via `BRAVE_API_KEY`; serves Exa + Brave search without Perplexity/Gemini.
- Load `.env` from the current working directory and repo/package ancestors without adding a dotenv dependency; serves `.env` configuration.
- Keep core non-Gemini capabilities: web search, code search via Exa MCP, normal URL fetch/extraction, PDF text extraction, GitHub clone/API extraction, stored search content, and activity widget; serves creating a useful pi-web-access variant while removing paid/account-dependent providers.
- Remove YouTube/local video analysis, frame extraction, Gemini URL context, Gemini Web cookies, Perplexity fallback, and `/google-account`; serves full Perplexity/Gemini removal.
