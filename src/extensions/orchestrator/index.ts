/**
 * Orchestrator extension — multi-agent coordination.
 *
 * Registers the `orchestrate` tool for managing parallel agent workers.
 * Supports branch-per-worker, file-lock awareness, conflict detection,
 * and merge verification.
 *
 * Git operations auto-detect the repo root from the `files` parameter,
 * so orchestrate works from ANY cwd (including ~/.pi/agent). Falls back
 * to lock-only coordination when no git repo is found.
 *
 * Workers can be spawned via herdr (recommended) or manual instructions.
 *
 * This is the implementation counterpart to skills/orchestrator/SKILL.md.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../../lib/core/logger.js";
import {
  acquireLock,
  releaseLock,
  getConflicts,
  getAllLocks,
  createWorkerBranch,
  squashMerge,
  deleteWorkerBranch,
  getDiff,
  getCurrentBranch,
  findRepoRoot,
  gitAvailable,
  branchExists,
  checkoutBranch,
} from "../../lib/orchestrator/index.js";

const log = createLogger("orchestrator");

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the repo root: explicit `cwd` param wins, otherwise auto-detect
 * from file paths. Returns undefined if no git repo is found.
 */
function resolveCwd(cwd?: string, files?: string[]): string | undefined {
  if (cwd) return cwd;
  if (files && files.length > 0) return findRepoRoot(files);
  return undefined;
}

// ── Tool Definition ────────────────────────────────────────────────────────

const orchestrateTool: ToolDefinition<any, any, any> = {
  name: "orchestrate",
  label: "Orchestrate",
  promptSnippet: "Coordinate parallel agent workers: spawn-worker, check-worker, verify-and-merge, release-locks, list-locks, check-conflicts",
  description: `Coordinate parallel agent workers for multi-agent development.

Actions:
  - spawn-worker: Create a branch, acquire file locks, and return instructions for spawning a worker
  - check-worker: Check if a worker's branch exists and has changes
  - verify-and-merge: Read diff, verify, merge a worker branch back to main
  - release-locks: Release all locks held by a worker
  - list-locks: Show all currently held file locks
  - check-conflicts: Check if given files conflict with existing locks

Use this tool when you need to coordinate multiple agents working on the same codebase to prevent edit conflicts.

Git operations auto-detect the repo root from the file paths, so orchestrate works from any working directory.
Pass an explicit \`cwd\` to override auto-detection. When no git repo is found, orchestrate falls back to
lock-only coordination (branch operations are skipped).`,
  parameters: Type.Object({
    action: Type.Union(
      [
        Type.Literal("spawn-worker"),
        Type.Literal("check-worker"),
        Type.Literal("verify-and-merge"),
        Type.Literal("release-locks"),
        Type.Literal("list-locks"),
        Type.Literal("check-conflicts"),
      ],
      { description: "The orchestration action to perform" },
    ),
    workerId: Type.Optional(
      Type.String({ description: "Unique worker identifier (e.g., w1, w2). Required for spawn-worker, release-locks, check-worker, verify-and-merge." }),
    ),
    slug: Type.Optional(
      Type.String({ description: "Kebab-case task description. Required for spawn-worker." }),
    ),
    files: Type.Optional(
      Type.Array(Type.String(), { description: "File paths the worker will modify. Required for spawn-worker, check-conflicts." }),
    ),
    branch: Type.Optional(
      Type.String({ description: "Branch name. Required for verify-and-merge." }),
    ),
    cwd: Type.Optional(
      Type.String({ description: "Git repo root (auto-detected from files if omitted)." }),
    ),
  }),
  execute: async (
    _id: string,
    params: { action: string; workerId?: string; slug?: string; files?: string[]; branch?: string; cwd?: string },
    _signal: AbortSignal,
    _onUpdate: unknown,
    _ctx: unknown,
  ) => {
    const { action, workerId, slug, files, branch, cwd: explicitCwd } = params;

    const repoRoot = resolveCwd(explicitCwd, files);
    const hasGit = gitAvailable(repoRoot);
    const gitMode = hasGit ? "git" : "lock-only";

    switch (action) {
      case "spawn-worker": {
        if (!workerId || !slug || !files) {
          throw new Error("spawn-worker requires workerId, slug, and files");
        }

        // Check conflicts first
        const conflicts = getConflicts(files, repoRoot);
        if (conflicts.length > 0) {
          const detail = conflicts
            .map((c: { file: string; lockedBy: string; branch: string }) => `  ${c.file} — locked by ${c.lockedBy} (${c.branch})`)
            .join("\n");
          return {
            content: [
              {
                type: "text" as const,
                text: `CONFLICT: ${conflicts.length} file(s) already locked by other workers:\n${detail}\n\nResolve conflicts before spawning this worker.`,
              },
            ],
            details: {},
          };
        }

        // Create branch
        const branchName = createWorkerBranch(workerId, slug, undefined, repoRoot);

        // Acquire locks
        const locked = acquireLock(files, workerId, branchName, repoRoot);
        if (!locked) {
          // Shouldn't happen after conflict check, but be safe
          deleteWorkerBranch(branchName, repoRoot);
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to acquire locks (race condition). Try again.",
              },
            ],
            details: {},
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Worker ${workerId} ready.
Branch: ${branchName}
Files locked: ${files.join(", ")}

To spawn the worker:
1. Use herdr to create a new pane
2. Pass the branch name and locked files to the worker
3. The worker should: git checkout ${branchName}, make changes, commit, then signal completion

When the worker signals completion, use orchestrate action=verify-and-merge to review and merge.`,
            },
          ],
          details: {},
        };
      }

      case "check-worker": {
        if (!workerId) {
          throw new Error("check-worker requires workerId");
        }

        const locks = getAllLocks(repoRoot);
        const workerFiles = Object.entries(locks).filter(
          ([, entry]) => entry.workerId === workerId,
        );

        if (workerFiles.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Worker ${workerId} has no locks. They may have completed or not yet started.`,
              },
            ],
            details: {},
          };
        }

        const wBranch = workerFiles[0][1].branch;
        const currentBranch = getCurrentBranch(repoRoot);

        return {
          content: [
            {
              type: "text" as const,
              text: `Worker ${workerId}
Branch: ${wBranch}
Current branch: ${currentBranch}
Locked files: ${workerFiles.map(([f]) => f).join(", ")}`,
            },
          ],
          details: {},
        };
      }

      case "verify-and-merge": {
        if (!workerId) {
          throw new Error("verify-and-merge requires workerId");
        }

        const locks = getAllLocks(repoRoot);
        const workerFiles = Object.entries(locks).filter(
          ([, entry]) => entry.workerId === workerId,
        );

        if (workerFiles.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Worker ${workerId} has no locks. Nothing to verify.`,
              },
            ],
            details: {},
          };
        }

        const workerBranch = workerFiles[0][1].branch;

        // Get the diff
        const diff = getDiff(workerBranch, undefined, repoRoot);

        // Try squash merge
        const merged = squashMerge(workerBranch, repoRoot);

        if (!merged) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Merge conflict detected for ${workerBranch}. Manual resolution required.
Diff preview:
${diff.slice(0, 2000)}`,
              },
            ],
            details: {},
          };
        }

        // Release locks
        releaseLock(workerId, repoRoot);

        // Delete worker branch
        deleteWorkerBranch(workerBranch, repoRoot);

        return {
          content: [
            {
              type: "text" as const,
              text: `Worker ${workerId} merged successfully.
Branch: ${workerBranch} (deleted)
Diff summary:
${diff.slice(0, 2000)}

Next steps:
1. Run \`npm run build\` to verify compilation
2. Run \`npm test\` to verify tests pass
3. Commit the merge with an appropriate message`,
            },
          ],
          details: {},
        };
      }

      case "release-locks": {
        if (!workerId) {
          throw new Error("release-locks requires workerId");
        }

        releaseLock(workerId, repoRoot);
        return {
          content: [
            {
              type: "text" as const,
              text: `Released all locks for worker ${workerId}.`,
            },
          ],
          details: {},
        };
      }

      case "list-locks": {
        const locks = getAllLocks(repoRoot);
        const entries = Object.entries(locks);

        if (entries.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No locks held.",
              },
            ],
            details: {},
          };
        }

        const detail = entries
          .map(([file, entry]) => `  ${file} → ${entry.workerId} (${entry.branch})`)
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Current locks:\n${detail}`,
            },
          ],
          details: {},
        };
      }

      case "check-conflicts": {
        if (!files) {
          throw new Error("check-conflicts requires files");
        }

        const conflicts = getConflicts(files, repoRoot);

        if (conflicts.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No conflicts detected. All files are available.",
              },
            ],
            details: {},
          };
        }

        const detail = conflicts
          .map((c: { file: string; lockedBy: string; branch: string }) => `  ${c.file} → ${c.lockedBy} (${c.branch})`)
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Conflicts detected:\n${detail}`,
            },
          ],
          details: {},
        };
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  },
};

// ── Extension Factory ──────────────────────────────────────────────────────

export default function orchestratorExtension(pi: ExtensionAPI): void {
  pi.registerTool(orchestrateTool);
  log.info("[orchestrator] registered orchestrate tool");
}