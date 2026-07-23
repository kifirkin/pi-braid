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

// ── Types ──────────────────────────────────────────────────────────────────

export interface WorkerBranchInfo {
  branch: string;
  workerId: string;
  slug: string;
}

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
    execSync(`git checkout ${baseBranch} 2>/dev/null || git checkout -b ${baseBranch} 2>/dev/null`, { cwd, stdio: "pipe" });
    execSync(`git checkout -b ${branch}`, { cwd, stdio: "pipe" });
    return branch;
  } catch {
    // Fallback: branch creation failed (e.g., base branch doesn't exist)
    try {
      execSync(`git checkout -b ${branch}`, { cwd, stdio: "pipe" });
    } catch {
      // Give up — lock coordination still works
    }
    return branch;
  }
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
 * Squash-merge a worker branch into the current branch.
 * Returns true if the merge succeeded.
 */
export function squashMerge(branch: string, cwd?: string): boolean {
  if (!isGitAvailable(cwd)) return false;
  try {
    execSync(`git merge --squash ${branch} 2>/dev/null`, { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
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
 * Parse a worker branch name into its components.
 * Does not require git — pure string parsing.
 */
export function parseWorkerBranch(branch: string): WorkerBranchInfo | null {
  const match = /^worker\/([^/]+)\/(.+)$/.exec(branch);
  if (!match) return null;
  return { branch, workerId: match[1], slug: match[2] };
}

/**
 * Checkout a branch (for the worker to switch into the branch).
 * Returns true if checkout succeeded.
 */
export function checkoutBranch(branch: string, cwd?: string): boolean {
  if (!isGitAvailable(cwd)) return false;
  try {
    execSync(`git checkout ${branch}`, { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}