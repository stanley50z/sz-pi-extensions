import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface GitDiffFile {
  path: string;
  added: number;
  deleted: number;
}

export interface GitDiffSummary {
  added: number;
  deleted: number;
  files: GitDiffFile[];
}

const GIT_TIMEOUT = 3000;

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: GIT_TIMEOUT,
    maxBuffer: 1024 * 1024,
  });
}

function countTextLines(path: string): number {
  const content = readFileSync(path);
  if (content.includes(0) || content.length === 0) return 0;

  let lines = content.at(-1) === 10 ? 0 : 1;
  for (const byte of content) {
    if (byte === 10) lines++;
  }
  return lines;
}

export function collectDiffSummary(cwd: string): GitDiffSummary | null {
  try {
    const repoRoot = runGit(["rev-parse", "--show-toplevel"], cwd).trim();
    let output: string;
    try {
      output = runGit(["diff", "--numstat", "HEAD", "--"], repoRoot);
    } catch {
      output = runGit(["diff", "--numstat", "--cached", "--"], repoRoot);
    }
    const files = output.trim()
      ? output.trimEnd().split("\n").map((line) => {
          const [added, deleted, ...pathParts] = line.split("\t");
          return {
            path: pathParts.join("\t"),
            added: added === "-" ? 0 : Number(added),
            deleted: deleted === "-" ? 0 : Number(deleted),
          };
        })
      : [];
    const untracked = runGit(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot)
      .split("\0")
      .filter(Boolean)
      .map((path) => ({ path, added: countTextLines(join(repoRoot, path)), deleted: 0 }));
    files.push(...untracked);

    return {
      added: files.reduce((total, file) => total + file.added, 0),
      deleted: files.reduce((total, file) => total + file.deleted, 0),
      files,
    };
  } catch {
    return null;
  }
}
