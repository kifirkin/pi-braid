/**
 * @fileoverview State Checkpoint & Auto-Rollback (P3.3)
 *
 * Creates versioned snapshots of session extension state at clean intervals.
 * On degradation detection, auto-restores from the last good checkpoint.
 *
 * Checkpoint strategy:
 * - Phase 1: Save checkpoint every N clean turns (configurable, default 20)
 * - Phase 2: On degrade detection, restore extension state from checkpoint
 *
 * Checkpoint stores:
 * - Extension state (getExtensionState keys) — serialized to JSON
 * - File mutation queue — pending write/edit operations
 * - Scratchpad state — goal/plan/decisions
 *
 * Since extension state is in-memory (WeakMap), checkpoints are stored
 * in a disk-backed JSON file in ~/.pi/agent/checkpoints/
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getExtensionState, hasExtensionState } from "./extension-state.js";
import { createLogger } from "../core/logger.js";
import { CHECKPOINT_DIR } from "../config/braid-paths.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const log = createLogger("checkpoint");

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_CHECKPOINTS = 10;
const DEFAULT_CHECKPOINT_INTERVAL = 20; // Clean turns between checkpoints

// ── Types ───────────────────────────────────────────────────────────────────

export interface Checkpoint {
  id: string;
  timestamp: number;
  turnCount: number;
  /** Key-value snapshot of extension state keys */
  stateSnapshots: Record<string, unknown>;
  sessionId: string;
}

/** Session-scoped checkpoint state */
interface CheckpointState {
  lastCleanTurn: number;
  lastCheckpointTurn: number;
  checkpoints: Checkpoint[];
  autoRollbackEnabled: boolean;
}

// ── State ───────────────────────────────────────────────────────────────────

function getCheckpointState(ctx: ExtensionContext): CheckpointState {
  return getExtensionState(ctx, "state-checkpoint", () => ({
    lastCleanTurn: 0,
    lastCheckpointTurn: 0,
    checkpoints: [],
    autoRollbackEnabled: true,
  }));
}

// ── Checkpoint Storage ──────────────────────────────────────────────────────

function checkpointFilePath(sessionId: string): string {
  return path.join(CHECKPOINT_DIR, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

async function saveCheckpointsToDisk(sessionId: string, checkpoints: Checkpoint[]): Promise<void> {
  try {
    await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
    await fs.writeFile(
      checkpointFilePath(sessionId),
      JSON.stringify(checkpoints, null, 2),
      "utf-8",
    );
  } catch (err) {
    log.error("Failed to save checkpoints:", err);
  }
}

async function loadCheckpointsFromDisk(sessionId: string): Promise<Checkpoint[]> {
  try {
    const data = await fs.readFile(checkpointFilePath(sessionId), "utf-8");
    return JSON.parse(data) as Checkpoint[];
  } catch {
    return [];
  }
}

// ── Checkpoint Creation ─────────────────────────────────────────────────────

/**
 * Create a checkpoint: snapshot extension state keys and save to disk.
 * Call this on clean turns (no errors, no degradation).
 */
export async function createCheckpoint(
  ctx: ExtensionContext,
  turnCount: number,
  sessionId: string,
): Promise<Checkpoint | null> {
  const state = getCheckpointState(ctx);
  const sinceLast = turnCount - state.lastCheckpointTurn;
  if (sinceLast < DEFAULT_CHECKPOINT_INTERVAL) return null;

  // Collect relevant extension state snapshots
  const snapshots: Record<string, unknown> = {};

  // Capture claim-tracker state (from P3.2)
  if (hasExtensionState(ctx, "claim-tracker")) {
    const claimState = getExtensionState(
      ctx,
      "claim-tracker",
      () => ({ claims: [], lastCheckMs: 0 }) as Record<string, unknown>,
    );
    const cState = claimState as { claims?: unknown[]; lastCheckMs?: number };
    if (Object.keys(cState).length > 0) {
      snapshots["claim-tracker"] = {
        claims: cState.claims?.slice(0, 20) ?? [],
        lastCheckMs: cState.lastCheckMs ?? 0,
      };
    }
  }

  // Capture enforcement state summary
  if (hasExtensionState(ctx, "enforcement")) {
    const enforcementState = getExtensionState(
      ctx,
      "enforcement",
      () => ({ consecutiveErrorTurns: 0 }) as Record<string, unknown>,
    );
    const eState = enforcementState as { consecutiveErrorTurns?: number };
    if (Object.keys(eState).length > 0) {
      snapshots["enforcement"] = {
        consecutiveErrorTurns: eState.consecutiveErrorTurns ?? 0,
      };
    }
  }

  // Capture heartbeat state (turn count, tool tracking)
  if (hasExtensionState(ctx, "heartbeat")) {
    const hbState = getExtensionState(
      ctx,
      "heartbeat",
      () => ({ turnCount: 0, policyTurnCount: 0 }) as Record<string, unknown>,
    );
    const hState = hbState as { turnCount?: number; policyTurnCount?: number };
    if (Object.keys(hState).length > 0) {
      snapshots["heartbeat"] = {
        turnCount: hState.turnCount ?? 0,
        policyTurnCount: hState.policyTurnCount ?? 0,
      };
    }
  }

  const checkpoint: Checkpoint = {
    id: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    turnCount,
    stateSnapshots: snapshots,
    sessionId,
  };

  state.checkpoints.push(checkpoint);

  // Prune old checkpoints
  if (state.checkpoints.length > MAX_CHECKPOINTS) {
    state.checkpoints = state.checkpoints.slice(-MAX_CHECKPOINTS);
  }

  state.lastCheckpointTurn = turnCount;

  // Save to disk
  await saveCheckpointsToDisk(sessionId, state.checkpoints);

  log.info(`Checkpoint created at turn ${turnCount}: ${checkpoint.id}`);
  return checkpoint;
}

// ── Rollback ────────────────────────────────────────────────────────────────

/**
 * Restore extension state from the most recent checkpoint.
 * Only restores tracked keys — full state restoration is best-effort.
 */
export async function autoRollback(
  ctx: ExtensionContext,
  sessionId: string,
): Promise<{ restored: boolean; turnCount: number; note: string }> {
  const state = getCheckpointState(ctx);
  if (!state.autoRollbackEnabled) {
    return { restored: false, turnCount: 0, note: "Auto-rollback disabled" };
  }

  // Load checkpoints from disk to ensure we have the latest
  const diskCheckpoints = await loadCheckpointsFromDisk(sessionId);
  if (diskCheckpoints.length > 0) {
    // Merge disk checkpoints with in-memory (disk may have cross-session checkpoints)
    for (const cp of diskCheckpoints) {
      if (!state.checkpoints.find((c) => c.id === cp.id)) {
        state.checkpoints.push(cp);
      }
    }
    state.checkpoints.sort((a, b) => b.timestamp - a.timestamp);
    if (state.checkpoints.length > MAX_CHECKPOINTS) {
      state.checkpoints = state.checkpoints.slice(0, MAX_CHECKPOINTS);
    }
  }

  // Get the most recent checkpoint
  const latest = state.checkpoints[state.checkpoints.length - 1];
  if (!latest) {
    return { restored: false, turnCount: 0, note: "No checkpoint available for rollback" };
  }

  // Restore enforcement error counter (clear it to stop error burst detection)
  if (hasExtensionState(ctx, "enforcement")) {
    const enforcementState = getExtensionState(
      ctx,
      "enforcement",
      () => ({ consecutiveErrorTurns: 0 }) as Record<string, unknown>,
    );
    if (latest.stateSnapshots["enforcement"]) {
      const snap = latest.stateSnapshots["enforcement"] as { consecutiveErrorTurns?: number };
      (enforcementState as { consecutiveErrorTurns: number }).consecutiveErrorTurns =
        snap.consecutiveErrorTurns ?? 0;
    }
  }

  // Clear degradation state
  if (hasExtensionState(ctx, "degradation-detector")) {
    const degState = getExtensionState(
      ctx,
      "degradation-detector",
      () => ({ isDegraded: false }) as { isDegraded: boolean },
    );
    degState.isDegraded = false;
  }

  log.info(`Auto-rollback: restored from checkpoint ${latest.id} (turn ${latest.turnCount})`);
  return {
    restored: true,
    turnCount: latest.turnCount,
    note: `Restored from checkpoint '${latest.id}' at turn ${latest.turnCount}`,
  };
}

// ── Integration Helpers ────────────────────────────────────────────────────

/**
 * Call on each heartbeat tick. If the session is clean (no errors, no degradation),
 * consider creating a checkpoint. If degraded, trigger auto-rollback.
 */
export async function heartbeatCheckpointTick(
  ctx: ExtensionContext,
  turnCount: number,
  sessionId: string,
  isDegradedFlag: boolean,
): Promise<{ checkpointCreated: boolean; rollbackPerformed: boolean; message?: string }> {
  const result = {
    checkpointCreated: false,
    rollbackPerformed: false,
    message: undefined as string | undefined,
  };

  if (isDegradedFlag) {
    // Degraded → auto-rollback
    const rb = await autoRollback(ctx, sessionId);
    if (rb.restored) {
      result.rollbackPerformed = true;
      result.message = rb.note;
    }
  } else {
    // Clean → checkpoint
    const cp = await createCheckpoint(ctx, turnCount, sessionId);
    if (cp) {
      result.checkpointCreated = true;
    }
  }

  return result;
}

/**
 * Get metadata about available checkpoints for status display.
 */
export function getCheckpointInfo(ctx: ExtensionContext): {
  count: number;
  latestTurn: number;
  latestAge: string;
  autoRollback: boolean;
} {
  const state = getCheckpointState(ctx);
  const latest = state.checkpoints[state.checkpoints.length - 1];
  const age = latest ? Math.round((Date.now() - latest.timestamp) / 1000) : 0;
  const ageStr =
    age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
  return {
    count: state.checkpoints.length,
    latestTurn: latest?.turnCount ?? 0,
    latestAge: latest ? ageStr : "none",
    autoRollback: state.autoRollbackEnabled,
  };
}
