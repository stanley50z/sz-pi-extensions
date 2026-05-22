// extensions/sz-git-view/collector.ts
import { execSync } from "node:child_process";
import { parseGitLog, parseGitStatus, parseGitWorktree } from "./git-parsers.ts";
import type { CommitNode, StatusEntry, WorktreeEntry } from "./git-parsers.ts";

export interface GitData {
  repoName: string;
  commits: CommitNode[];
  status: StatusEntry[];
  worktrees: WorktreeEntry[];
  error?: string;
}

const GIT_TIMEOUT = 3000;
const COMMIT_COUNT = 30;

export function collectAll(): GitData {
  try {
    execSync("git rev-parse --git-dir", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_TIMEOUT,
    });
  } catch {
    return {
      repoName: "",
      commits: [],
      status: [],
      worktrees: [],
      error: "Not a git repository",
    };
  }

  const repoName = getRepoName();
  const commits = collectCommits();
  const status = collectStatus();
  const worktrees = collectWorktrees();

  return { repoName, commits, status, worktrees };
}

export function getDiffForPath(filePath: string): string | null {
  try {
    return execSync(`git diff -- "${filePath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
      maxBuffer: 1024 * 1024, // 1MB
    });
  } catch {
    return null;
  }
}

function getRepoName(): string {
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_TIMEOUT,
    }).trim();
    const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch { /* no remote */ }
  try {
    const gitDir = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_TIMEOUT,
    }).trim();
    return gitDir.split("/").pop() || "unknown";
  } catch {
    return "unknown";
  }
}

function collectCommits(): CommitNode[] {
  try {
    const out = execSync(
      `git log --all --topo-order --parents --format="%H%x1f%h%x1f%an%x1f%aI%x1f%ar%x1f%D%x1f%P%x1f%s%x1f%b%x1e" -${COMMIT_COUNT}`,
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: GIT_TIMEOUT,
      }
    ).trim();
    if (!out) return [];

    const commits = parseGitLog(out);
    assignLanes(commits);
    return commits;
  } catch {
    return [];
  }
}

function collectStatus(): StatusEntry[] {
  try {
    const out = execSync("git status --porcelain -uall", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_TIMEOUT,
    });
    return out.trim() ? parseGitStatus(out) : [];
  } catch {
    return [];
  }
}

function collectWorktrees(): WorktreeEntry[] {
  try {
    const out = execSync("git worktree list --porcelain", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_TIMEOUT,
    }).trim();
    return out ? parseGitWorktree(out) : [];
  } catch {
    return [];
  }
}

// ── Lane Assignment Algorithm ─────────────────────────────────────────

const BRANCH_COLORS = [
  "#3498db", "#2ecc71", "#e74c3c", "#f39c12", "#9b59b6",
  "#1abc9c", "#e67e22", "#e91e63", "#00bcd4", "#8bc34a",
];

function assignLanes(commits: CommitNode[]): void {
  if (commits.length === 0) return;

  // Map full hash -> CommitNode for quick lookup
  const hashMap = new Map<string, CommitNode>();
  for (const c of commits) hashMap.set(c.fullHash, c);

  // Populate children from parents
  for (const c of commits) {
    for (const p of c.parents) {
      const parent = hashMap.get(p);
      if (parent) parent.children.push(c.fullHash);
    }
  }

  // Assign lanes: process newest to oldest
  const lanes: (string | null)[] = []; // lane index -> reserved commit hash
  const laneColors: string[] = [];
  let colorIdx = 0;

  for (const commit of commits) {
    // Find existing lane for this commit (if it was reserved by a child)
    let assignedLane = lanes.findIndex(l => l === commit.fullHash);

    if (assignedLane === -1) {
      // New branch — find a free lane
      assignedLane = lanes.findIndex(l => l === null);
      if (assignedLane === -1) {
        // No free lane, add a new one
        assignedLane = lanes.length;
        lanes.push(null);
        laneColors.push(BRANCH_COLORS[colorIdx % BRANCH_COLORS.length]);
        colorIdx++;
      }
    }

    // Free this lane and reserve it for the first parent
    lanes[assignedLane] = commit.parents[0] || null;

    // For additional parents (merge), reserve their lanes from children
    for (let i = 1; i < commit.parents.length; i++) {
      const parentHash = commit.parents[i];
      let parentLane = lanes.findIndex(l => l === parentHash);
      if (parentLane === -1) {
        parentLane = lanes.findIndex(l => l === null);
        if (parentLane === -1) {
          parentLane = lanes.length;
          lanes.push(null);
          laneColors.push(BRANCH_COLORS[colorIdx % BRANCH_COLORS.length]);
          colorIdx++;
        }
      }
      lanes[parentLane] = parentHash;
    }

    commit.lane = assignedLane;
    commit.color = laneColors[assignedLane];
  }
}
