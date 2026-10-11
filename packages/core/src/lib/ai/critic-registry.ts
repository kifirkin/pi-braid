/**
 * Critic Registry - centralized pool of critic prompt templates.
 *
 * The "triple critic" system:
 *   Each critic is a named classification task with:
 *   1. A system prompt (role description for the classifier model)
 *   2. A user prompt with {{key}} placeholders
 *   3. An optional heuristic fallback (Tier 1 in classify())
 *
 * Critics are evaluated via lib/text-classifier.ts's three-tier fallback:
 *   Tier 1: Heuristic fallback (fast, free, crude - preferred)
 *   Tier 2: Utility model (configured via /utility-model)
 *   Tier 3: Session model (always available)
 *
 * This registry is the single source of truth for all classifier prompts.
 * Callers import CRITICS and pass the value to classify().
 *
 * Critique pattern: several classify() calls, each with criteria + heuristic
 * fallback, combined into a consensus verdict.
 *
 * Usage:
 *   import { classify } from "../ai/text-classifier.js";
 *   import { CRITICS } from "./critic-registry.js";
 *
 *   const result = await classify(ctx, CRITICS.topicCoverage.criteria,
 *     { original: req, response: resp },
 *     { timeoutMs: 60_000, fallback: CRITICS.topicCoverage.fallback },
 *   );
 */

import type { ClassifierCriteria, ClassifierOptions } from "./text-classifier.js";

export interface CriticDef {
  /** Classifier prompt template (system + user). */
  criteria: ClassifierCriteria;
  /** Optional override: maxTokens, timeoutMs, or heuristic fallback. */
  options?: Partial<ClassifierOptions>;
  /** Human-readable label for observability / stats. */
  label?: string;
}

// Helpers (ENTITY_VERBS, STOP_WORDS) and the criticLabel() lookup
// were extracted to critic-helpers.ts to keep this file focused on
// the CRITICS object. Re-exported below for backward compat.
export { ENTITY_VERBS, STOP_WORDS, criticLabel } from "./critic-helpers.js";

export const CRITICS = {
  // ═══════════════════════════════════════════════════════════════════════
  // Topic Drift - Triple critic: coverage + divergence + completeness
  // ═══════════════════════════════════════════════════════════════════════

  /** Does the response still address the original request? (topic coverage) */
  topicCoverage: {
    label: "Topic Coverage",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the agent's response still addresses the original user request. " +
        "Consider: are the same entities, tasks, and goals being discussed?\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "Original request: {{original}}\n" +
        "Agent response: {{response}}\n" +
        "</text>",
    },
  } satisfies CriticDef,

  /** Is the response about different subject matter? (divergence) */
  topicDivergence: {
    label: "Topic Divergence",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the agent's response has shifted to a substantially different topic " +
        "than the original request. A response that discusses implementation details of the same task is NOT drifted.\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "Original request: {{original}}\n" +
        "Agent response: {{response}}\n" +
        "</text>",
    },
  } satisfies CriticDef,

  /** Does the response include all key topics from the request? (completeness) */
  topicCompleteness: {
    label: "Topic Completeness",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the agent's response covers all the key topics mentioned in the original " +
        "user request. Missing one minor detail is acceptable.\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "Original request: {{original}}\n" +
        "Agent response: {{response}}\n" +
        "</text>",
    },
  } satisfies CriticDef,

  /**
   * Classify the current work topic from assistant text.
   * Used by context-lifecycle/signal-detector to detect topic shifts.
   * Replaces the hardcoded TOPIC_KEYWORDS keyword map (8 topics x 5-8
   * keywords each) which produced too many false negatives.
   * Answer with ONE topic label: implementation, debugging, refactoring,
   * testing, exploration, documentation, planning, verification, or general.
   */
  topicClassification: {
    label: "Topic Classification",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine the primary work topic of the assistant activity below. " +
        "Reply with exactly one word from this list (lowercase, no explanation):\n" +
        "implementation, debugging, refactoring, testing, exploration, documentation, planning, verification, general.\n\n" +
        "<text>\n" +
        "Recent assistant activity:\n{{text}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /**
   * Classify a tool-call trajectory into a workflow pattern name.
   * Used by sop-extractor to produce human-readable pattern names like
   * 'Read-Fix-Verify' or 'Error-Diagnose-Fix'. Replaces the hardcoded
   * 9-entry COMMON_PATTERNS list which required exact 3-tool-window
   * matches and missed everything else.
   *
   * The LLM is given the known vocabulary of pattern names plus a
   * fallback instruction to generate a descriptive one if none fit.
   * The text is a short, comma-separated tool sequence.
   *
   * Note: this critic returns a pattern name (often multi-word, hyphenated)
   * rather than a yes/no, so it does not strictly follow the "one word"
   * pattern. The <text> wrap is still applied to keep the content
   * separated from the instruction, preventing the model from
   * interpreting the tool sequence as a new prompt to answer.
   */
  trajectoryPattern: {
    label: "Trajectory Pattern",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: name the dominant workflow pattern of the tool sequence below. " +
        "Prefer one of these known patterns (exact spelling, hyphenated):\n" +
        "Read-Fix-Verify, Read-Fix-Test, Read-Create-Verify, Error-Diagnose-Fix, " +
        "Read-Test-Fix-Verify, Research-Read-Fix-Verify, Repeated-Test, " +
        "Multi-Source-Investigation, Iterative-Fix-Verify.\n" +
        "If none of the above fit, invent a concise hyphenated name like 'Read-Edit-Edit' " +
        "or 'Investigate-Write' (1-4 words, each word 1-12 chars).\n" +
        "Reply with only the pattern name. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "Tool sequence: {{tools}}\n" +
        "</text>",
    },
    options: {
      timeoutMs: 60_000,
      // Multi-class critic: model returns a hyphenated pattern name, not
      // yes/no. The validLabels whitelist is passed through to
      // normalizeLabel so labels like "Read-Edit-Bash" (invented on the
      // fly) are accepted as valid. We only whitelist the canonical
      // 9 names; invented names are also accepted because normalizeLabel
      // falls through to yes/no for non-whitelisted short strings... but
      // actually no - if a model invents "Read-Edit-Bash" and it's not in
      // this list, normalizeLabel returns null. We accept this trade-off:
      // invented names are rare and the heuristic fallback in sop-extractor
      // (detectPattern) handles the unparseable case with a deterministic
      // local match. The 9 canonical names cover ~80% of real sessions.
      validLabels: [
        "Read-Fix-Verify",
        "Read-Fix-Test",
        "Read-Create-Verify",
        "Error-Diagnose-Fix",
        "Read-Test-Fix-Verify",
        "Research-Read-Fix-Verify",
        "Repeated-Test",
        "Multi-Source-Investigation",
        "Iterative-Fix-Verify",
      ],
    },
  } satisfies CriticDef,

  /** Heuristic fallback for topic drift (stop-word anchor matching). */

  // ═══════════════════════════════════════════════════════════════════════
  // Claim Contradiction - Triple critic: contradiction + support + overconfidence
  // ═══════════════════════════════════════════════════════════════════════

  /** Does a claim directly contradict a given context? */
  claimContradiction: {
    label: "Claim Contradiction",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the claim directly contradicts the context. " +
        "Consider positive/negative polarity: if the claim says something is true but " +
        "the context says it is false (or vice versa), that is a contradiction.\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "Claim: {{claim}}\n" +
        "Context: {{context}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /** Is the claim sufficiently supported by the context? */
  claimSupported: {
    label: "Claim Support",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the claim is supported by the provided context. " +
        "The context must contain factual information that directly backs up the claim.\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "Claim: {{claim}}\n" +
        "Context: {{context}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /** Does the claim contain unwarranted certainty (overconfidence)? */
  claimOverconfidence: {
    label: "Overconfidence",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the claim contains unwarranted certainty - " +
        "absolutes like 'always', 'never', 'guaranteed', 'definitely', 'impossible', " +
        "'must', or superlatives that aren't supported by the context.\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "Claim: {{claim}}\n" +
        "Available context: {{context}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /**
   * Minimal conservative fallback for contradiction detection.
   * Detects obvious polarity flips via negation patterns on shared terms.
   * Returns "no" when uncertain - LLM tier (Tier 2/3) handles complex cases.
   */

  // ═══════════════════════════════════════════════════════════════════════
  // Turn Loop Detection
  // ═══════════════════════════════════════════════════════════════════════

  /** Is the agent stuck in a repetitive tool loop? */
  toolLoopDetected: {
    label: "Tool Loop Detection",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the agent is repeating the same tool calls across consecutive " +
        "turns without making progress. Reading different files is fine. Calling the same tool " +
        "on the same file repeatedly without progress is a loop.\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "Recent tool usage (most recent first):\n{{toolSequences}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  // ═══════════════════════════════════════════════════════════════════════
  // Evidence Conflict
  // ═══════════════════════════════════════════════════════════════════════

  /** Do two pieces of evidence contradict each other? */
  evidenceConflict: {
    label: "Evidence Conflict",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the two pieces of evidence directly contradict each other. " +
        "Different wording about the same factual claim is a contradiction. Complementary " +
        "information is not.\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "Evidence A: {{evidenceA}}\n" +
        "Evidence B: {{evidenceB}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /**
   * Conservative fallback for tool loop detection.
   * Returns "no" - LLM tier handles actual detection.
   */

  /**
   * Conservative fallback for evidence conflict detection.
   * Returns "no" - LLM tier handles actual detection.
   */

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
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the described task and solution steps represent a genuinely " +
        "useful, reusable behavioral hint. A good hint has concrete, project-specific steps with " +
        "real tool usage. A bad hint uses generic debugging clichés: 'reproduce the bug', " +
        "'locate root cause', 'apply fix', 'test the fix', 'debug it', 'isolate the issue', etc.\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "Task: {{task}}\n" +
        "Steps:\n{{steps}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /**
   * Conservative fallback for hint quality.
   * Returns "yes" (allow through) - LLM tier handles filtering.
   */

  // ═══════════════════════════════════════════════════════════════════════
  // Context Density - Triple critic: signal ratio + duplication + compression urgency
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Evaluate the signal-to-noise ratio of a context message sample.
   * Replaces the regex-based NOISE_PATTERNS + MIN_SIGNAL_LENGTH heuristics
   * in detection/context-density.ts.
   */
  contextDensity: {
    label: "Context Density",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: rate the signal density of the conversation sample below. " +
        "Reply with exactly one word from this list (uppercase, no explanation):\n" +
        "HIGH, MEDIUM, LOW.\n" +
        "HIGH = most messages contain meaningful, non-boilerplate content.\n" +
        "MEDIUM = mixed - some signal, some noise (duplicates, errors, boilerplate).\n" +
        "LOW = mostly noise - repetitive commands, traceback dumps, trivial responses.\n\n" +
        "<text>\n" +
        "Context sample ({{sampleCount}} messages):\n{{messages}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /**
   * Determine how urgently context compression is needed.
   * Replaces the static threshold tree in detection/compression-strategy.ts.
   */
  compressionUrgency: {
    label: "Compression Urgency",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine the appropriate compression level for the session state below. " +
        "Reply with exactly one word from this list (uppercase, no explanation):\n" +
        "NONE, CONSERVATIVE, SEMANTIC, AGGRESSIVE.\n" +
        "NONE = context is fresh and efficient.\n" +
        "CONSERVATIVE = prune only obvious noise.\n" +
        "SEMANTIC = summarize reasoning chains.\n" +
        "AGGRESSIVE = extract patterns to memory, remove most raw context.\n\n" +
        "<text>\n" +
        "Turns since last compression: {{turnsSinceCompression}}\n" +
        "Total turns: {{totalTurns}}\n" +
        "Consecutive failures: {{consecutiveFailures}}\n" +
        "Reasoning chain depth: {{reasoningDepth}}\n" +
        "Message count: {{messageCount}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /**
   * Heuristic fallback for compression urgency: the static-threshold logic
   * from compression-strategy.ts.
   */

  // ═══════════════════════════════════════════════════════════════════════
  // Qualitative Degradation - Single critic: output quality
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Assess whether agent output quality has degraded qualitatively.
   * Complements the metric-based degradation detector - catches cases
   * where numeric metrics look fine but output is wrong.
   */
  qualitativeDegradation: {
    label: "Qualitative Degradation",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if output quality has degraded. Look for: confused or " +
        "contradictory statements, shallow analysis, repeated mistakes, loss of task focus, " +
        "or decline in reasoning depth.\n" +
        "Reply with exactly one word: DEGRADED or STABLE. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "Recent agent outputs:\n{{outputSamples}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /**
   * Heuristic fallback for qualitative degradation.
   * Conservative: assume no degradation when LLM unavailable.
   */

  // ═══════════════════════════════════════════════════════════════════════
  // Error Type - register-agent-end-api-error classification
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Classify an error message into retry-handling category.
   * Replaces the 3-line regex in register-agent-end-api-error.ts.
   */
  errorType: {
    label: "Error Type",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: classify the error message below into exactly one category. " +
        "Reply with exactly one word: the category name. No explanation, no punctuation, no other text.\n" +
        "Categories:\n" +
        "rate_limit (429, rate limiting, quota exceeded, too many requests), " +
        "server_error (5xx, server error, internal error, overloaded, unavailable), " +
        "network (connection refused, fetch failed, socket hang up, timeout, dns), " +
        "auth (401, 403, unauthorized, forbidden, invalid key, authentication), " +
        "unknown (anything else).\n\n" +
        "<text>\n" +
        "{{errorMsg}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /** Heuristic fallback for error type classification. */

  // ═══════════════════════════════════════════════════════════════════════
  // Instruction Strength - bidirectional-verifier RFC 2119 keyword
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Classify requirement strength from specification text.
   * Replaces SHALL/MUST/SHOULD keyword matching.
   */
  instructionStrength: {
    label: "Instruction Strength",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine the strength level of the requirement below according to RFC 2119 semantics. " +
        "Reply with exactly one word: SHALL, MUST, SHOULD, or MAY. No explanation, no punctuation, no other text.\n" +
        "SHALL/MUST = absolute requirement. SHOULD = recommended, not mandatory. MAY = optional.\n\n" +
        "<text>\n" +
        "{{body}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /** Heuristic fallback for instruction strength. */

  // ═══════════════════════════════════════════════════════════════════════
  // Hint Relevance - prompt-builder hint filtering
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Determine if a behavioral hint is relevant to the current task.
   * Replaces inline HINT_RELEVANCE_CRITERIA in prompt-builder.
   */
  hintRelevance: {
    label: "Hint Relevance",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the behavioral hint below is relevant to the user's current " +
        "task. A hint is relevant ONLY if it describes a strategy or workflow that could " +
        "plausibly apply to the current task based on shared topic, tool, or methodology. " +
        "Generic hints like 'Fix type error: Reproduce \u2192 Locate \u2192 Apply' are NOT relevant " +
        "even if vaguely applicable.\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "Current task: {{currentTask}}\n" +
        "Hint: {{hint}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /** Heuristic fallback: reject very short hints and obvious generic templates. */

  // ═══════════════════════════════════════════════════════════════════════
  // Conflict Resolution - conflict-qa response classification
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Classify whether an agent's response resolves a knowledge conflict.
   * Replaces inline RESOLUTION_CRITERIA in lib/store/conflict-qa.ts.
   * Returns one of: 'resolved_for', 'resolved_against', 'none'.
   */
  conflictResolution: {
    label: "Conflict Resolution",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the text below contains language that RESOLVES a knowledge " +
        "conflict (deciding which evidence to trust). " +
        "Reply with exactly one word: resolved_for, resolved_against, or none. No explanation, no punctuation, no other text.\n" +
        "resolved_for = text selects and favors one side of a conflict. " +
        "resolved_against = text explicitly rejects or disproves a claim. " +
        "none = text does not resolve any conflict.\n\n" +
        "<text>\n" +
        "{{text}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /**
   * Heuristic fallback for conflict resolution detection.
   * Preserves the original keyword-based logic as graceful degradation.
   */

  // ═══════════════════════════════════════════════════════════════════════
  // Polarity Detection - claim-tracker sentence polarity
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Determine if a sentence asserts a claim positively or negatively.
   * Replaces 5-word negation regex in claim-tracker fallback.
   */
  polarityDetection: {
    label: "Polarity Detection",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the sentence below makes a positive, negative, or " +
        "neutral assertion about a technical claim.\n" +
        "Reply with exactly one word: positive, negative, or neutral. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "{{sentence}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /** Heuristic fallback for polarity detection. */

  // ═══════════════════════════════════════════════════════════════════════
  // Entity Detection - claim-tracker sentence contains factual claim
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Detect whether a sentence contains a factual claim about a technical entity.
   * Replaces VERBS-based matching in claim-tracker fallback.
   */
  entityExtraction: {
    label: "Entity Extraction",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the sentence below contains a factual claim about a " +
        "technical entity (function, API, database, module, class, method, tool, interface, etc.).\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "{{sentence}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /** Heuristic fallback for entity extraction. */

  // ═══════════════════════════════════════════════════════════════════════
  // Sycophancy Detection
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Detect if a user message uses sycophancy pressure tactics:
   * flattery, loaded questions, authority claims, forced agreement.
   */
  sycophancyTactics: {
    label: "Sycophancy Tactics",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the user message below is trying to pressure the assistant " +
        "into agreeing, using flattery, loaded questions, authority claims, skepticism, or " +
        "forcing agreement. These are messages designed to make the assistant less objective.\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "{{text}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /** Heuristic fallback for sycophancy tactics detection. */

  /**
   * Detect validation-before-correction (VbC) in assistant responses:
   * agreeing with the user's premise before correcting it.
   */
  vbCDetection: {
    label: "VbC Detection",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: determine if the response below validates before correcting - " +
        "i.e., it first agrees with the user's premise then contradicts it.\n" +
        "Examples of VbC: 'You're right that X... however Y', " +
        "'That's a fair point... but actually', " +
        "'I understand your concern... however the issue is'.\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n" +
        "{{text}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /** Heuristic fallback for VbC detection. */

  // ═══════════════════════════════════════════════════════════════════════
  // Hypothesis Signals - scoring.ts dimension detection
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Identify which reasoning patterns are present in a debugging hypothesis.
   * Replaces 4 B-class regex dimension checks in scoreHeuristic().
   * Returns comma-separated signal names or "none".
   */
  hypothesisSignals: {
    label: "Hypothesis Signals",
    criteria: {
      systemPrompt:
        "You are a text classifier that identifies reasoning patterns in debugging hypotheses.",
      userPrompt:
        "Analyze the hypothesis text below and identify which of these reasoning patterns are present:\n" +
        "- verification-plan: mentions verifying, checking, testing, confirming, or reproducing\n" +
        "- causal-reasoning: explains root cause, causal mechanism, or why something happened\n" +
        "- proper-solution: proposes a proper fix vs workaround (clean, refactor, maintainable, proper)\n" +
        "- edge-case-aware: considers boundary conditions, corner cases, or failure modes\n\n" +
        "Reply with ONE line: comma-separated list of present patterns, or 'none' if none apply.\n" +
        "Example: 'verification-plan, causal-reasoning'\n\n" +
        "<text>\n" +
        "{{hypothesisText}}\n" +
        "</text>",
    },
    options: { timeoutMs: 60_000 },
  } satisfies CriticDef,

  /**
   * Heuristic fallback for hypothesis signal detection.
   * Runs the 4 regex dimension checks from scoreHeuristic().
   */

  // ═══════════════════════════════════════════════════════════════════════
  // Session Navigation - task complexity classification
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Classify the initial user request to determine if it's complex enough to
   * warrant phase-boundary enforcement. Runs once per session on SESSION_START.
   * Returns "simple", "moderate", or "complex".
   *
   * - simple: 1-2 steps, no research needed, single tool type
   * - moderate: multiple steps, may need investigation before implementation
   * - complex: multi-phase task requiring investigation, implementation,
   *   verification, and documentation across multiple files
   */
  initialRequestComplexity: {
    label: "Initial Request Complexity",
    criteria: {
      systemPrompt:
        "You are a task complexity classifier. You classify user requests into " +
        "three levels: simple, moderate, or complex.",
      userPrompt:
        "Classify this user request by its complexity:\n\n" +
        "{{request}}\n\n" +
        "Rules:\n" +
        "- SIMPLE: 1-2 steps, single file/tool, no research needed. " +
        "Examples: 'fix a typo', 'run the tests', 'explain this function'\n" +
        "- MODERATE: multiple steps, may need investigation before implementation. " +
        "Examples: 'implement a new feature', 'refactor a module', 'fix a bug I found'\n" +
        "- COMPLEX: multi-phase task requiring investigation, implementation, " +
        "verification, and documentation. Multiple files, multiple areas. " +
        "Examples: 'build a new service', 'migrate the database', 'redesign the auth system'\n\n" +
        "Reply with exactly one word: simple, moderate, or complex. No explanation.",
    },
    options: { timeoutMs: 30_000 },
  } satisfies CriticDef,
} as const;
