import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

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
const execGit = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execGit("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    timeout: GIT_TIMEOUT,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function countTextLines(path: string): Promise<number> {
  const content = await readFile(path);
  if (content.includes(0) || content.length === 0) return 0;

  let lines = content.at(-1) === 10 ? 0 : 1;
  for (const byte of content) {
    if (byte === 10) lines++;
  }
  return lines;
}

// Collect footer totals without blocking terminal input during background refreshes.
export async function collectDiffSummary(cwd: string): Promise<GitDiffSummary | null> {
  try {
    const repoRoot = (await runGit(["rev-parse", "--show-toplevel"], cwd)).trim();
    let output: string;
    try {
      output = await runGit(["diff", "--numstat", "HEAD", "--"], repoRoot);
    } catch {
      output = await runGit(["diff", "--numstat", "--cached", "--"], repoRoot);
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
    const untracked = (await runGit(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot))
      .split("\0")
      .filter(Boolean);
    for (const path of untracked) {
      files.push({ path, added: await countTextLines(join(repoRoot, path)), deleted: 0 });
    }

    return {
      added: files.reduce((total, file) => total + file.added, 0),
      deleted: files.reduce((total, file) => total + file.deleted, 0),
      files,
    };
  } catch {
    return null;
  }
}
