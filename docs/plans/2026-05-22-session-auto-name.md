# Session Auto Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Priority rule:** Tasks tagged `[USER-REQ]` implement non-negotiable user requirements. Tasks tagged `[AGENT-DECISION]` implement flexible agent design decisions. If a conflict arises during implementation, agent decisions yield to user requirements. If a user requirement cannot be met, stop and surface to the user.

**Goal:** Add a pi extension that automatically generates and persists a concise session name after the second user prompt receives an assistant answer.

**Architecture:** Implement a focused extension in `extensions/session-auto-name.ts` that listens to `agent_end`, inspects the current branch, and performs a direct `complete()` call with the active model. The extension writes only session metadata via `pi.setSessionName()` and does not inject user or assistant messages into conversation history.

**Tech Stack:** TypeScript pi extension API, `@earendil-works/pi-ai` `complete()`, Node test runner.

---

### Task 1: Add auto naming behavior [USER-REQ]

**Requirement:** Automatically name the session after the second user prompt has received an answer, using AI, without adding a visible conversation turn.

**Files:**
- Create: `extensions/session-auto-name.ts`
- Test: `test/session-auto-name.test.mjs`

- [ ] **Step 1: Write failing tests**
  - Verify no name is generated after only one user prompt.
  - Verify a direct model call runs after two user prompts and `pi.setSessionName()` is called with sanitized output.
  - Verify the extension does not call `pi.sendUserMessage()` or `pi.sendMessage()`.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `node --test test/session-auto-name.test.mjs` with a 60s process timeout.
Expected: FAIL because the files/extension do not exist yet.

- [ ] **Step 3: Implement minimal extension**
  - Export a dependency-injected `createSessionAutoNameExtension()` for tests.
  - Default export wires real `complete()`.
  - On `agent_end`, inspect `ctx.sessionManager.getBranch()`.
  - If no existing `pi.getSessionName()` and at least two user messages plus one assistant answer exist, call `complete(ctx.model, ...)` with a short title prompt.
  - Use `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` for auth.
  - Sanitize the response and call `pi.setSessionName(title)`.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `node --test test/session-auto-name.test.mjs` with a 60s process timeout.
Expected: PASS.

### Task 2: Verify integration with the extension stack [USER-REQ]

**Requirement:** Add the extension to this extension stack.

**Files:**
- Create: `extensions/session-auto-name.ts`
- Test: `test/session-auto-name.test.mjs`

- [ ] **Step 1: Verify package extension discovery covers the new file**
  - Confirm `package.json` has `pi.extensions: ["./extensions"]`, so top-level extension files are included.

- [ ] **Step 2: Run the full test suite**

Run: `npm test` with a 120s process timeout.
Expected: PASS.
