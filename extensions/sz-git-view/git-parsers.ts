// ── Commit Graph Types ───────────────────────────────────────────────

export interface CommitNode {
  hash: string;        // short hash (7 chars)
  fullHash: string;    // full SHA
  lane: number;        // SVG lane/column (assigned during layout)
  color: string;       // branch color
  parents: string[];   // parent hashes
  children: string[];  // child hashes (for rendering connector lines)
  message: string;     // first line of commit message
  author: string;
  date: string;        // ISO 8601
  relativeDate: string; // e.g., "3 hours ago"
  refs: string[];      // branch/tag names pointing here
  isMerge: boolean;
}

// ── Diff Tree Types ───────────────────────────────────────────────────

export interface StatusEntry {
  status: string;     // XY from porcelain: " M", "??", "A ", etc.
  path: string;
  originalPath?: string; // for renamed files
}

export interface DiffTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  status?: string;     // only for files
  children?: DiffTreeNode[];
  added?: number;      // only for files, after git diff --stat
  deleted?: number;
}

// ── Worktree Types ────────────────────────────────────────────────────

export interface WorktreeEntry {
  path: string;
  branch: string;      // current branch or "detached" + hash
  head: string;        // full HEAD SHA
  bare: boolean;
  dirty: boolean;
}

// ── Parsers ───────────────────────────────────────────────────────────

// git log --all --topo-order --parents --format="%H§%h§%an§%aI§%ar§%D§%P§%s" -30
export function parseGitLog(output: string): CommitNode[] {
  if (!output.trim()) return [];
  return output.trim().split("\n").map(line => {
    const parts = line.split("§");
    // format: %H§%h§%an§%aI§%ar§%D§%P§%s
    const fullHash = parts[0] || "";
    const hash = parts[1] || fullHash.slice(0, 7);
    const author = parts[2] || "";
    const date = parts[3] || "";
    const relativeDate = parts[4] || "";
    const refsStr = parts[5] || "";
    const parentsStr = parts[6] || "";
    const message = parts.slice(7).join("§");

    const parentList = parentsStr ? parentsStr.split(" ").filter(p => p) : [];

    return {
      hash,
      fullHash,
      lane: 0,
      color: "",
      parents: parentList,
      children: [],
      message,
      author,
      date,
      relativeDate,
      refs: refsStr && refsStr !== "" ? refsStr.split(", ").map(r => r.trim()) : [],
      isMerge: parentList.length > 1,
    };
  });
}

// git status --porcelain -uall
export function parseGitStatus(output: string): StatusEntry[] {
  if (!output.trim()) return [];
  return output.trim().split("\n").map(line => {
    const status = line.slice(0, 2).trim();
    const rest = line.slice(3);
    // Handle renames: "R  old -> new"
    const arrowIdx = rest.indexOf(" -> ");
    if (arrowIdx > -1) {
      return { status, path: rest.slice(arrowIdx + 4), originalPath: rest.slice(0, arrowIdx) };
    }
    // Handle quoted paths
    let path = rest;
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1).replace(/\\"/g, '"');
    }
    return { status, path };
  });
}

// git worktree list --porcelain
export function parseGitWorktree(output: string): WorktreeEntry[] {
  if (!output.trim()) return [];
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of output.trim().split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push(current as WorktreeEntry);
      current = { path: line.slice(9), dirty: false };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7);
    } else if (line.startsWith("bare")) {
      current.bare = true;
    } else if (line.startsWith("detached")) {
      current.branch = `detached@${current.head?.slice(0, 7) || "?"}`;
    }
  }
  if (current.path) entries.push(current as WorktreeEntry);
  return entries;
}
