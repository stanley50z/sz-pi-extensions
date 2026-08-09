---
name: firecrawl-specialist
description: Use the Firecrawl CLI for difficult public-web extraction after Ketch or a direct fetch is inadequate, and for site crawls, monitoring, structured extraction, local-file parsing, or explicit Firecrawl requests. General web discovery uses Ketch; authenticated browser work uses browser-harness.
compatibility: Requires the firecrawl CLI on PATH and Firecrawl authentication or keyless access.
---

# Firecrawl specialist

Use Firecrawl as the managed extraction specialist. General web discovery uses Ketch. Work tied to the user's browser session, cookies, or existing login uses browser-harness.

## Route

| Need | Command |
| --- | --- |
| Difficult public page or JavaScript rendering | `firecrawl scrape` |
| Many pages from one site | `firecrawl crawl` |
| URLs within a known site | `firecrawl map` |
| Structured extraction from complex sites | `firecrawl agent` |
| Recurring change alerts | `firecrawl monitor` |
| PDF, DOCX, or spreadsheet on disk | `firecrawl parse` |
| Explicit Firecrawl search or Ketch search failure | `firecrawl search` |
| Public-page clicks or pagination after scraping | `firecrawl interact` |

Run `firecrawl <command> --help` before using unfamiliar flags; CLI help is the source of truth.

## Workflow

1. Run `firecrawl --status`. Confirm authentication, concurrency, and available credits.
2. Choose the narrowest command from the routing table.
3. Bound the request: use small search limits, focused crawl paths, and the lowest practical page count.
4. Save substantial output under `.firecrawl/` and ensure `.firecrawl/` is ignored by Git.
5. Inspect saved results incrementally with line counts, targeted search, and partial reads.
6. Report source URLs and disclose incomplete, failed, or credit-limited extraction.

## Common calls

```bash
firecrawl --status
firecrawl search "query" --limit 5
firecrawl scrape "https://example.com/page" -o .firecrawl/example-page.md
firecrawl map "https://example.com"
firecrawl crawl "https://example.com/docs"
firecrawl monitor --help
firecrawl agent --help
firecrawl interact --help
```

Quote every URL. Treat query strings as shell-sensitive input.

## Boundaries

- Keep Ketch as the default for ordinary web, code, and documentation research.
- Use Firecrawl when managed rendering, extraction, crawling, monitoring, or parsing provides material value.
- Use browser-harness for authenticated sessions, existing browser state, consent prompts, MFA, or user-account actions.
- Keep credentials in Firecrawl's stored authentication or environment variables, never repository files.
- Credits are finite: check status before broad work and narrow requests before retrying.
