/**
 * Branch management utilities for multi-agent orchestration.
 *
 * Workers get isolated git branches. The master creates, verifies,
 * and merges worker branches. All operations use git commands.
 */

import { execSync } from "node:child_process";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WorkerBranchInfo {
  branch: string;
  workerId: string;
  slug: string;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a worker branch from the current branch.
 * Returns the branch name.
 */
export function createWorkerBranch(
  workerId: string,
  slug: string,
  baseBranch = "main",
): string {
  const branch = `worker/${workerId}/${slug}`;
  execSync(`git checkout ${baseBranch}`, { stdio: "pipe" });
  execSync(`git checkout -b ${branch}`, { stdio: "pipe" });
  return branch;
}

/**
 * Delete a worker branch.
 */
export function deleteWorkerBranch(branch: string): void {
  execSync(`git branch -D ${branch} 2>/dev/null || true`, { stdio: "pipe" });
}

/**
 * Squash-merge a worker branch into the current branch.
 * Returns true if the merge succeeded.
 */
export function squashMerge(branch: string): boolean {
  try {
    execSync(`git merge --squash ${branch} 2>/dev/null`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the diff between main and the given branch.
 * Returns the diff as a string.
 */
export function getDiff(branch: string, baseBranch = "main"): string {
  try {
    return execSync(`git diff ${baseBranch}...${branch}`, {
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
export function branchExists(branch: string): boolean {
  try {
    const result = execSync(`git branch --list ${branch}`, {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the current branch name.
 */
export function getCurrentBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Parse a worker branch name into its components.
 */
export function parseWorkerBranch(branch: string): WorkerBranchInfo | null {
  const match = /^worker\/([^/]+)\/(.+)$/.exec(branch);
  if (!match) return null;
  return { branch, workerId: match[1], slug: match[2] };
}