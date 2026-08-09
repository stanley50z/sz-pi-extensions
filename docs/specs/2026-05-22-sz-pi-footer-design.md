# SZ Pi Footer Design Spec

## User Requirements

- Show the current working directory on the footer's first line: requested during the footer layout discussion.
- Show the git branch next to the working directory when available: requested as part of the customized footer layout and inherited from the previous footer behavior.
- Show the explicit pi session name in the middle of the footer's first line when set: requested when investigating why the session name was not visible after resume, then refined to place the session name in the center.
- Keep the session name geometrically centered when space permits; a long cwd or branch may push it right toward the fixed-width token-speed segment.
- Show token speed on the first line, including before the first prompt is sent: requested as part of moving speed out of the stats/model line, then refined to show `0 tok/s` when initiating a session.
- Align the right-hand status sections with the editor divider's right edge, with no trailing footer padding: this supersedes the earlier request for padding after token speed.
- Keep token speed visible after generation completes: explicitly requested as “the token speed should stay on and retain the last value when the generation is done, instead of disappearing.”
- Preserve the default-style usage/cost/context/model footer information: requested by comparing against pi's default footer and asking for similar richer footer behavior.
- Show git diff stats centered in the footer and clickable when Git View provides a URL: requested as part of the Git View/footer integration.
- Show extension statuses on the right side of the stats line: requested through the fast-mode/status integration work.
- Show both five-hour and weekly ChatGPT subscription usage in the center of the second line: requested after restoring subscription visibility; unavailable windows remain visible with an em dash.
- Keep the calculated API-equivalent cost at three significant figures, remove the redundant `(sub)` suffix, and show `API` in the center when API-key billing is active instead of subscription usage.
- Compact the bottom-right OpenAI identity to `(OpenAI) 5.6 Sol @high ⚡fast` instead of raw provider/model IDs, parenthesized reasoning, and a spaced fast-mode label.

## Agent Design Decisions

- Use a two-line footer: serves the requirements to show path/session/speed plus usage/model/diff details without overcrowding one line. Line 1 contains location/session/speed; line 2 contains usage, diff, model, reasoning, and statuses.
- Use `ctx.sessionManager.getCwd()` when available and fall back to `ctx.cwd`: serves accurate resumed-session display because session cwd can differ from process cwd.
- Compact the home directory to `~`: serves readable cwd display and matches pi footer conventions.
- Append branch as `(<branch>)` after cwd: serves branch visibility while keeping the format familiar.
- Start the session name at the geometric center when that does not overlap cwd/branch or token speed; otherwise clamp it between those segments, allowing a long location to push it right.
- Treat pi “session name” as only the explicit `/name` or `pi.setSessionName()` value: serves correctness with pi's session model; `/resume` fallback previews are not shown as names.
- Format token speed as `<n> tok/s`, rounded to an integer at 100+ tok/s and one decimal below 100 tok/s, with `0 tok/s` before any measured assistant response: serves compact display and initial-session visibility.
- Retain the last non-zero token speed until session reset: serves the requirement that speed stays visible after generation and after footer refreshes.
- Reset token speed on `session_start`: prevents stale speed values leaking between sessions.
- Add no trailing spaces after the right-aligned speed or model/status text: the final visible character aligns with the editor divider's right edge.
- Compute totals from `getEntries()` when available, otherwise `getBranch()`: serves default-like cumulative usage totals across the session while preserving compatibility.
- Include input, output, cache read, cache write, calculated cost, and context usage in compact token units: serves default-style footer parity.
- Format calculated cost to three significant figures for both subscription and API-key sessions; subscription usage in the center already identifies subscription authentication, so omit `(sub)` from the cost.
- Display context as `ctx:<percent>%`, rounded to an integer: serves compact context visibility without exposing the model's maximum context window or auto-compaction label.
- Display provider prefix only when multiple providers are available; map `openai-codex` to `OpenAI`: serves model clarity without wasting width or exposing an implementation-facing provider ID.
- Map `gpt-5.6-sol` to `5.6 Sol` and `gpt-5.6-luna` to `5.6 Luna` in the footer while preserving unknown model IDs verbatim.
- Display reasoning as `@<level>` beside the model: serves compact visibility into the current reasoning mode.
- Render fast mode as `⚡fast` without an internal gap.
- Sanitize extension status text to one line: serves footer stability by preventing status newlines, tabs, or excess spaces from breaking layout.
- Center git diff stats and ChatGPT subscription usage when there is enough room, otherwise omit the centered segment and preserve left/right stats: serves layout robustness under narrow widths.
- Format subscription usage as `5h:<percent> wk:<percent>`; use `—` when Codex does not provide a window, `…` while loading, and `!` when retrieval fails. For API-key authentication, place `API` in the same centered slot instead.
- Read limits from Codex app-server's `account/rateLimits/read` method on session start, model selection, and completed turns: serves current ChatGPT subscription usage without exposing credentials.
- Use OSC-8 hyperlinks for git diff stats when a Git View URL is available: serves quick navigation from footer to Git View.
- Refresh footer on `thinking_level_select` and after file-changing tool executions (`bash`, `edit`, `write`): serves timely updates for reasoning level and git diff stats.

## Component Responsibilities

### `extensions/sz-pi-footer.ts`

The footer extension owns all runtime behavior for installing and refreshing the custom footer.

Responsibilities:

- Subscribe to session lifecycle events and install the footer on session start.
- Track the active Git View URL from the extension event bus.
- Fetch ChatGPT subscription windows through the Codex app-server protocol and track updates from the extension event bus.
- Track turn timing and compute last output token speed.
- Read git diff shortstat from the current repository.
- Render the two-line footer with width-aware truncation and padding.
- Preserve compatibility with optional pi APIs by checking method availability before calling newer methods.

### `lib/codex-rate-limits.ts`

The Codex rate-limit client owns the short-lived app-server session used to read subscription windows.

Responsibilities:

- Start `codex app-server --stdio` and complete its initialize handshake.
- Request `account/rateLimits/read` without reading or exposing credential files.
- Validate and return primary/secondary windows by their reported durations.
- Apply explicit request timeouts and terminate the child process after each read.

### `test/sz-pi-footer.test.mjs`

The footer test suite verifies user-visible footer behavior with fake pi contexts and temporary git repositories.

Responsibilities:

- Verify two-line rendering and default-style stats/status preservation.
- Verify first-line path, branch, session name, and token speed layout.
- Verify token speed persists after footer refresh.
- Verify short locations keep session names centered while long paths and branches push them right only when needed.
- Verify git diff stats are shown and hyperlinked when Git View URL is known.
- Verify five-hour and weekly subscription usage is centered and a missing five-hour window renders as `—`.
- Verify API-key sessions show centered `API`, omit subscription limits, format cost to three significant figures, and never show `(sub)`.
- Verify the compact OpenAI provider, model, reasoning, and fast-mode labels in the bottom-right segment.

## Data Flow

1. `session_start` stores the extension context, refreshes the Git View URL, resets token speed, installs the footer, and starts a subscription-limit read for ChatGPT-authenticated OpenAI Codex models.
2. The rate-limit client initializes Codex app-server, calls `account/rateLimits/read`, validates its windows, and emits `sz-codex-rate-limits:update`.
3. `turn_start` records the current timestamp.
4. `turn_end` computes output tokens per second and refreshes subscription limits after the completed response.
5. Git View emits `sz-git-view:url`; the footer stores the URL and reinstalls itself so future renders hyperlink diff stats.
6. Footer `render(width)` builds line 1 from left-aligned cwd/branch, a preferably centered session name clamped to avoid overlap, and right-aligned last speed or `0 tok/s`.
7. Footer `render(width)` builds line 2 from cumulative usage, three-significant-figure cost, integer `ctx:<percent>%`, centered git plus subscription usage or `API`, model/provider/reasoning, and extension statuses.
8. Width calculations use `visibleWidth()` and `truncateToWidth()` so wide Unicode and ANSI styling do not exceed terminal width.

## Error Handling

- Git commands are wrapped in `try/catch`; non-git directories or command failures return no diff stats instead of failing footer rendering.
- Missing optional APIs (`getEntries`, `getCwd`, `getSessionName`, `getContextUsage`, `getAvailableProviderCount`) fall back to older available values.
- Empty or malformed Git View URL events are ignored; explicit `null` clears the URL.
- Token speed is not overwritten by zero-token or invalid elapsed-time turns; missing speed renders as `0 tok/s`.
- Status text is sanitized before rendering to prevent multi-line footer output.
- Codex protocol, timeout, and validation failures render both limit slots as `!`; a legitimately absent window renders as `—`.

## Testing Strategy

- Use Node's built-in test runner.
- Use temporary git repositories to test clean and dirty diff stats.
- Use fake pi objects to drive lifecycle events without launching interactive pi.
- Use a fake JSONL app-server process to verify the real initialize/request protocol boundary.
- Assert rendered strings rather than implementation details.
- Run focused footer tests with `node --test test/sz-pi-footer.test.mjs`.
- Run full regression suite with `npm test`.

## Non-Goals

- Do not display `/resume` fallback previews as session names; only explicit session names are shown.
- Do not persist token speed across sessions.
- Do not replace Git View; only link to it when its URL is available.
- Do not attempt to perfectly mirror pi's internal default footer implementation; preserve the user-visible information needed for this extension stack.
