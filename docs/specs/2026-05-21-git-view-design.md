# SZ Git View — Design Spec

## User Requirements

Items the user explicitly stated, chose, or confirmed during brainstorming.

- **Extension creates a local web app served via HTTP+WebSocket server:** user's initial request (rejected static HTML file approach in favor of approach 1 — WebSocket push)
- **Auto-launch on session start, auto-update on turn_end and tool_execution_end:** user chose option A for trigger events ("on every turn end and after file-changing tool executions")
- **Visual commit graph like VS Code's Git Graph (not ASCII):** user explicitly rejected pure text graph; chose option A for graph style (visual SVG graph, 10 commits across all branches)
- **Diff files section with expandable/collapsible inline diffs like Codex Desktop:** user chose option B ("file list plus inline diff preview for each changed file") and specified Codex-style expand/collapse
- **Worktree list showing paths and current branches:** user chose option B ("list of all worktree paths and their current branches")
- **Self-contained HTML with zero external dependencies:** user chose option A ("no dependencies, served by minimal HTTP server from the pi extension")
- **Each section scrolls independently:** user chose "former" when asked about independent scroll areas vs unified page scroll
- **Dark mode / dark-themed UI:** user confirmed preference for dark mode

## Agent Design Decisions

Everything the agent inferred, recommended, or filled in to complete the design. Each decision notes which user requirement it serves.

### Architecture

- **HTTP + WebSocket server using Node.js built-in modules (`http`, no framework):** serves "self-contained HTML with zero dependencies" requirement. Eliminates dependency on Express, ws, or any npm package beyond Node.js stdlib.
- **Server bound to `127.0.0.1` with auto-port-discovery:** serves "local web app" requirement. Picks next available port if default is in use; prints URL to pi terminal so user can configure CMux pane.
- **Server lifecycle tied to `session_start`/`session_end` events:** serves "auto-launch on session start" requirement. Starts on session_start, shuts down on session_end.
- **Port stored in extension-scoped variable:** enables consistent URL reporting and cleanup.

### Data Collection

- **Three git commands run in parallel via `execSync` on every refresh:**
  - `git log --all --topo-order --parents --format=... -N` for commit graph data
  - `git status --porcelain -uall` for changed files
  - `git worktree list --porcelain` for worktree list
- **On-demand diff fetching:** serves "expandable inline diffs" requirement. User clicks a file → WebSocket message → server runs `git diff -- <filepath>` → pushes result. Diffs are never pre-fetched, keeping initial data payload small.
- **Refresh triggers:** `turn_end` + `tool_execution_end` (for bash/edit/write tools — same filter as sz-pi-footer), plus initial push on connection.

### Graph Rendering

- **SVG-based graph with column assignment algorithm:** serves "visual commit graph like VS Code" requirement. Walks commits newest-to-oldest, assigns each branch tip a free lane (column), frees lanes when a branch's last commit is processed. Merge commits connect lanes with quadratic bezier curves.
- **Graph features:**
  - Colored lanes (consistent color per branch)
  - Hover: tooltip with full hash, author, relative date
  - Click: expand commit detail (full message, stats)
  - Infinite scroll upward: load older commits in pages of 30
  - Branch/tag labels next to tip commits

### Diff Tree

- **Tree view with collapsible directory nodes:** serves "expandable/collapsible like Codex" requirement. Files grouped by directory; directories toggle open/closed.
- **Per-file badges:** status code (M/A/D/R), colored +/- line count
- **Inline diff expansion:** click a file → server fetches `git diff` → rendered with green (+)/red (-) lines, monospaced font, horizontal scroll for long lines
- **Clean state:** shows "Working tree clean" when no changes

### Worktree Section

- **List view with path, branch, and dirty/clean indicator:** serves "list of worktree paths and current branches" requirement.
- **Green dot:** clean. **Yellow dot:** dirty (uncommitted changes detected).
- **Primary worktree labeled** `(main)` if it's the only one.

### UI Layout

- **Three independent scroll areas** (commits, changes, worktrees): serves "each section scrolls independently" requirement. Each section has `max-height` and `overflow-y: auto`.
- **Top bar:** repo name (from directory name), green "● connected" status badge that briefly pulses on data refresh.
- **Dark theme** with colors matching terminal aesthetic: deep navy/black backgrounds (`#0d0d1a`), muted text (`#bdc3c7`, `#7f8c8d`), accent colors for git status (green=added, red=deleted, yellow=modified).
- **No external CSS framework or JS library:** all styles and interactivity in a single HTML string embedded in the extension file.

### Error Handling

- **Not a git repo:** show "Not a git repository" message, stop refresh attempts.
- **Git not installed:** show "git command not found."
- **Empty repo (no commits):** Commits section shows "No commits yet." Changes shows untracked files.
- **Large repos (>200 changed files):** show "Truncated — showing first 200 files" indicator.
- **Server crash / CMux pane closed:** server stays alive; WebSocket reconnection on the client side re-requests full data push.

### Port Conflict Resolution

- **Auto-discovery:** try default port (configurable, default 61589). If `EADDRINUSE`, increment port and retry up to 10 times. Print final URL to pi terminal on `session_start`.

### File Structure

- **New file:** `extensions/sz-git-view.ts` — contains extension logic, HTTP server, WebSocket handler, git command wrappers, and the embedded HTML template.
- **No changes to existing files** (`sz-pi-footer.ts`, `exit-command.ts`, `package.json`).

### Testing

- **Git data parsing functions are pure:** `parseGitLog()`, `parseGitStatus()`, `parseGitWorktree()` take string input → structured output. Can be unit tested with snapshot inputs.
- **HTML rendering:** manual smoke testing against this repo (`sz-pi-extensions`).
- **No test file required initially** (the extension itself can be tested by running pi in the repo).

---

## Open Questions (Resolved During Brainstorming)

- **How does CMux display the side view?** → Built-in browser in split pane, loads HTTP URL.
- **How is the view triggered?** → Auto-start, auto-update (no manual command).
- **What triggers refresh?** → turn_end + tool_execution_end (matching footer rhythm).
- **How many commits?** → 10 initial, infinite scroll for more (agent decision).
- **Graph style?** → Visual SVG graph, not ASCII (user requirement).
- **Diff depth?** → On-demand expandable inline diffs (user requirement).
- **Worktree detail?** → Path + branch per worktree (user requirement).
- **Dependencies?** → Zero external (user requirement).
- **Scroll model?** → Per-section independent scroll (user requirement).
- **Color scheme?** → Dark mode (user preference).
