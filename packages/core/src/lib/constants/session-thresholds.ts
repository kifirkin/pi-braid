/**
 * Session/Time-Based Thresholds - durations, ages, and rotation limits,
 * centralized so they are not scattered as magic numbers like
 * `7 * 24 * 60 * 60 * 1000` or `5 * 60 * 1000`.
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

/**
 * Per-call-site cooldown for the 3 enforcement nudge sites that share
 * a single time-based gate (redundancy check, failure recording, auto
 * retry end). Distinct from the 5-minute `NUDGE_COOLDOWN_MS` which is
 * a cross-session cap; this is the per-site rate-limit value.
 *
 * EW-7.8: promote to constant. The "remove" path (delete the field,
 * rely on NudgeManager) needs per-NudgeType cooldown decisions and
 * is deferred.
 */
export const ERROR_TRACKING_NUDGE_COOLDOWN_MS = 60_000; // 1 minute

// ═════════════════════════════════════════════════════════════════════════════
// CROSS-SESSION MEMORY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Max age of a hint before it is dropped (consolidated-hints.jsonl):
 * 7d - hints older than a
 * week rarely match the current project/task context well enough to steer,
 * so the drop cadence matches their useful life.
 */
export const HINT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
