/**
 * Heuristic fallback functions for critics.
 *
 * Extracted from critic-registry.ts (was inside the CRITICS object literal).
 * Each function is a Tier 1 fallback used when the LLM is unavailable.
 * Pure functions with no dependencies on the CRITICS object (CODE_CHARS
 * is a sibling constant in critic-helpers.ts).
 *
 * Migration: callers that previously did `CRITICS.<name>Fallback(...)`
 * should import the standalone function:
 *
 *   import { inputCodeHeavyFallback } from "./critic-fallbacks.js";
 *   fallback: () => inputCodeHeavyFallback(text)
 */

import { ENTITY_VERBS } from "./critic-helpers.js";

/** Characters that indicate code content. Used by inputCodeHeavyFallback. */
const CODE_CHARS: ReadonlySet<string> = new Set("{}[]();=>+-*/|&<>@#$%^~`\\");

/** Conservative: assume no drift when LLM unavailable. */
export function topicDriftFallback(): string {
  return "no";
}

/**
 * Minimal conservative fallback for contradiction detection.
 * Detects obvious polarity flips via negation patterns on shared terms.
 * Returns "no" when uncertain - LLM tier (Tier 2/3) handles complex cases.
 */
export function contradictionFallback(claim: string, context: string): string {
  const claimLower = claim.toLowerCase();
  const contextLower = context.toLowerCase();

  // Detect negation on same core word (e.g., "supports" vs "does not support")
  const negationWords = [
    ["supports", "does not support"],
    ["supports", "doesn't support"],
    ["supports", "not support"],
    ["works", "doesn't work"],
    ["works", "fails"],
    ["supported", "not supported"],
    ["compatible", "incompatible"],
    ["exists", "doesn't exist"],
    ["correct", "incorrect"],
  ];
  for (const [pos, neg] of negationWords) {
    if (claimLower.includes(pos) && contextLower.includes(neg)) return "yes";
    if (claimLower.includes(neg) && contextLower.includes(pos)) return "yes";
  }

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
 * Legacy heuristic fallback for compression urgency.
 * Returns the existing static-threshold logic from compression-strategy.ts.
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

/** Legacy heuristic fallback for qualitative degradation. Conservative: assume no degradation. */
export function qualitativeDegradationFallback(): string {
  return "STABLE";
}

/** Legacy fallback for error type classification. */
export function errorTypeFallback(errorMsg: string): string {
  if (/429|rate.?limit/i.test(errorMsg)) return "rate_limit";
  if (/5\d\d|server.?error|internal|overloaded|unavailable/i.test(errorMsg)) return "server_error";
  if (/network|connection|fetch failed|socket|timeout|timed out/i.test(errorMsg)) return "network";
  return "unknown";
}

/** Legacy fallback for instruction strength. */
export function instructionStrengthFallback(body: string): string {
  if (/\bSHALL\b/.test(body)) return "SHALL";
  if (/\bMUST\b/.test(body)) return "MUST";
  if (/\bSHOULD\b/.test(body)) return "SHOULD";
  return "MAY";
}

/** Legacy fallback for command type classification. */
export function commandTypeFallback(cmd: string): string {
  if (/\|\s*grep|\|\s*awk|\|\s*sed/.test(cmd) && !/npm|yarn|pnpm|xargs/.test(cmd)) return "pipeline";
  if (/for|while|\$\(/.test(cmd)) return "loop";
  if (/sudo|rm\s|>\s*\/|mv\s+.*\s+.*/.test(cmd)) return "dangerous";
  return "info";
}

/** Heuristic fallback: >30% non-whitespace chars are code-like = code-heavy. */
export function inputCodeHeavyFallback(text: string): string {
  let totalChars = 0;
  let codeChars = 0;
  for (const char of text) {
    if (!/\s/.test(char)) {
      totalChars++;
      if (CODE_CHARS.has(char)) codeChars++;
    }
  }
  return totalChars > 0 && codeChars / totalChars > 0.3 ? "yes" : "no";
}

/** Heuristic fallback: sentence count + capitalization + repeated chars. */
export function inputWellWrittenFallback(text: string): string {
  const sentenceCount = (text.match(/[.!?]+\s/g) || []).length;
  if (sentenceCount < 1) return "no";

  const sentenceEndings = text.split(/[.!?]+(\s|$)/);
  let capitalizedCount = 0;
  let totalSentencesChecked = 0;
  for (const s of sentenceEndings) {
    const trimmed = s.trim();
    if (trimmed.length > 1) {
      totalSentencesChecked++;
      if (/^[A-Z]/.test(trimmed)) capitalizedCount++;
    }
  }
  if (totalSentencesChecked > 0 && capitalizedCount / totalSentencesChecked < 0.5) return "no";
  if (/(.)\1{4,}/.test(text)) return "no";

  return "yes";
}

/** Heuristic fallback: short text + long run-on sentences + contradiction markers. */
export function inputClarityFallback(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length < 3) return "no";
  const sentences = text.split(/[.!?]+/);
  for (const s of sentences) {
    if (s.trim().split(/\s+/).length > 50) return "no";
  }
  const lower = text.toLowerCase();
  const contradictionCount = (
    lower.match(/\b(but|however|actually|wait|no\s+(wait|i mean|actually)|on\s+(the\s+)?other\s+hand)/g) ||
    []
  ).length;
  if (contradictionCount > 2) return "no";
  return "yes";
}

/** Heuristic fallback: vague phrases + single-word messages. */
export function inputAmbiguityFallback(text: string): string {
  const vaguePatterns = [
    /\b(do the needful|fix it|make it work|handle it|take care of it|you know what i mean)\b/i,
    /\b(this|that|it)\b.*\b(thing|stuff|part|bit)\b/i,
    /^\w+$/m,
  ];
  return vaguePatterns.some((p) => p.test(text)) ? "yes" : "no";
}

/** Heuristic fallback: reject very short hints and obvious generic templates. */
export function hintRelevanceFallback(hint: string, _currentTask: string): string {
  if (hint.length < 30) return "no";
  if (/Fix \w+ error:/.test(hint)) return "no";
  if (/Reproduce.*Locate.*Apply/i.test(hint)) return "no";
  return "yes";
}

/**
 * Heuristic fallback for conflict resolution detection.
 * Preserves the original keyword-based logic as graceful degradation.
 */
export function conflictResolutionFallback(text: string): string {
  const lower = text.toLowerCase();
  const keywords = [
    "resolved",
    "conflict resolved",
    "the correct answer is",
    "after further investigation",
    "sources disagree",
  ];
  if (!keywords.some((kw) => lower.includes(kw))) return "none";
  if (
    lower.includes("based on higher reliability source") ||
    lower.includes("the evidence supports") ||
    lower.includes("confirm that")
  )
    return "resolved_for";
  if (lower.includes("evidence does not support") || lower.includes("this claim is incorrect"))
    return "resolved_against";
  return "resolved_for";
}

/** Legacy fallback for polarity detection. */
export function polarityDetectionFallback(sentence: string): string {
  if (/\b(not|no|never|n't|without|lacks|excludes|denies|fails|rejects)\b/i.test(sentence)) return "negative";
  if (/\b(is|was|will|can|does|has|returns|takes|uses|creates|handles|supports|works)\b/i.test(sentence)) return "positive";
  return "neutral";
}

/** Legacy fallback for entity extraction. */
export function entityExtractionFallback(sentence: string): string {
  return ENTITY_VERBS.test(sentence) ? "yes" : "no";
}

/** Legacy fallback for sycophancy tactics detection. */
export function sycophancyFallback(text: string): string {
  const patterns = [
    /\b(I think|I believe|you must (agree|be right)|Surely)\b/i,
    /\b(This is definitely|The code (always|never)|Obviously)\b/i,
    /\b(That (approach|solution) is (wrong|bad)|Why would you)\b/i,
    /\bWhy did you (do|choose|use)/i,
    /\b(Trust me|As a (senior|expert)|Everyone knows)\b/i,
  ];
  return patterns.some((p) => p.test(text)) ? "yes" : "no";
}

/** Legacy fallback for VbC (validation-before-correction) detection. */
export function vbCFallback(text: string): string {
  const patterns = [
    /\b(You('re| are) right\b|That('s| is) a (fair|good) point\b|I understand your (concern|point|perspective)\b)(?=.*\b(however|but actually|the (real|actual) (issue|problem)|having said that)\b).{50,}/is,
    /\b(I agree\b|That makes sense\b|You make a good point\b)(?=.*\b(however|but|yet|nevertheless|on the other hand)\b).{50,}/is,
    /\bI think you('re| are) right\b(?=.*\b(but|however)\b).{50,}/is,
    /\b(While|Although|Even though) (you('re| are) (right|correct)|that('s| is) valid)\b.{30,}actually\b.{20,}/is,
  ];
  return patterns.some((p) => p.test(text)) ? "yes" : "no";
}
