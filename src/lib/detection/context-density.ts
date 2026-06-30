/**
 * Context Information Density Evaluator
 *
 * Measures signal-to-noise ratio in context to predict when context management
 * is needed. Based on:
 *   - SimpleMem (2601.02553): 30x token reduction via semantic structured compression
 *   - GenericAgent (2604.17091): Information density, not length, determines performance
 *
 * Key insight: Count-based thresholds miss the real problem. A 50-message context with
 * high signal is better than a 10-message context with mostly boilerplate.
 *
 * Density evaluation uses a two-tier approach:
 *   Tier 1 (default): Fast heuristic - token counting + sample-based LLM judge
 *   Tier 2 (opt-in): Full LLM judge via contextDensity critic for holistic assessment
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify } from "../ai/text-classifier.js";
import { CRITICS } from "../ai/critic-registry.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DensityResult {
  /** Signal / (signal + noise), 0-1. Higher = more informative context. */
  density: number;
  /** Messages with meaningful, non-boilerplate content. */
  signalMessages: number;
  /** Messages that are pure boilerplate, duplication, or noise. */
  noisyMessages: number;
  /** Messages that appear nearly identical to previous messages. */
  duplicates: number;
  /** Estimated token count of context. */
  totalTokens: number;
  /** tokens / tokenLimit, 0-1. */
  tokenRatio: number;
  /** LLM judge density label if evaluateContextDensityWithJudge was used. */
  judgeLabel?: "HIGH" | "MEDIUM" | "LOW";
}

export type CompressionStrategy = "aggressive" | "semantic" | "conservative" | "none";

const MIN_SIGNAL_LENGTH = 30;
const CHARS_PER_TOKEN = 4;

function countTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Simple string hash for duplicate detection. */
function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < Math.min(s.length, 200); i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

// ── Main Evaluator (heuristic + optional LLM judge) ──────────────────────────

/**
 * Evaluate the information density of a session's context.
 *
 * Uses fast heuristic (token counting + hash-based dedup). For semantic
 * density assessment, call evaluateContextDensityWithJudge() instead.
 *
 * @param ctx - ExtensionContext to access session entries
 * @returns DensityResult with aggregate metrics
 */
export function evaluateContextDensity(ctx: ExtensionContext): DensityResult {
  let entries: any[] = [];
  try {
    entries = ctx.sessionManager?.getEntries?.() ?? [];
  } catch {
    /* fallback: empty */
  }

  let totalTokens = 0;
  let signalMessages = 0;
  let noisyMessages = 0;
  let duplicates = 0;

  // Deduplication: track recent message hashes
  const recentHashes = new Set<string>();
  const MAX_RECENT = 20;

  for (const entry of entries) {
    let content = "";

    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((c: any) => c.text ?? "").join(" ")
            : "";
    } else if (entry.type === "tool_result" && entry.result) {
      content = typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result);
    } else if (entry.type === "custom") {
      // Skip custom entries (memory, retry state, etc.)
      continue;
    }

    if (!content) continue;

    const tokens = countTokens(content);
    const clean = content.trim();
    const isTooShort = clean.length < MIN_SIGNAL_LENGTH;

    // Duplicate detection: hash of first 200 chars + length
    const hashKey = `${simpleHash(clean)}:${clean.length}`;
    const isDuplicate = recentHashes.has(hashKey);
    if (isDuplicate) duplicates++;
    recentHashes.add(hashKey);
    if (recentHashes.size > MAX_RECENT) {
      const first = recentHashes.values().next().value;
      if (first !== undefined) recentHashes.delete(first);
    }

    totalTokens += tokens;
    if (isTooShort || isDuplicate) noisyMessages++;
    else signalMessages++;
  }

  const tokenLimit = 100_000; // Default 100k tokens (adjust per model)
  const tokenRatio = tokenLimit > 0 ? Math.min(totalTokens / tokenLimit, 1) : 0;
  const totalMessages = signalMessages + noisyMessages;
  const density = totalMessages > 0 ? signalMessages / totalMessages : 1;

  return { density, signalMessages, noisyMessages, duplicates, totalTokens, tokenRatio };
}

// ── LLM Judge Evaluation ─────────────────────────────────────────────────────

/**
 * Evaluate context density using an LLM judge for semantic assessment.
 *
 * Samples messages from the context and uses classify() with the
 * contextDensity critic to assess signal-to-noise ratio holistically.
 * Falls back to fast heuristic when LLM is unavailable.
 *
 * Call this when you need a deeper understanding of context quality
 * (e.g., before deciding whether to compress or archive).
 *
 * @param ctx - ExtensionContext
 * @returns DensityResult with an additional judgeLabel field
 */
export async function evaluateContextDensityWithJudge(
  ctx: ExtensionContext,
): Promise<DensityResult> {
  const base = evaluateContextDensity(ctx);

  // Build a sample of message content for the judge
  let entries: any[] = [];
  try {
    entries = ctx.sessionManager?.getEntries?.() ?? [];
  } catch {
    /* fallback */
  }

  // Sample up to 10 messages: evenly spaced across the context
  const sampleSize = Math.min(10, entries.length);
  const step = entries.length > sampleSize ? Math.floor(entries.length / sampleSize) : 1;
  const sample: string[] = [];
  for (let i = 0; i < entries.length && sample.length < sampleSize; i += step) {
    const entry = entries[i];
    let text = "";
    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      text =
        typeof msg.content === "string"
          ? msg.content.slice(0, 200)
          : Array.isArray(msg.content)
            ? msg.content.map((c: any) => (c.text ?? "").slice(0, 100)).join(" ")
            : "";
    } else if (entry.type === "tool_result" && entry.result) {
      text = (typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result)).slice(
        0,
        200,
      );
    }
    if (text.trim()) sample.push(`[${entry.type}] ${text}`);
  }

  const messagesText = sample.map((m, i) => `--- Message ${i + 1} ---\n${m}`).join("\n\n");

  try {
    const result = await classify(
      ctx,
      CRITICS.contextDensity.criteria,
      { sampleCount: String(sample.length), messages: messagesText },
      { timeoutMs: 60_000, label: CRITICS.contextDensity.label },
    );

    const label = result.label.toUpperCase() as "HIGH" | "MEDIUM" | "LOW";
    const judgeLabel = label === "HIGH" || label === "MEDIUM" || label === "LOW" ? label : undefined;

    return { ...base, judgeLabel };
  } catch {
    // LLM unavailable - return base heuristic result
    return base;
  }
}

// ── Compression Strategy Recommendation ───────────────────────────────────────────

/**
 * Recommend a compression strategy based on context density.
 *
 * Low density (< 0.4):     Aggressive pruning - remove noise, keep signal
 * Medium density (0.4-0.7): Semantic compression - summarize without losing meaning
 * High density (> 0.7):     Conservative - only compress if context is large
 */
export function recommendCompressionStrategy(density: DensityResult): CompressionStrategy {
  // If LLM judge says LOW density, escalate
  if (density.judgeLabel === "LOW") return "aggressive";

  if (density.tokenRatio > 0.85) {
    return density.density < 0.4 ? "aggressive" : "semantic";
  }
  if (density.tokenRatio > 0.6) {
    if (density.density < 0.4) return "semantic";
    if (density.density < 0.6) return "conservative";
    return "none";
  }
  return "none";
}
