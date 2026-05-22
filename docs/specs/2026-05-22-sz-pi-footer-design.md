# SZ Pi Footer Design Spec

## User Requirements

- Show the current working directory on the footer's first line: requested during the footer layout discussion.
- Show the git branch next to the working directory when available: requested as part of the customized footer layout and inherited from the previous footer behavior.
- Show the explicit pi session name in the middle of the footer's first line when set: requested when investigating why the session name was not visible after resume, then refined to place the session name in the center.
- Keep the session name visible even when the path is long: requested by asking that the session name remain displayed after reload/resume and clarified through long-name behavior.
- Show token speed on the first line, including before the first prompt is sent: requested as part of moving speed out of the stats/model line, then refined to show `0 tok/s` when initiating a session.
- Add right-side padding after token speed on the first line: explicitly requested as “add similar right side padding to the first line, after the token speed.”
- Keep token speed visible after generation completes: explicitly requested as “the token speed should stay on and retain the last value when the generation is done, instead of disappearing.”
- Preserve the default-style usage/cost/context/model footer information: requested by comparing against pi's default footer and asking for similar richer footer behavior.
- Show git diff stats centered in the footer and clickable when Git View provides a URL: requested as part of the Git View/footer integration.
- Show extension statuses on the right side of the stats line: requested through the fast-mode/status integration work.

## Agent Design Decisions

- Use a two-line footer: serves the requirements to show path/session/speed plus usage/model/diff details without overcrowding one line. Line 1 contains location/session/speed; line 2 contains usage, diff, model, reasoning, and statuses.
- Use `ctx.sessionManager.getCwd()` when available and fall back to `ctx.cwd`: serves accurate resumed-session display because session cwd can differ from process cwd.
- Compact the home directory to `~`: serves readable cwd display and matches pi footer conventions.
- Append branch as `(<branch>)` after cwd: serves branch visibility while keeping the format familiar.
- Render the session name as a separate centered segment on line 1: serves the requirement to keep cwd/branch on the left, session identity in the middle, and token speed on the right.
- Treat pi “session name” as only the explicit `/name` or `pi.setSessionName()` value: serves correctness with pi's session model; `/resume` fallback previews are not shown as names.
- Format token speed as `<n> tok/s`, rounded to an integer at 100+ tok/s and one decimal below 100 tok/s, with `0 tok/s` before any measured assistant response: serves compact display and initial-session visibility.
- Retain the last non-zero token speed until session reset: serves the requirement that speed stays visible after generation and after footer refreshes.
- Reset token speed on `session_start`: prevents stale speed values leaking between sessions.
- Add two trailing spaces to right-aligned speed and model/status text: serves the right-side padding requirement and keeps the content away from the terminal edge.
- Compute totals from `getEntries()` when available, otherwise `getBranch()`: serves default-like cumulative usage totals across the session while preserving compatibility.
- Include input, output, cache read, cache write, cost, subscription indicator, and context usage in compact token units: serves default-style footer parity.
- Display context as `<percent>%/<window> (auto)` or `?/<window> (auto)`: serves context visibility while indicating auto-compaction mode.
- Display provider prefix only when multiple providers are available: serves model clarity without wasting width in single-provider setups.
- Display reasoning level as `(<level>)` beside the model: serves visibility into current thinking/reasoning mode.
- Sanitize extension status text to one line: serves footer stability by preventing status newlines, tabs, or excess spaces from breaking layout.
- Center git diff stats when there is enough room, otherwise omit the centered diff and preserve left/right stats: serves layout robustness under narrow widths.
- Use OSC-8 hyperlinks for git diff stats when a Git View URL is available: serves quick navigation from footer to Git View.
- Refresh footer on `thinking_level_select` and after file-changing tool executions (`bash`, `edit`, `write`): serves timely updates for reasoning level and git diff stats.

## Component Responsibilities

### `extensions/sz-pi-footer.ts`

The footer extension owns all runtime behavior for installing and refreshing the custom footer.

Responsibilities:

- Subscribe to session lifecycle events and install the footer on session start.
- Track the active Git View URL from the extension event bus.
- Track turn timing and compute last output token speed.
- Read git diff shortstat from the current repository.
- Render the two-line footer with width-aware truncation and padding.
- Preserve compatibility with optional pi APIs by checking method availability before calling newer methods.

### `test/sz-pi-footer.test.mjs`

The footer test suite verifies user-visible footer behavior with fake pi contexts and temporary git repositories.

Responsibilities:

- Verify two-line rendering and default-style stats/status preservation.
- Verify first-line path, branch, session name, and token speed layout.
- Verify token speed persists after footer refresh.
- Verify session names remain visible with long paths.
- Verify git diff stats are shown and hyperlinked when Git View URL is known.

## Data Flow

1. `session_start` stores the extension context, refreshes the Git View URL from global state, resets token speed, and installs the footer.
2. `turn_start` records the current timestamp.
3. `turn_end` finds the latest assistant message output token count, computes output tokens per second, and stores it if positive.
4. Git View emits `sz-git-view:url`; the footer stores the URL and reinstalls itself so future renders hyperlink diff stats.
5. Footer `render(width)` builds line 1 from left-aligned cwd/branch, centered session name, and right-aligned last speed or `0 tok/s`.
6. Footer `render(width)` builds line 2 from cumulative usage, git diff stats, model/provider/reasoning, and extension statuses.
7. Width calculations use `visibleWidth()` and `truncateToWidth()` so wide Unicode and ANSI styling do not exceed terminal width.

## Error Handling

- Git commands are wrapped in `try/catch`; non-git directories or command failures return no diff stats instead of failing footer rendering.
- Missing optional APIs (`getEntries`, `getCwd`, `getSessionName`, `getContextUsage`, `getAvailableProviderCount`) fall back to older available values.
- Empty or malformed Git View URL events are ignored; explicit `null` clears the URL.
- Token speed is not overwritten by zero-token or invalid elapsed-time turns; missing speed renders as `0 tok/s`.
- Status text is sanitized before rendering to prevent multi-line footer output.

## Testing Strategy

- Use Node's built-in test runner.
- Use temporary git repositories to test clean and dirty diff stats.
- Use fake pi objects to drive lifecycle events without launching interactive pi.
- Assert rendered strings rather than implementation details.
- Run focused footer tests with `node --test test/sz-pi-footer.test.mjs`.
- Run full regression suite with `npm test`.

## Non-Goals

- Do not display `/resume` fallback previews as session names; only explicit session names are shown.
- Do not persist token speed across sessions.
- Do not replace Git View; only link to it when its URL is available.
- Do not attempt to perfectly mirror pi's internal default footer implementation; preserve the user-visible information needed for this extension stack.
