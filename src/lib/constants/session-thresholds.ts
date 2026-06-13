/**
 * Session/Time-Based Thresholds - durations, ages, and rotation limits.
 *
 * Centralizes time-based constants that were previously scattered as
 * magic numbers like `7 * 24 * 60 * 60 * 1000` or `5 * 60 * 1000`.
 *
 * Pattern: name reflects the unit (MS for milliseconds, S for seconds,
 * D for days). When changing any of these, audit the comment in the
 * source file to see what behavior shifts.
 */

// ═════════════════════════════════════════════════════════════════════════════
// SESSION ROTATION
// ═════════════════════════════════════════════════════════════════════════════

/** Max age of a session before the rotation system suggests rotating out. */
export const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Cooldown after a nudge before another nudge can fire (turns). */
export const NUDGE_COOLDOWN_TURNS = 50;

/** Cooldown after a nudge before another nudge can fire (ms). */
export const NUDGE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// ═════════════════════════════════════════════════════════════════════════════
// CROSS-SESSION MEMORY
// ═════════════════════════════════════════════════════════════════════════════

/** Max age of a hint before it is dropped (consolidated-hints.jsonl). */
export const HINT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ═════════════════════════════════════════════════════════════════════════════
// TOPIC ANCHOR
// ═════════════════════════════════════════════════════════════════════════════

/** Turns since last anchor before the topic-drift detector resets state. */
export const ANCHOR_TURNS_BEFORE_RESET = 50;

// ═════════════════════════════════════════════════════════════════════════════
// CLASSIFIER INPUT THRESHOLDS (text length, in characters)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Below this many characters, the response is too short to be a meaningful
 * claim - skip classification. Used by topic-drift, sycophancy-detector,
 * claim-tracker, and verify.
 */
export const MIN_TEXT_LENGTH_FOR_CLASSIFY = 50;
