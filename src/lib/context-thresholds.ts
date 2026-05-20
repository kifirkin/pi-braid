/**
 * Context Management Thresholds — single source of truth.
 *
 * Separates two semantically distinct concepts:
 *   CONTEXT_USAGE — how full the token window is (% of limit filled)
 *   DENSITY      — signal-to-noise ratio of content (0-1)
 *
 * Tune these values to adjust reminder cadence without hunting through 6+ files.
 */

// ═════════════════════════════════════════════════════════════════════════════
// CONTEXT USAGE THRESHOLDS (% of context window filled)
// ═════════════════════════════════════════════════════════════════════════════

/** First soft whisper — gentle suggestion to archive completed work. */
export const USAGE_WHISPER_SOFT = 40;

/** Advisory — suggest specific action (context_archive / finalize). */
export const USAGE_WHISPER_ADVISORY = 50;

/** Warning — stronger language, medium priority. */
export const USAGE_WHISPER_WARNING = 60;

/** Critical — high priority, suggest immediate action. */
export const USAGE_WHISPER_CRITICAL = 75;

/** Auto-compaction: medium level at this usage. */
export const USAGE_COMPACT_MEDIUM = 80;

/** Auto-compaction: aggressive level at this usage. */
export const USAGE_COMPACT_AGGRESSIVE = 90;

/** Reset the fired-threshold set when usage drops below this. */
export const USAGE_FIRED_RESET_BELOW = 50;

// ═════════════════════════════════════════════════════════════════════════════
// DENSITY THRESHOLDS (signal/noise ratio, 0-1)
// ═════════════════════════════════════════════════════════════════════════════

/** Below this → "low density" signal emitted → suggest pruning. */
export const DENSITY_LOW = 0.4;

/** Below this → high-priority density whisper. */
export const DENSITY_VERY_LOW = 0.25;

/** Above this (when token ratio also high) → "high density" signal. */
export const DENSITY_HIGH = 0.7;

/** Token ratio above this → large-context whisper fires alongside density checks. */
export const TOKEN_RATIO_LARGE_CONTEXT = 0.6;

/** Analytics: emit context_full event when density exceeds this (NOT usage). */
export const ANALYTICS_DENSITY_FULL_EVENT = 70;

// ═════════════════════════════════════════════════════════════════════════════
// CONTEXT HYGIENE MODULE CONSTANTS
// ═════════════════════════════════════════════════════════════════════════════

/** Consecutive low-density ticks before suggesting auto-compact. */
export const HYGIENE_LOW_DENSITY_CONSECUTIVE_MIN = 2;

/** Cooldown between low-density whisphers (turns). */
export const HYGIENE_DENSITY_WHISPER_COOLDOWN_TURNS = 20;

/** Cooldown between large-context whispers (turns). */
export const HYGIENE_LARGE_CONTEXT_COOLDOWN_TURNS = 15;

/** Cooldown between auto-compact suggestions (turns). */
export const HYGIENE_AUTO_COMPACT_COOLDOWN_TURNS = 15;