/**
 * Roast Filter — Utility-model pre-classification for input-polisher.
 *
 * Each check is a lightweight yes/no classification call to the configured
 * utility model (or session model fallback). The utility model "roasts"
 * (critiques) the input quality and intention before the polisher acts.
 *
 * Three-tier fallback: utility model → session model → heuristic.
 * Heuristics are preserved as graceful degradation, not the primary path.
 *
 * This eliminates 18+ fragile regex patterns and heuristic thresholds
 * from the input-polisher, replacing them with grounded NLP classification.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { classify, type ClassificationResult } from "../../../lib/text-classifier.js";

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

// ── Roast Filter ─────────────────────────────────────────────────────────────

export interface RoastResult {
  /** True if the text is primarily code — skip polishing. */
  isCode: boolean;
  /** True if the text is well-written — skip polishing. */
  isWellWritten: boolean;
  /** True if the text asks to write code — append anti-slop suffix. */
  isCodeRequest: boolean;
  /** Lowest-confidence tier across all three checks. */
  tier: "utility" | "session" | "heuristic";
  /** Per-check results for observability. */
  checks: {
    codeHeavy: ClassificationResult;
    wellWritten: ClassificationResult;
    codeRequest: ClassificationResult;
  };
}

/**
 * Run all three roast checks in parallel.
 *
 * Each check runs classify() with its own heuristic fallback.
 * If the utility model is configured, all three finish in ~50ms parallel.
 * If not configured, all three use the session model (~100ms parallel).
 * If no model works, all three use heuristics (~0.03ms).
 */
export async function roastInput(text: string, ctx: ExtensionContext): Promise<RoastResult> {
  // Truncate very long text to keep prompt tokens reasonable
  const truncated = text.length > 2000 ? text.slice(0, 2000) + "..." : text;

  const [codeResult, wellWrittenResult, codeRequestResult] = await Promise.all([
    classify(
      ctx,
      CODE_HEAVY_CRITERIA,
      { text: truncated },
      {
        maxTokens: 5,
        timeoutMs: 5000,
        fallback: () => isCodeHeavyFallback(text),
      },
    ),
    classify(
      ctx,
      WELL_WRITTEN_CRITERIA,
      { text: truncated },
      {
        maxTokens: 5,
        timeoutMs: 5000,
        fallback: () => isWellWrittenFallback(text),
      },
    ),
    classify(
      ctx,
      CODE_REQUEST_CRITERIA,
      { text: truncated },
      {
        maxTokens: 5,
        timeoutMs: 5000,
        fallback: () => isCodeRequestFallback(text),
      },
    ),
  ]);

  // Determine the overall tier (lowest confidence across all three)
  const tiers = [codeResult.tier, wellWrittenResult.tier, codeRequestResult.tier];
  const overallTier = tiers.includes("heuristic")
    ? ("heuristic" as const)
    : tiers.includes("session")
      ? ("session" as const)
      : ("utility" as const);

  return {
    isCode: codeResult.label === "yes",
    isWellWritten: wellWrittenResult.label === "yes",
    isCodeRequest: codeRequestResult.label === "yes",
    tier: overallTier,
    checks: {
      codeHeavy: codeResult,
      wellWritten: wellWrittenResult,
      codeRequest: codeRequestResult,
    },
  };
}

/**
 * Anti-slop suffix appended when the roast filter detects a code-writing request.
 * Tells the assistant to output code directly without explanation.
 */
export const CODE_SUFFIX =
  "\n\nOutput the code directly. Do not explain, analyze, or describe it — output only the code.";
