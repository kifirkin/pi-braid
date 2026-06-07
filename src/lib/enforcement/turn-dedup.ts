/**
 * Turn-Scoped Whisper Dedup
 *
 * Multiple subsystems (BPE, dreamer, mars, drift, turn-outcome) all fire
 * `sendTrackedMessage` on `turn_end`. Without coordination, a single degraded
 * turn can produce 4–5 simultaneous steers, each nudging the agent in a
 * slightly different direction. The agent is forced to triage noise rather
 * than act.
 *
 * This module provides a turn-scoped registry. Each handler calls
 * `tryClaim(type)` before sending. The first claim for a given type wins; the
 * second is rejected. The registry is cleared at the start of each new turn
 * (the `input` event) so the same warning can fire again on a future turn.
 *
 * Categories — handlers in the same category deduplicate against each other.
 * Different categories are independent. Default is `"default"`:
 *
 *   "loop"      : dreamer, turn-outcome (loop detection)
 *   "stability" : bpe stability-decline, mars stability-decline
 *   "drift"     : bpe focus, drift handler
 *   "default"   : everything else (bpe generic, mars generic, etc.)
 *
 * Use `tryClaim(type, category)` to enroll. Use `tryClaim(type)` for the
 * default category.
 */

import { createLogger } from "../core/logger.js";
import { getExtensionState } from "../state/extension-state.js";

const log = createLogger("turn-dedup");

/** A type that has fired in the current turn, plus the turn id it fired in. */
interface ClaimRecord {
  type: string;
  category: string;
  claimedAt: number;
}

interface DedupState {
  /** Bumped on every `input` event. Used to detect stale entries. */
  currentTurn: number;
  /** All claims made in the current turn, keyed by category. */
  claims: ClaimRecord[];
}

function getState(): DedupState {
  // We use a no-op key and module-level singleton. The dedup state is
  // intentionally process-global, not per-session, because the `input` event
  // is what defines "turn" and that already partitions correctly.
  return _state;
}

let _state: DedupState = {
  currentTurn: 0,
  claims: [],
};

/**
 * Bump the turn counter and clear all claims. Call this from the `input`
 * event handler — it represents the start of a new assistant turn.
 */
export function beginTurn(): void {
  _state.currentTurn += 1;
  _state.claims = [];
}

/**
 * Try to claim the right to fire a whisper of `type` in `category` for the
 * current turn. Returns `true` if the claim succeeded (caller should send),
 * `false` if a different type in the same category already claimed this turn
 * (caller should suppress).
 *
 * Calling `tryClaim` twice for the same `type` always returns `true` — the
 * first claim is idempotent for the same type.
 */
export function tryClaim(type: string, category: string = "default"): boolean {
  const state = getState();
  // Drop stale claims from previous turns (defensive — beginTurn() should
  // have already cleared these).
  state.claims = state.claims.filter((c) => c.claimedAt > 0);

  // Idempotent: same type can re-claim.
  const existing = state.claims.find((c) => c.type === type && c.category === category);
  if (existing) return true;

  // Reject if any other type in the same category already claimed this turn.
  const sameCategory = state.claims.find((c) => c.category === category);
  if (sameCategory) {
    log.debug(
      `[turn-dedup] ${type} suppressed: ${sameCategory.type} already fired in category "${category}" this turn`,
    );
    return false;
  }

  state.claims.push({ type, category, claimedAt: Date.now() });
  return true;
}

/**
 * Reset dedup state — primarily for tests.
 */
export function _resetForTests(): void {
  _state = { currentTurn: 0, claims: [] };
}

/**
 * Read-only view of current state, for diagnostics and tests.
 */
export function _snapshot(): { currentTurn: number; claims: ReadonlyArray<ClaimRecord> } {
  return { currentTurn: _state.currentTurn, claims: [..._state.claims] };
}

// Note: we intentionally do NOT use `getExtensionState(ctx, ...)` here.
// Turn dedup must be a module-level singleton so that handlers running in
// different session contexts (rare but possible during handoff) share the
// same turn boundary. If you need per-session dedup, wrap `tryClaim` with a
// ctx-aware variant that keys on a session id derived from `ctx`.
