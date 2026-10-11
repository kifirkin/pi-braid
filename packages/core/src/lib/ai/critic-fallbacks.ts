/**
 * Heuristic fallback functions for critics.
 *
 * Each function is a Tier 1 fallback used when the LLM is unavailable.
 * Pure functions with no dependencies on the CRITICS object (CODE_CHARS
 * is a sibling constant in critic-helpers.ts). A CRITICS entry wires one
 * in as:
 *
 *   import { topicDriftFallback } from "./critic-fallbacks.js";
 *   fallback: () => topicDriftFallback()
 */

/** Conservative: assume no drift when LLM unavailable. */
export function topicDriftFallback(): string {
  return "no";
}

/** Conservative fallback for tool loop detection. Returns "no" - LLM tier handles actual detection. */
export function toolLoopFallback(_toolSequences: string): string {
  return "no";
}

/** Conservative fallback for evidence conflict detection. Returns "no" - LLM tier handles actual detection. */
export function evidenceConflictFallback(_a: string, _b: string): string {
  return "no";
}

/** Conservative fallback for hint quality. Returns "yes" (allow through) - LLM tier handles filtering. */
export function hintQualityFallback(_task: string, _steps: string[]): string {
  return "yes";
}

/**
 * Heuristic fallback for compression urgency: the static-threshold logic
 * from compression-strategy.ts.
 */
export function compressionUrgencyFallback(opts: {
  turnsSinceCompression: number;
  totalTurns: number;
  consecutiveFailures: number;
  reasoningDepth: number;
  messageCount: number;
}): string {
  if (opts.consecutiveFailures >= 3) return "AGGRESSIVE";
  if (opts.totalTurns >= 80) return "AGGRESSIVE";
  if (opts.totalTurns >= 30 && opts.reasoningDepth > 3) return "SEMANTIC";
  if (opts.totalTurns >= 30 && opts.turnsSinceCompression > 40) return "SEMANTIC";
  if (opts.totalTurns >= 10 && opts.messageCount > 50) return "CONSERVATIVE";
  return "NONE";
}

/** Heuristic fallback for error type classification. */
export function errorTypeFallback(errorMsg: string): string {
  if (/429|rate.?limit/i.test(errorMsg)) return "rate_limit";
  if (/5\d\d|server.?error|internal|overloaded|unavailable/i.test(errorMsg)) return "server_error";
  if (/network|connection|fetch failed|socket|timeout|timed out/i.test(errorMsg)) return "network";
  return "unknown";
}

/** Heuristic fallback for instruction strength. */
export function instructionStrengthFallback(body: string): string {
  if (/\bSHALL\b/.test(body)) return "SHALL";
  if (/\bMUST\b/.test(body)) return "MUST";
  if (/\bSHOULD\b/.test(body)) return "SHOULD";
  return "MAY";
}

/** Heuristic fallback: reject very short hints and obvious generic templates. */
export function hintRelevanceFallback(hint: string, _currentTask: string): string {
  if (hint.length < 30) return "no";
  if (/Fix \w+ error:/.test(hint)) return "no";
  if (/Reproduce.*Locate.*Apply/i.test(hint)) return "no";
  return "yes";
}
