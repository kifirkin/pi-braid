import { tokenArms } from "./context-usage.js";
/**
 * Context Management Thresholds - single source of truth.
 *
 * Separates two semantically distinct concepts:
 *   CONTEXT_USAGE - how full the token window is (% of limit filled)
 *   DENSITY      - signal-to-noise ratio of content (0-1)
 *
 * Tune these values to adjust reminder cadence without hunting through 6+ files.
 */

// CONTEXT USAGE THRESHOLDS (% of context window filled)

/** First soft whisper - inspect context, start tracking. */
export const USAGE_WHISPER_SOFT = 30;

/** Advisory - suggest light pruning or archiving completed work. */
export const USAGE_WHISPER_ADVISORY = 50;

/** Warning - suggest deep compaction and compression. */
export const USAGE_WHISPER_WARNING = 65;

/** Critical - high priority, force immediate hygiene. */
export const USAGE_WHISPER_CRITICAL = 75;

/** Auto-compaction: medium level at this usage. */
export const USAGE_COMPACT_MEDIUM = 80;

/** Auto-compaction: aggressive level at this usage. */
export const USAGE_COMPACT_AGGRESSIVE = 90;

/** Reset the fired-threshold set when usage drops below this. */
export const USAGE_FIRED_RESET_BELOW = 50;

/**
 * Compaction hard-refuse threshold: above this usage percent, destructive
 * AI-supervised compaction is refused/redirected to deterministic slide-mode
 * (max-call-stack crash + session-corruption guard at high usage).
 *
 * Single home for the 70% compaction-refusal literals: the context_compress(action="compact")
 * refusal, the session_before_compact slide guard, the compaction
 * summarization-aggressiveness tier, the audit branching trigger, and the
 * context_inspect steer bands. Consumers import this constant; do not
 * restate the number. Behavior note: it is a hard ceiling for LLM-supervised
 * compaction, NOT an auto-compact trigger (that is USAGE_COMPACT_MEDIUM).
 */
export const CONTEXT_COMPACT_REFUSE_PERCENT = 70;

// TOKEN-COUNT THRESHOLDS (absolute tokens, model-agnostic early warnings)
// Percent arms fire too late on large or configured windows, so the token
// ladder is expressed as fractions of the resolved window W (the same value
// the live metric reports): soft 0.18W, advisory 0.30W, warning 0.45W,
// act min(0.60W, ACT_ARM_TOKEN_CEILING), escalate 0.85W, backstop 0.90W.
// The numeric table lives in lib/detection/context-usage.ts (tokenArms);
// these thin accessors keep the long-standing names. A configured window change
// is reflected without a code edit because the resolver reads settings on
// every call.

/**
 * Turn-end ACT re-arm: the token arm that gates the hygiene act
 * (min(0.60W, ACT_ARM_TOKEN_CEILING)).
 */
export function USAGE_TOKENS_CRITICAL(window?: number | null): number {
  return tokenArms(window).act;
}

/**
 * Turn-end auto-compact HARD BACKSTOP (0.90W): bounds runaway growth the
 * re-arm spacing could otherwise sail past between checks.
 */
export function HYGIENE_AUTO_COMPACT_HARD_BACKSTOP(window?: number | null): number {
  return tokenArms(window).backstop;
}

/**
 * ADVISORY ESCALATION BAND (0.85W): distinct from the backstop so both arms
 * can be evaluated in order; escalate wording fires first, backstop acts.
 */
export function USAGE_TOKENS_ESCALATE(window?: number | null): number {
  return tokenArms(window).escalate;
}

/**
 * Turn-end auto-compact re-arm spacing (turns between hygiene ACTs).
 * The ACT may fire again once this many turns have passed since the last
 * attempt, for every arm (token, percent, backstop): the turn-based
 * cooldown guarantees the act cannot run every turn.
 */
export const HYGIENE_AUTO_COMPACT_MIN_TURNS = 3;

// DENSITY THRESHOLDS (signal/noise ratio, 0-1)

/** Below this -> "low density" signal emitted -> suggest pruning. */
export const DENSITY_LOW = 0.4;

/** Below this -> high-priority density whisper. */
export const DENSITY_VERY_LOW = 0.25;

/** Above this (when token ratio also high) -> "high density" signal. */
export const DENSITY_HIGH = 0.7;

/** Token ratio above this -> large-context whisper fires alongside density checks. */
export const TOKEN_RATIO_LARGE_CONTEXT = 0.6;

/** Analytics: emit context_full event when density exceeds this (NOT usage). */
export const ANALYTICS_DENSITY_FULL_EVENT = 70;

// CONTEXT HYGIENE MODULE CONSTANTS

/** Consecutive low-density ticks before suggesting auto-compact. */
export const HYGIENE_LOW_DENSITY_CONSECUTIVE_MIN = 2;

/** Cooldown between low-density whisphers (turns). */
export const HYGIENE_DENSITY_WHISPER_COOLDOWN_TURNS = 20;

/** Cooldown between large-context whispers (turns). */
export const HYGIENE_LARGE_CONTEXT_COOLDOWN_TURNS = 15;

/**
 * Cooldown between auto-compact SUGGESTION whispers (heartbeat context-hygiene
 * module cadence). The turn-end hygiene ACT itself spaces acts with
 * HYGIENE_AUTO_COMPACT_MIN_TURNS across all arms.
 */
export const HYGIENE_AUTO_COMPACT_COOLDOWN_TURNS = 15;

/**
 * Watchdog escalation injection budget per condition per session: after this many escalation injections for one
 * condition, only a crossing of the final REWARN_MILESTONE (500) still
 * escalates. Caps the watchdog's own contribution to context mass (the
 * measured 143-escalation flap storm carried 33.6k chars, 5.1% of peak).
 */
export const WATCHDOG_ESCALATION_BUDGET_PER_SESSION = 12;
