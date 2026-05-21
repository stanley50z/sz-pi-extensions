# Pi Web Access Brave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Priority rule:** Tasks tagged `[USER-REQ]` implement non-negotiable user requirements. Tasks tagged `[AGENT-DECISION]` implement flexible agent design decisions. If a conflict arises during implementation, agent decisions yield to user requirements. If a user requirement cannot be met, stop and surface to the user.

**Goal:** Add a pi-web-access variant to `sz-pi-extensions` with Exa + Brave Search and no Perplexity/Gemini support.

**Architecture:** Vendor the useful non-Gemini upstream modules under `extensions/pi-web-access/`, add a shared `.env` config loader, and route `web_search` through Exa or Brave. Keep fetch/content storage capabilities that do not depend on Perplexity or Gemini.

**Tech Stack:** Pi extension TypeScript, TypeBox, Node fetch, Exa API/MCP, Brave Search API, Readability/linkedom/Turndown/unpdf.

---

### Task 1: Config and provider tests [USER-REQ]

**Requirement:** Use `.env` for Exa and Brave API keys, remove Perplexity/Gemini providers, add Brave provider.

**Files:**
- Create: `test/pi-web-access-config.test.mjs`
- Create/Modify: `extensions/pi-web-access/config.ts`, `extensions/pi-web-access/brave.ts`, `extensions/pi-web-access/search.ts`

- [ ] Write failing tests that prove `.env` exposes `EXA_API_KEY` and `BRAVE_API_KEY` and provider normalization only accepts `auto`, `exa`, `brave`.
- [ ] Run: `timeout 60s npm test -- test/pi-web-access-config.test.mjs` and confirm RED.
- [ ] Implement config/provider code.
- [ ] Run the same command and confirm GREEN.

### Task 2: Vendor non-Gemini content tools [USER-REQ]

**Requirement:** Add the extension under `sz-pi-extensions`; remove Perplexity and Gemini entirely.

**Files:**
- Create: `extensions/pi-web-access/*`
- Modify: `package.json`

- [ ] Copy/adapt non-Gemini modules from upstream: activity, code search, curator, Exa, extraction, GitHub, PDF, RSC, storage, utils.
- [ ] Do not include: `perplexity.ts`, `gemini-*`, `chrome-cookies.ts`, `youtube-extract.ts`, `video-extract.ts`.
- [ ] Add runtime dependencies required by retained modules.
- [ ] Run: `timeout 120s npm test`.

### Task 3: Extension registration and docs [USER-REQ]

**Requirement:** Expose usable Pi tools via the new extension.

**Files:**
- Modify: `extensions/pi-web-access/index.ts`
- Create/Modify: `README.md` or package docs if present.

- [ ] Register `web_search`, `code_search`, `fetch_content`, and `get_search_content`.
- [ ] Ensure schemas advertise provider choices `auto | exa | brave` only.
- [ ] Document `.env` keys: `EXA_API_KEY`, `BRAVE_API_KEY`.
- [ ] Run: `timeout 120s npm test` and `timeout 120s npm install --package-lock-only` if dependencies changed.
