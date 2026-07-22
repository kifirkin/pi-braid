/**
 * Orchestrator library — multi-agent coordination utilities.
 *
 * Provides file-lock registry, branch management, conflict detection,
 * and merge verification for orchestrating parallel agent workers.
 */

export {
  acquireLock,
  releaseLock,
  releaseAllLocks,
  getConflicts,
  getAllLocks,
  isLocked,
  getLock,
} from "./locks.js";

export type { LockEntry, LockRegistry, Conflict } from "./locks.js";

export {
  createWorkerBranch,
  deleteWorkerBranch,
  squashMerge,
  getDiff,
  branchExists,
  getCurrentBranch,
  parseWorkerBranch,
} from "./branch.js";

export type { WorkerBranchInfo } from "./branch.js";