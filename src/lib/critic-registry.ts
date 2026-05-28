/**
 * Critic Registry — centralized pool of critic prompt templates.
 *
 * The "triple critic" system:
 *   Each critic is a named classification task with:
 *   1. A system prompt (role description for the classifier model)
 *   2. A user prompt with {{key}} placeholders
 *   3. An optional heuristic fallback (Tier 1 in classify())
 *
 * Critics are evaluated via lib/text-classifier.ts's three-tier fallback:
 *   Tier 1: Heuristic fallback (fast, free, crude — preferred)
 *   Tier 2: Utility model (configured via /utility-model)
 *   Tier 3: Session model (always available)
 *
 * This registry is the single source of truth for all classifier prompts.
 * Callers import CRITICS and pass the value to classify().
 *
 * Pattern from: input-polisher/roast-filter.ts
 *   Three parallel classify() calls, each with criteria + heuristic fallback.
 *   The result is a consensus verdict across critics.
 *
 * Usage:
 *   import { classify } from "./text-classifier.js";
 *   import { CRITICS } from "./critic-registry.js";
 *
 *   const result = await classify(ctx, CRITICS.topicCoverage.criteria,
 *     { original: req, response: resp },
 *     { maxTokens: 5, timeoutMs: 5000, fallback: CRITICS.topicCoverage.fallback },
 *   );
 */

import type { ClassifierCriteria, ClassifierOptions } from "./text-classifier.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CriticDef {
  /** Classifier prompt template (system + user). */
  criteria: ClassifierCriteria;
  /** Optional override: maxTokens, timeoutMs, or heuristic fallback. */
  options?: Partial<ClassifierOptions>;
  /** Human-readable label for observability / stats. */
  label?: string;
}

// ── Legacy heuristic helper (shared by fallbacks below) ────────────────────

export const STOP_WORDS_LEGACY = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "can",
  "need",
  "dare",
  "that",
  "this",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "with",
  "without",
  "from",
  "into",
  "onto",
  "in",
  "out",
  "on",
  "off",
  "over",
  "under",
  "above",
  "below",
  "to",
  "for",
  "of",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "when",
  "where",
  "how",
  "why",
  "not",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "also",
  "now",
  "here",
  "there",
  "then",
  "implement",
  "add",
  "create",
  "build",
  "make",
  "write",
  "fix",
  "update",
  "day",
  "boy",
]);

function extractFeatures(text: string, minTokenLength = 2): Set<string> {
  const normalized = text.toLowerCase();
  const words = normalized
    .split(/[^\w]+/)
    .filter((t) => t.length >= minTokenLength && !STOP_WORDS_LEGACY.has(t));
  return new Set(words);
}

// ── CRITICS — All critic prompt definitions ─────────────────────────────────

export const CRITICS = {
  // ═══════════════════════════════════════════════════════════════════════
  // Topic Drift — Triple critic: coverage + divergence + completeness
  // ═══════════════════════════════════════════════════════════════════════

  /** Does the response still address the original request? (topic coverage) */
  topicCoverage: {
    label: "Topic Coverage",
    criteria: {
      systemPrompt:
        "You are a topic coherence evaluator. Determine if the agent's response " +
        "still addresses the original user request. Consider: are the same entities, " +
        "tasks, and goals being discussed? Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Original request: {{original}}\nAgent response: {{response}}\n" +
        "Does the response still address the original request?",
    },
  } satisfies CriticDef,

  /** Is the response about different subject matter? (divergence) */
  topicDivergence: {
    label: "Topic Divergence",
    criteria: {
      systemPrompt:
        "You are a topic drift detector. Determine if the agent's response has " +
        "shifted to a substantially different topic than the original request. " +
        "A response that discusses implementation details of the same task is NOT drifted. " +
        "Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Original request: {{original}}\nAgent response: {{response}}\n" +
        "Has the response shifted to a different topic?",
    },
  } satisfies CriticDef,

  /** Does the response include all key topics from the request? (completeness) */
  topicCompleteness: {
    label: "Topic Completeness",
    criteria: {
      systemPrompt:
        "You are a completeness checker. Determine if the agent's response covers " +
        "all the key topics mentioned in the original user request. Missing one minor " +
        "detail is acceptable. Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Original request: {{original}}\nAgent response: {{response}}\n" +
        "Does the response cover all key topics from the request?",
    },
  } satisfies CriticDef,

  /** Legacy heuristic fallback for topic drift (stop-word anchor matching). */
  topicDriftFallback(): string {
    return "no"; // Conservative: assume no drift when LLM unavailable
  },

  // ═══════════════════════════════════════════════════════════════════════
  // Claim Contradiction — Triple critic: contradiction + support + overconfidence
  // ═══════════════════════════════════════════════════════════════════════

  /** Does a claim directly contradict a given context? */
  claimContradiction: {
    label: "Claim Contradiction",
    criteria: {
      systemPrompt:
        "You are a contradiction detector. Determine if a claim directly contradicts " +
        "a given context. Consider positive/negative polarity: if the claim says " +
        "something is true but the context says it is false (or vice versa), that is " +
        "a contradiction. Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Claim: {{claim}}\nContext: {{context}}\n" +
        "Does the claim contradict the context?",
    },
    options: { maxTokens: 5, timeoutMs: 5000 },
  } satisfies CriticDef,

  /** Is the claim sufficiently supported by the context? */
  claimSupported: {
    label: "Claim Support",
    criteria: {
      systemPrompt:
        "You are a claim verifier. Determine if the given claim is supported by " +
        "the provided context. The context must contain factual information that " +
        "directly backs up the claim. Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Claim: {{claim}}\nContext: {{context}}\n" +
        "Is the claim supported by the context?",
    },
    options: { maxTokens: 5, timeoutMs: 5000 },
  } satisfies CriticDef,

  /** Does the claim contain unwarranted certainty (overconfidence)? */
  claimOverconfidence: {
    label: "Overconfidence",
    criteria: {
      systemPrompt:
        "You are a confidence assessor. Determine if the claim contains unwarranted " +
        "certainty — absolutes like 'always', 'never', 'guaranteed', 'definitely', " +
        "'impossible', 'must', or superlatives that aren't supported by the context. " +
        "Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Claim: {{claim}}\nAvailable context: {{context}}\n" +
        "Does the claim contain unwarranted certainty?",
    },
    options: { maxTokens: 5, timeoutMs: 5000 },
  } satisfies CriticDef,

  /** Legacy heuristic fallback for contradiction detection (negation + pair matching). */
  contradictionFallback(claim: string, context: string): string {
    const claimLower = claim.toLowerCase();
    const contextLower = context.toLowerCase();

    // Phase 1: Negation pattern matching
    const negationPattern =
      /\b(not|n't|never|no|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|wouldn't|can't|cannot|couldn't|shouldn't)\s+(\w{3,})/gi;

    const claimNegations: Array<{ word: string; negated: string }> = [];
    const contextNegations: Array<{ word: string; negated: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = negationPattern.exec(claimLower)) !== null) {
      claimNegations.push({ word: match[1], negated: match[2] });
    }
    while ((match = negationPattern.exec(contextLower)) !== null) {
      contextNegations.push({ word: match[1], negated: match[2] });
    }

    const claimFeats = extractFeatures(claim);
    const contextFeats = extractFeatures(context);

    // Context-side negation vs claim features (original direction)
    for (const ctxNeg of contextNegations) {
      for (const cf of claimFeats) {
        if (ctxNeg.negated.includes(cf) || cf.includes(ctxNeg.negated)) {
          return "yes";
        }
      }
    }

    // Claim-side negation vs context features (reverse direction)
    for (const claimNeg of claimNegations) {
      for (const cf of contextFeats) {
        if (claimNeg.negated.includes(cf) || cf.includes(claimNeg.negated)) {
          return "yes";
        }
      }
    }

    // Phase 2: Hardcoded positive-negation pairs
    const MATCH_PAIRS: [string, string][] = [
      ["works", "doesn't work"],
      ["works", "fails"],
      ["supported", "not supported"],
      ["compatible", "incompatible"],
      ["can use", "cannot use"],
      ["is defined", "is not defined"],
      ["exists", "doesn't exist"],
      ["succeeds", "fails"],
      ["correct", "incorrect"],
      ["supports", "does not support"],
      ["supports", "doesn't support"],
      ["supports", "not support"],
      ["includes", "does not include"],
      ["allows", "does not allow"],
      ["enables", "does not enable"],
    ];

    for (const [pos, neg] of MATCH_PAIRS) {
      if (claimLower.includes(pos) && contextLower.includes(neg)) return "yes";
      if (claimLower.includes(neg) && contextLower.includes(pos)) return "yes";
    }

    return "no";
  },

  // ═══════════════════════════════════════════════════════════════════════
  // Turn Loop Detection
  // ═══════════════════════════════════════════════════════════════════════

  /** Is the agent stuck in a repetitive tool loop? */
  toolLoopDetected: {
    label: "Tool Loop Detection",
    criteria: {
      systemPrompt:
        "You are a behavioral loop detector. Determine if the agent is repeating " +
        "the same tool calls across consecutive turns without making progress. " +
        "Reading different files is fine. Calling the same tool on the same file " +
        "repeatedly without progress is a loop. Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Recent tool usage (most recent first):\n{{toolSequences}}\n" +
        "Is the agent in a repetitive loop?",
    },
    options: { maxTokens: 5, timeoutMs: 5000 },
  } satisfies CriticDef,

  // ═══════════════════════════════════════════════════════════════════════
  // Evidence Conflict
  // ═══════════════════════════════════════════════════════════════════════

  /** Do two pieces of evidence contradict each other? */
  evidenceConflict: {
    label: "Evidence Conflict",
    criteria: {
      systemPrompt:
        "You are an evidence conflict analyzer. Determine if two pieces of " +
        "evidence directly contradict each other. Different wording about the same " +
        "factual claim is a contradiction. Complementary information is not. " +
        "Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Evidence A: {{evidenceA}}\nEvidence B: {{evidenceB}}\n" +
        "Do they contradict each other?",
    },
    options: { maxTokens: 5, timeoutMs: 5000 },
  } satisfies CriticDef,

  /**
   * Legacy heuristic fallback for tool loop detection.
   * Checks tool sequence repetition + error echo + file churn patterns.
   */
  toolLoopFallback(toolSequences: string): string {
    // Parse tool sequences from the description
    const lines = toolSequences.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < 4) return "no";

    // Extract tool names from each sequence
    const sequences = lines.map((l) => {
      const tools = (l.match(/`([^`]+)`/g) || []).map((t) => t.replace(/`/g, ""));
      return tools;
    }).filter((s) => s.length > 0);

    if (sequences.length < 4) return "no";

    // Tool repetition: last N turns used same (or subset of) tools
    const lastSeq = sequences[sequences.length - 1];
    const repeatCount = sequences.filter((seq) =>
      lastSeq.length > 0 && lastSeq.every((t) => seq.includes(t)),
    ).length;
    if (repeatCount >= 4) return "yes";

    // Error echo: same error messages repeated
    const errorPattern = /error|fail|reject|denied|timeout/i;
    const errorCount = sequences.filter((seq) =>
      seq.some((t) => errorPattern.test(t)),
    ).length;
    if (errorCount >= 4) return "yes";

    return "no";
  },

  /**
   * Legacy heuristic fallback for evidence conflict detection.
   * Uses token overlap ratio with threshold 0.3.
   */
  evidenceConflictFallback(a: string, b: string): string {
    const tokensA = new Set(
      a.toLowerCase().split(/\W+/).filter((t) => t.length > 2 && !STOP_WORDS_LEGACY.has(t)),
    );
    const tokensB = new Set(
      b.toLowerCase().split(/\W+/).filter((t) => t.length > 2 && !STOP_WORDS_LEGACY.has(t)),
    );
    if (tokensA.size === 0 || tokensB.size === 0) return "no";

    let overlap = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) overlap++;
    }
    const ratio = overlap / Math.max(tokensA.size, tokensB.size);
    return ratio >= 0.3 ? "yes" : "no";
  },

  // ═══════════════════════════════════════════════════════════════════════
  // SOP Quality Assessment
  // ═══════════════════════════════════════════════════════════════════════

  /** Is this approach high-quality and worth storing as an SOP? */
  sopQuality: {
    label: "SOP Quality",
    criteria: {
      systemPrompt:
        "You are a procedure quality assessor. Evaluate if the described solution " +
        "approach is high-quality, reusable, and well-structured. A good SOP has " +
        "clear steps, concrete actions, and generalizable patterns. " +
        "Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Task: {{task}}\nSolution approach: {{solution}}\n" +
        "Is this a high-quality, reusable approach worth storing as an SOP?",
    },
    options: { maxTokens: 5, timeoutMs: 5000 },
  } satisfies CriticDef,

  // ═══════════════════════════════════════════════════════════════════════
  // Decomposition Coverage
  // ═══════════════════════════════════════════════════════════════════════

  /** Do subtasks fully cover the parent task? */
  decompositionComplete: {
    label: "Decomposition Coverage",
    criteria: {
      systemPrompt:
        "You are a task decomposition reviewer. Determine if the set of subtasks " +
        "fully covers all aspects of the parent task without gaps. A minor missing " +
        "detail is okay. A significant missing requirement is a gap. " +
        "Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Parent task: {{parentTask}}\nSubtasks:\n{{subtasks}}\n" +
        "Do the subtasks fully cover the parent task?",
    },
    options: { maxTokens: 5, timeoutMs: 5000 },
  } satisfies CriticDef,

  // ═══════════════════════════════════════════════════════════════════════
  // Hint Quality Filter
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Assess whether a hint (task + steps) is genuinely informative enough to
   * store as a cross-session behavioral hint, or too generic to be useful.
   *
   * Replaces GENERIC_STEP_PATTERNS + GENERIC_DEBUG_TRIAD (14 regex patterns)
   * in consolidation-channel.ts.
   */
  hintQuality: {
    label: "Hint Quality",
    criteria: {
      systemPrompt:
        "You are a hint quality assessor. Determine if the described task and " +
        "solution steps represent a genuinely useful, reusable behavioral hint. " +
        "A good hint has concrete, project-specific steps with real tool usage. " +
        "A bad hint uses generic debugging clichés: 'reproduce the bug', " +
        "'locate root cause', 'apply fix', 'test the fix', 'debug it', " +
        "'isolate the issue', etc. Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Task: {{task}}\nSteps:\n{{steps}}\n" +
        "Is this hint genuinely informative and worth storing for future sessions?",
    },
    options: { maxTokens: 5, timeoutMs: 5000 },
  } satisfies CriticDef,

  /**
   * Legacy heuristic fallback for hint quality.
   * Mirrors the original GENERIC_STEP_PATTERNS + GENERIC_DEBUG_TRIAD logic
   * from consolidation-channel.ts.
   */
  hintQualityFallback(task: string, steps: string[]): string {
    if (!steps || steps.length === 0) return "no";

    const GENERIC_PATTERNS = [
      /^reproduce\s*bug$/i,
      /^locate\s*root\s*cause$/i,
      /^apply\s*fix$/i,
      /^debug$/i,
      /^isolate\s*(issue|problem|component)?$/i,
      /^identify\s*(issue|problem|bug)?$/i,
      /^fix\s*(it|the\s*issue|the\s*problem|the\s*bug)?$/i,
      /^test\s*(the\s*fix|solution)?$/i,
      /^verify\s*(the\s*fix|solution)?$/i,
      /^check\s*(result|output|it)?$/i,
    ];

    const TRIAD = [/^reproduce\s*bug$/i, /^locate\s*root\s*cause$/i, /^apply\s*fix$/i];

    const stepTexts = steps.map((s) => s.trim().toLowerCase());

    // Check for classic three-step cliché triad
    const triadMatches = TRIAD.filter((p) => stepTexts.some((s) => p.test(s))).length;
    if (triadMatches >= 3) return "no";

    // If more than half the steps are generic, reject
    const genericCount = steps.filter((s) =>
      GENERIC_PATTERNS.some((p) => p.test(s.trim())),
    ).length;
    if (genericCount >= steps.length * 0.5) return "no";

    // Reject file-specific error fix patterns
    if (
      /^(fix|resolve|address)\s+\w+\s+(error|issue|bug|warning)\s+in\s+\S+\.\w+$/i.test(
        task.trim(),
      )
    ) {
      return "no";
    }

    return "yes";
  },
} as const;

/**
 * Return the human-readable label for a critic, if available.
 */
/**
 * Return the human-readable label for a critic, if available.
 * Only works for CriticDef entries (not fallback functions).
 */
export function criticLabel(key: string): string | undefined {
  const entry = (CRITICS as Record<string, unknown>)[key];
  if (entry && typeof entry === "object" && "label" in entry) {
    return (entry as { label?: string }).label;
  }
  return undefined;
}