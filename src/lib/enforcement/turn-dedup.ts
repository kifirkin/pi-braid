/**
 * Turn-Scoped Whisper Dedup
 *
 * Multiple subsystems (BPE, dreamer, mars, drift, turn-outcome) all fire
 * `sendTrackedMessage` on `turn_end`. Without coordination, a single degraded
 * turn can produce 4-5 simultaneous steers, each nudging the agent in a
 * slightly different direction. The agent is forced to triage noise rather
 * than act.
 *
 * This module provides a turn-scoped registry. Each handler calls
 * `tryClaim(type)` before sending. The first claim for a given type wins; the
 * second is rejected. The registry is cleared at the start of each new turn
 * (the `input` event) so the same warning can fire again on a future turn.
 *
 * Categories - handlers in the same category deduplicate against each other.
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
  /** Per-priority whisper counts in the current turn (for flood cap). */
  whisperCounts: Record<WhisperPriority, number>;
  /** Per-source whisper counts in the current turn (for fairness). */
  whisperBySource: Record<string, number>;
  /** Total whispers suppressed this turn (for telemetry). */
  suppressed: number;
}

/** Whisper priority tiers. */
export type WhisperPriority = "critical" | "high" | "medium" | "low";

/**
 * Per-turn whisper cap (flood protection).
 *
 * Critical always passes. For other priorities, the cap controls the max
 * number of whispers that can be delivered in a single turn from all
 * sources combined. Sources that exceed their per-source budget are still
 * counted toward the total, just not delivered.
 *
 * The defaults are intentionally small: a normal turn should have 0-1
 * whispers. Multiple heartbeats firing simultaneously on the same turn
 * can still produce a "[Heartbeat Summary]" (counts as 1).
 */
export const WHISPER_CAPS: Record<WhisperPriority, number> = {
  critical: 5, // generous - auto-recovery
  high: 3, // enforcement critical, compaction-retry exhausted
  medium: 2, // analytics, context 80%+, navigation
  low: 1, // hints, suggestions, dreams (filtered)
};

/** Per-source cap (a single subsystem can't flood). */
export const PER_SOURCE_CAP = 2;

/**
 * Per-source cap overrides. Use these to raise the cap for sources that
 * legitimately need more headroom (e.g. enforcement during a degraded
 * turn where dropping a critical steer is the worst outcome). Lower
 * caps than PER_SOURCE_CAP are NOT supported via overrides - if a
 * source needs a lower cap, add a new explicit value here.
 *
 * EW-7.13: drop the all-sources-share cap so high-priority sources
 * can get through during a degraded turn.
 */
export const PER_SOURCE_CAP_OVERRIDES: Record<string, number> = {
  // Enforcement whispers are critical/high priority. A 3rd
  // triggerTurn:true whisper in a degraded turn is more valuable
  // than dropping it (the alternative is the agent missing a
  // real signal).
  "enforcement/whisper": 3,
};

/** Resolve the per-source cap for a given source (override or default). */
export function getPerSourceCap(source: string): number {
  return PER_SOURCE_CAP_OVERRIDES[source] ?? PER_SOURCE_CAP;
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
  whisperCounts: { critical: 0, high: 0, medium: 0, low: 0 },
  whisperBySource: {},
  suppressed: 0,
};

/**
 * Bump the turn counter and clear all claims. Call this from the `input`
 * event handler - it represents the start of a new assistant turn.
 */
export function beginTurn(): void {
  _state.currentTurn += 1;
  _state.claims = [];
  _state.whisperCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  _state.whisperBySource = {};
  _state.suppressed = 0;
}

/**
 * Try to claim the right to fire a whisper of `type` in `category` for the
 * current turn. Returns `true` if the claim succeeded (caller should send),
 * `false` if a different type in the same category already claimed this turn
 * (caller should suppress).
 *
 * Calling `tryClaim` twice for the same `type` always returns `true` - the
 * first claim is idempotent for the same type.
 */
export function tryClaim(type: string, category: string = "default"): boolean {
  const state = getState();
  // Drop stale claims from previous turns (defensive - beginTurn() should
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
 * Reset dedup state - primarily for tests.
 */
export function _resetForTests(): void {
  _state = {
    currentTurn: 0,
    claims: [],
    whisperCounts: { critical: 0, high: 0, medium: 0, low: 0 },
    whisperBySource: {},
    suppressed: 0,
  };
}

/**
 * Read-only view of current state, for diagnostics and tests.
 */
export function _snapshot(): {
  currentTurn: number;
  claims: ReadonlyArray<ClaimRecord>;
  whisperCounts: Readonly<Record<WhisperPriority, number>>;
  whisperBySource: Readonly<Record<string, number>>;
  suppressed: number;
} {
  return {
    currentTurn: _state.currentTurn,
    claims: [..._state.claims],
    whisperCounts: { ..._state.whisperCounts },
    whisperBySource: { ..._state.whisperBySource },
    suppressed: _state.suppressed,
  };
}

// ── Per-Turn Whisper Cap (Flood Protection) ────────────────────────────────────────

/**
 * Try to record a whisper of `priority` from `source` in the current turn.
 * Returns `true` if the whisper should be delivered (under cap), `false`
 * if it's been suppressed by the flood protection.
 *
 * Critical priority always passes. Other priorities are capped at
 * WHISPER_CAPS[priority] per turn from all sources combined, with a
 * per-source cap of PER_SOURCE_CAP.
 *
 * Use this BEFORE calling `sendTrackedMessage` or `ctx.whisper` to avoid
 * flooding the agent. Returns the same value as `tryClaim` would (idempotent
 * within a source).
 */
export function tryWhisper(priority: WhisperPriority, source: string): boolean {
  const state = getState();

  // Critical always passes (subject to per-source cap to prevent a buggy
  // critical source from monopolizing the channel).
  if (priority === "critical") {
    const sourceCount = state.whisperBySource[source] ?? 0;
    const sourceCap = getPerSourceCap(source);
    if (sourceCount >= sourceCap) {
      state.suppressed++;
      log.debug(`[turn-dedup] critical "${source}" suppressed (per-source cap ${sourceCap})`);
      return false;
    }
    state.whisperCounts.critical++;
    state.whisperBySource[source] = sourceCount + 1;
    return true;
  }

  // Per-priority total cap
  const cap = WHISPER_CAPS[priority];
  if (state.whisperCounts[priority] >= cap) {
    state.suppressed++;
    log.debug(
      `[turn-dedup] ${priority} "${source}" suppressed (total cap ${cap} reached)`,
    );
    return false;
  }

  // Per-source fairness cap (override-aware)
  const sourceCount = state.whisperBySource[source] ?? 0;
  const sourceCap = getPerSourceCap(source);
  if (sourceCount >= sourceCap) {
    state.suppressed++;
    log.debug(
      `[turn-dedup] ${priority} "${source}" suppressed (per-source cap ${sourceCap})`,
    );
    return false;
  }

  state.whisperCounts[priority]++;
  state.whisperBySource[source] = sourceCount + 1;
  return true;
}

// Note: we intentionally do NOT use `getExtensionState(ctx, ...)` here.
// Turn dedup must be a module-level singleton so that handlers running in
// different session contexts (rare but possible during handoff) share the
// same turn boundary. If you need per-session dedup, wrap `tryClaim` with a
// ctx-aware variant that keys on a session id derived from `ctx`.
