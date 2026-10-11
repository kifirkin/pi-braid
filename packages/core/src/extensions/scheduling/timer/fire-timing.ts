/**
 * Fire-timing marker — the ONE format shared by every timer fire text.
 *
 * Timers can fire late (busy agent, mid-tool deferral, process gap), and a
 * fire without its scheduled/actual times reads as on-time even when it
 * arrived long after the agent needed it. Live fires and recovered fires
 * must render the same marker so the agent (and the operator, in the pane
 * log) can compare them. Lives in the timer module because the invariant is
 * the timer fire path's, not any single caller's.
 */

import { formatLocalTime } from "../../../lib/utils/local-time.js";

export interface FireTiming {
  /** e.g. `set for 09:00, fired 09:23 — drift 23m` */
  fireTiming: string;
  /** Seconds elapsed since the timer was scheduled. */
  elapsedSec: number;
  /** Milliseconds between the scheduled fire time and the actual delivery. */
  driftMs: number;
  /** `0m` when under a second, else seconds or whole minutes. */
  driftLabel: string;
}

/** Compute the fire-timing marker for one delivery. Missing metadata (junk
 *  persisted records) reads as scheduled-now: drift 0, elapsed 0 — honest
 *  unknowns rather than fabricated times. */
export function describeFireTiming(
  createdAtMs: number | undefined,
  firesAtMs: number | undefined,
  now: number,
): FireTiming {
  const firedAt = new Date(now);
  const elapsedSec = Math.max(0, Math.round((now - (createdAtMs ?? now)) / 1000));
  const driftMs = Math.max(0, now - (firesAtMs ?? now));
  const driftLabel =
    driftMs < 1000
      ? "0m"
      : driftMs < 60_000
        ? `${Math.round(driftMs / 1000)}s`
        : `${Math.round(driftMs / 60_000)}m`;
  const fireTiming =
    `set for ${formatLocalTime(new Date(firesAtMs ?? now))}, ` +
    `fired ${formatLocalTime(firedAt)} — drift ${driftLabel}`;
  return { fireTiming, elapsedSec, driftMs, driftLabel };
}
