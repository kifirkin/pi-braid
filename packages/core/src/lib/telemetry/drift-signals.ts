/**
 * Drift Signals - bounded per-session drift accumulator.
 *
 * Tracks lightweight drift signals (re-reads of previously-read files,
 * goal-wording shift, stale/wrong file paths, repeated failure on the same
 * target) so silent loss becomes visible via context_inspect / heartbeat
 * analytics - the seed of the degradation detection loop.
 *
 * Design constraints:
 *   - Integer increments only. NO heuristic storm, NO string building, NO
 *     per-turn work beyond a counter bump. Detection/gating lives at the
 *     call sites (turn-analysis.ts, drift-handler.ts), not here.
 *   - Bounded accumulator: the counters are per-process totals plus a small
 *     ring of the most recent signals (RING_SIZE) for context/debugging.
 *
 * State note: like CompactionHealth in context-manager/handlers/shared.ts,
 * this is a module-level `const` object mutated in place (not a `let`), under
 * the same single-session-per-process assumption that governs the compaction
 * telemetry singleton. Reset via resetDriftTelemetry() at session start / tests.
 */

export type DriftSignalKey =
  | "rereads" //            re-reads of previously-read files
  | "goalShift" //          goal-wording / topic drift
  | "stalePaths" //         stale or wrong file paths (errored path-targeting tools)
  | "repeatedFailures"; //  repeated failure on the same target

export interface DriftCounters {
  rereads: number;
  goalShift: number;
  stalePaths: number;
  repeatedFailures: number;
  /** Total drift signals recorded. */
  total: number;
}

export interface DriftSignalEntry {
  turn: number;
  key: DriftSignalKey;
}

/** Small ring of the most recent drift signals (bounded). */
const RING_SIZE = 16;

interface DriftTelemetry {
  counters: DriftCounters;
  ring: DriftSignalEntry[];
}

const driftTelemetry: DriftTelemetry = {
  counters: { rereads: 0, goalShift: 0, stalePaths: 0, repeatedFailures: 0, total: 0 },
  ring: [],
};

export function resetDriftTelemetry(): void {
  driftTelemetry.counters = {
    rereads: 0,
    goalShift: 0,
    stalePaths: 0,
    repeatedFailures: 0,
    total: 0,
  };
  driftTelemetry.ring = [];
}

/**
 * Record one drift signal. Zero-cost apart from two integer bumps and a ring
 * append. `turn` is the current turn number at the call site.
 */
export function recordDriftSignal(key: DriftSignalKey, turn: number): void {
  const c = driftTelemetry.counters;
  switch (key) {
    case "rereads":
      c.rereads++;
      break;
    case "goalShift":
      c.goalShift++;
      break;
    case "stalePaths":
      c.stalePaths++;
      break;
    case "repeatedFailures":
      c.repeatedFailures++;
      break;
  }
  c.total++;
  if (driftTelemetry.ring.length >= RING_SIZE) {
    driftTelemetry.ring.shift();
  }
  driftTelemetry.ring.push({ turn, key });
}

/**
 * One-line drift summary for context_inspect / heartbeat analytics.
 * Returns null when no drift signals were recorded this process, so the
 * quick inspector line can stay clean.
 */
export function formatDriftLine(): string | null {
  if (driftTelemetry.counters.total === 0) return null;
  const c = driftTelemetry.counters;
  return (
    `drift signals: ${c.rereads} re-reads, ${c.repeatedFailures} repeated failures, ` +
    `${c.stalePaths} stale paths, ${c.goalShift} goal shifts`
  );
}
