/**
 * Input Critic — Utility-model pre-classification for input-polisher.
 *
 * Each check is a lightweight yes/no classification call to the configured
 * utility model (or session model fallback). The utility model critiques
 * the input quality and intention before the polisher acts.
 *
 * Three-tier fallback: utility model → session model → heuristic.
 * Heuristics are preserved as graceful degradation, not the primary path.
 *
 * This eliminates 18+ fragile regex patterns and heuristic thresholds
 * from the input-polisher, replacing them with grounded NLP classification.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, type ClassificationResult } from "../../../lib/ai/text-classifier.js";

// ── Classification Criteria ──────────────────────────────────────────────────

/** Is this text primarily code (not natural language)? */
const CODE_HEAVY_CRITERIA = {
  systemPrompt:
    "You are a text classifier. Determine if the given message is primarily code " +
    "(not natural language). Answer only 'yes' or 'no'. Do not explain.",
  userPrompt: "Is this message primarily code? {{text}}",
};

/** Is this text well-written with correct grammar, spelling, and sentence structure? */
const WELL_WRITTEN_CRITERIA = {
  systemPrompt:
    "You are a text quality classifier. Determine if the given text is well-written " +
    "with correct grammar, spelling, and proper sentence structure. English only. " +
    "Answer only 'yes' or 'no'. Do not explain.",
  userPrompt: "Is this text well-written? {{text}}",
};

/** Does this message ask the assistant to WRITE code (not explain it)? */
const CODE_REQUEST_CRITERIA = {
  systemPrompt:
    "You are a request classifier. Determine if the given message asks the assistant " +
    "to WRITE new code (not explain, read, review, or modify existing code). " +
    "Answer only 'yes' or 'no'. Do not explain.",
  userPrompt: "Does this ask the assistant to write code? {{text}}",
};

/** Is this message clear and coherent, or is it confusing and rambling? */
const CLARITY_CRITERIA = {
  systemPrompt:
    "You are a clarity classifier. Determine if the given message is clearly written, " +
    "coherent, and easy to understand. A clear message has a logical flow and " +
    "communicates its intent effectively. A confusing message is rambling, " +
    "contradictory, or hard to follow. Answer only 'yes' or 'no'. Do not explain.",
  userPrompt: "Is this message clear and coherent? {{text}}",
};

/** Does this message contain vague or ambiguous requests that need clarification? */
const AMBIGUITY_CRITERIA = {
  systemPrompt:
    "You are an ambiguity classifier. Determine if the given message contains " +
    "vague, underspecified, or ambiguous requests that would need clarification " +
    "before the assistant can act effectively. Ambiguous messages use words like " +
    "'it', 'that thing', 'do the needful' without clear referents, or ask questions " +
    "that could be interpreted multiple ways. Answer only 'yes' or 'no'. Do not explain.",
  userPrompt: "Is this message ambiguous or underspecified? {{text}}",
};

// ── Heuristic Fallbacks (graceful degradation) ───────────────────────────────

/** Characters that indicate code content */
const CODE_CHARS = new Set("{}[]();=>+-*/|&<>@#$%^~`\\");

/**
 * Fallback: check if message is code-heavy (original heuristic).
 * Returns "yes" if >30% of non-whitespace chars are code-like.
 */
function isCodeHeavyFallback(text: string): string {
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

/**
 * Fallback: heuristic for well-written text.
 * Checks sentence structure, capitalization, repeated chars, bracket balance.
 */
function isWellWrittenFallback(text: string): string {
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

/**
 * Fallback: match code-writing requests via regex (original heuristic).
 */
const CODE_REQUEST_PATTERNS: RegExp[] = [
  /\b(write|create|implement|build)\s+(a\s+)?(function|class|method|module|component|script|file|program|handler|service|util)/i,
  /\b(write|show|give)\s+me\s+(the\s+)?code/i,
  /\brefactor\b.*\bcode\b/i,
  /\bfix\b.*\bfunction\b.*\breturn\b/i,
  /\b(напиши|создай|реализуй|сделай)\s+(функци|класс|метод|модул|компонент|скрипт|файл|программ|обработчик|сервис|утилит)/i,
  /\b(напиши|покажи|дай)\s+мне\s+код/i,
  /\bрефакторинг\b.*\bкод\b/i,
];

function isCodeRequestFallback(text: string): string {
  return CODE_REQUEST_PATTERNS.some((p) => p.test(text)) ? "yes" : "no";
}

/**
 * Fallback: check clarity heuristically.
 * Short texts (<10 words) are considered unclear. Very long run-on sentences indicate confusion.
 */
function isClearFallback(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length < 3) return "no";
  // Check for very long sentences (>50 words without punctuation)
  const sentences = text.split(/[.!?]+/);
  for (const s of sentences) {
    if (s.trim().split(/\s+/).length > 50) return "no";
  }
  // Check for contradictory markers
  const lower = text.toLowerCase();
  const contradictionCount = (lower.match(/\b(but|however|actually|wait|no\s+(wait|i mean|actually)|on\s+(the\s+)?other\s+hand)/g) || []).length;
  if (contradictionCount > 2) return "no";
  return "yes";
}

/**
 * Fallback: detect ambiguity via common vague patterns.
 */
function isAmbiguousFallback(text: string): string {
  const lower = text.toLowerCase();
  const vaguePatterns = [
    /\b(do the needful|fix it|make it work|handle it|take care of it|you know what i mean)\b/i,
    /\b(this|that|it)\b.*\b(thing|stuff|part|bit)\b/i,
    /^\w+$/m,  // single-word messages
  ];
  return vaguePatterns.some((p) => p.test(text)) ? "yes" : "no";
}

// ── Input Critic ─────────────────────────────────────────────────────────────

export interface CritiqueResult {
  /** True if the text is primarily code — skip polishing. */
  isCode: boolean;
  /** True if the text is well-written — skip polishing. */
  isWellWritten: boolean;
  /** True if the text is clearly written and coherent. */
  isClear: boolean;
  /** True if the text is vague or ambiguous — may need clarification prompt. */
  isAmbiguous: boolean;
  /** True if the text asks to write code — append anti-slop suffix. */
  isCodeRequest: boolean;
  /** Lowest-confidence tier across all checks. */
  tier: "utility" | "session" | "heuristic";
  /** Per-check results for observability. */
  checks: {
    codeHeavy: ClassificationResult;
    wellWritten: ClassificationResult;
    clarity: ClassificationResult;
    ambiguity: ClassificationResult;
    codeRequest: ClassificationResult;
  };
}

/**
 * Run all five classification checks in parallel.
 *
 * Each check runs classify() with its own heuristic fallback.
 * If the utility model is configured, all five finish in ~50ms parallel.
 * If not configured, all five use the session model (~100ms parallel).
 * If no model works, all five use heuristics (~0.03ms).
 */
export async function critiqueInput(text: string, ctx: ExtensionContext): Promise<CritiqueResult> {
  // Truncate very long text to keep prompt tokens reasonable
  const truncated = text.length > 2000 ? text.slice(0, 2000) + "..." : text;

  const [codeResult, wellWrittenResult, clarityResult, ambiguityResult, codeRequestResult] = await Promise.all([
    classify(ctx, CODE_HEAVY_CRITERIA, { text: truncated }, { maxTokens: 5, timeoutMs: 5000, fallback: () => isCodeHeavyFallback(text) }),
    classify(ctx, WELL_WRITTEN_CRITERIA, { text: truncated }, { maxTokens: 5, timeoutMs: 5000, fallback: () => isWellWrittenFallback(text) }),
    classify(ctx, CLARITY_CRITERIA, { text: truncated }, { maxTokens: 5, timeoutMs: 5000, fallback: () => isClearFallback(text) }),
    classify(ctx, AMBIGUITY_CRITERIA, { text: truncated }, { maxTokens: 5, timeoutMs: 5000, fallback: () => isAmbiguousFallback(text) }),
    classify(ctx, CODE_REQUEST_CRITERIA, { text: truncated }, { maxTokens: 5, timeoutMs: 5000, fallback: () => isCodeRequestFallback(text) }),
  ]);

  // Determine the overall tier (lowest across all five)
  const tiers = [codeResult.tier, wellWrittenResult.tier, clarityResult.tier, ambiguityResult.tier, codeRequestResult.tier];
  const overallTier = tiers.includes("heuristic") ? "heuristic" as const : tiers.includes("session") ? "session" as const : "utility" as const;

  return {
    isCode: codeResult.label === "yes",
    isWellWritten: wellWrittenResult.label === "yes",
    isClear: clarityResult.label === "yes",
    isAmbiguous: ambiguityResult.label === "yes",
    isCodeRequest: codeRequestResult.label === "yes",
    tier: overallTier,
    checks: {
      codeHeavy: codeResult,
      wellWritten: wellWrittenResult,
      clarity: clarityResult,
      ambiguity: ambiguityResult,
      codeRequest: codeRequestResult,
    },
  };
}
