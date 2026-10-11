/**
 * Branch management utilities for multi-agent orchestration.
 *
 * Workers get isolated git branches. The master creates, verifies,
 * and merges worker branches. All operations use git commands.
 *
 * Each function accepts an optional `cwd` to run git from a specific
 * working directory (the repo root). When omitted or when git is not
 * available (non-git directory, no git binary), all operations fall
 * back gracefully — returning empty/no-op results without crashing.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Detect the nearest ancestor git repo from a list of file paths.
 * Returns the first repo root found, or undefined if none of the paths
 * belong to a git repo.
 */
export function findRepoRoot(files: string[]): string | undefined {
  for (const file of files) {
    let dir = path.dirname(path.resolve(file));
    while (dir !== path.dirname(dir)) {
      if (existsSync(path.join(dir, ".git"))) return dir;
      dir = path.dirname(dir);
    }
  }
  return undefined;
}

function isGitAvailable(cwd?: string): boolean {
  if (!cwd) return false;
  try {
    execSync("git rev-parse --git-dir", { cwd, stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if git is available at the given directory. Returns true if
 * a git repo exists and the git binary works.
 */
export function gitAvailable(cwd?: string): boolean {
  return isGitAvailable(cwd);
}

// ── Branch operations (all accept optional cwd) ────────────────────────────

/**
 * Create a worker branch from the base branch.
 * Returns the branch name, or a generated placeholder if no git repo.
 *
 * The ref is created with `git branch`, which touches no worktree: HEAD, the
 * index and the files are left exactly as the caller had them. A checkout here
 * would move the caller onto the worker branch, so the caller's next commit
 * would land on the worker's work. When the base ref is missing, the branch is
 * created from HEAD instead, still without switching to it.
 */
export function createWorkerBranch(
  workerId: string,
  slug: string,
  baseBranch = "main",
  cwd?: string,
): string {
  const branch = `worker/${workerId}/${slug}`;
  if (!isGitAvailable(cwd)) {
    // No git repo — return a placeholder; lock-based coordination still works
    return branch;
  }
  try {
    execSync(`git branch ${branch} ${baseBranch}`, { cwd, stdio: "pipe" });
  } catch {
    // Base ref missing, or the branch already exists: fall back to HEAD. An
    // existing branch is not clobbered — the second command fails too.
    try {
      execSync(`git branch ${branch}`, { cwd, stdio: "pipe" });
    } catch {
      // Give up — lock coordination still works
    }
  }
  return branch;
}

/**
 * Delete a worker branch.
 */
export function deleteWorkerBranch(branch: string, cwd?: string): void {
  if (!isGitAvailable(cwd)) return;
  try {
    execSync(`git branch -D ${branch} 2>/dev/null || true`, { cwd, stdio: "pipe" });
  } catch {
    // Non-fatal
  }
}

/**
 * Get the diff between baseBranch and the given branch.
 * Returns the diff as a string, or empty string if no git available.
 */
export function getDiff(branch: string, baseBranch = "main", cwd?: string): string {
  if (!isGitAvailable(cwd)) return "";
  try {
    return execSync(`git diff ${baseBranch}...${branch}`, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    return "";
  }
}

/**
 * Check if a branch exists locally.
 */
export function branchExists(branch: string, cwd?: string): boolean {
  if (!isGitAvailable(cwd)) return false;
  try {
    const result = execSync(`git branch --list ${branch}`, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the current branch name, or "unknown" if git is not available.
 */
export function getCurrentBranch(cwd?: string): string {
  if (!isGitAvailable(cwd)) return "unknown";
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * The worktree that currently has `branch` checked out, or undefined when no
 * worktree holds it (the branch exists as a ref only). Git allows a branch to
 * be checked out in at most one worktree, so the first match is the only one.
 *
 * This is the guard a ref-advancing caller needs before it reaches for
 * plumbing: `update-ref` moves a ref without touching the index or files of a
 * worktree that has the branch checked out, which leaves that worktree reading
 * as a staged inverse of the change. Merging in the holder worktree instead
 * moves ref and tree together.
 */
export function worktreeForBranch(branch: string, cwd?: string): string | undefined {
  if (!isGitAvailable(cwd)) return undefined;
  try {
    const out = execSync("git worktree list --porcelain", {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return parseWorktreeList(out, branch);
  } catch {
    return undefined;
  }
}

/**
 * Pull the path of the worktree whose `branch` line names `refs/heads/<branch>`
 * out of `git worktree list --porcelain` output. Detached worktrees carry no
 * `branch` line and never match.
 */
function parseWorktreeList(porcelain: string, branch: string): string | undefined {
  const target = `refs/heads/${branch}`;
  let currentPath: string | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ") && line.slice("branch ".length).trim() === target) {
      return currentPath;
    }
  }
  return undefined;
}
