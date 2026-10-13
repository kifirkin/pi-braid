/**
 * File-lock registry for multi-agent orchestration.
 *
 * Workers acquire locks on files they intend to modify. The master
 * checks for conflicts before spawning new workers. Lock state is
 * persisted to disk so multiple agent processes on the same machine
 * can coordinate.
 *
 * Lock file location: ~/.pi/agent/braid/projects/<sanitized-cwd>/locks.json
 * (per-CWD, shared across all agents working on the same project)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLockFilePath } from "../config/braid-paths.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("orchestrator:locks");

// ── Types ──────────────────────────────────────────────────────────────────

export interface LockEntry {
  workerId: string;
  branch: string;
  acquiredAt: number;
}

export interface LockRegistry {
  version: number;
  locks: Record<string, LockEntry>;
}

export interface Conflict {
  file: string;
  lockedBy: string;
  branch: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const LOCK_VERSION = 1;

// ── Internal helpers ───────────────────────────────────────────────────────

function lockFilePath(cwd?: string): string {
  return getLockFilePath(cwd ?? process.cwd());
}

/** Warned once per process about a lock registry that cannot be read or
 *  written (no absolute braid root resolves, or the write failed). The
 *  registry is advisory coordination state: a refusal must never be silent,
 *  but it must not take the orchestration call down either. */
let _warnedRegistryRefusal = false;

function reportRegistryRefusal(action: string, err: unknown): void {
  if (_warnedRegistryRefusal) return;
  _warnedRegistryRefusal = true;
  const message = err instanceof Error ? err.message : String(err);
  log.warn(`lock registry ${action} refused (${message}); locks are not durable this session`);
}

function loadRegistry(cwd?: string): LockRegistry {
  try {
    const file = lockFilePath(cwd);
    if (!existsSync(file)) return { version: LOCK_VERSION, locks: {} };
    const raw = readFileSync(file, "utf-8").trim();
    if (!raw) return { version: LOCK_VERSION, locks: {} };
    return JSON.parse(raw) as LockRegistry;
  } catch (err) {
    reportRegistryRefusal("read", err);
    return { version: LOCK_VERSION, locks: {} };
  }
}

/** Persist the registry. Returns false when the write was refused, so a
 *  caller that claims a lock can refuse the claim instead of lying. */
function saveRegistry(registry: LockRegistry, cwd?: string): boolean {
  try {
    const file = lockFilePath(cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(registry, null, 2), "utf-8");
    return true;
  } catch (err) {
    reportRegistryRefusal("write", err);
    return false;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Acquire locks on the given files for a worker.
 * Returns true if all locks were acquired and persisted, false if any file is
 * already locked by a different worker or the registry could not be written
 * (an unwritten lock is not held; the refusal is logged).
 */
export function acquireLock(
  files: string[],
  workerId: string,
  branch: string,
  cwd?: string,
): boolean {
  const registry = loadRegistry(cwd);

  for (const file of files) {
    const existing = registry.locks[file];
    if (existing && existing.workerId !== workerId) {
      return false; // Conflict: already locked by another worker
    }
  }

  const now = Date.now();
  for (const file of files) {
    registry.locks[file] = { workerId, branch, acquiredAt: now };
  }

  return saveRegistry(registry, cwd);
}

/**
 * Release all locks held by a worker.
 */
export function releaseLock(workerId: string, cwd?: string): void {
  const registry = loadRegistry(cwd);
  for (const [file, entry] of Object.entries(registry.locks)) {
    if (entry.workerId === workerId) {
      delete registry.locks[file];
    }
  }
  saveRegistry(registry, cwd);
}

/**
 * Check which of the given files are locked by other workers.
 * Returns an array of conflicts.
 */
export function getConflicts(files: string[], cwd?: string): Conflict[] {
  const registry = loadRegistry(cwd);
  const conflicts: Conflict[] = [];

  for (const file of files) {
    const entry = registry.locks[file];
    if (entry) {
      conflicts.push({
        file,
        lockedBy: entry.workerId,
        branch: entry.branch,
      });
    }
  }

  return conflicts;
}

/**
 * Get all currently locked files.
 */
export function getAllLocks(cwd?: string): Record<string, LockEntry> {
  return loadRegistry(cwd).locks;
}
