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
 * Pattern from: input-polisher/input-critic.ts
 *   Three parallel classify() calls, each with criteria + heuristic fallback.
 *   The result is a consensus verdict across critics.
 *
 * Usage:
 *   import { classify } from "../ai/text-classifier.js";
 *   import { CRITICS } from "./critic-registry.js";
 *
 *   const result = await classify(ctx, CRITICS.topicCoverage.criteria,
 *     { original: req, response: resp },
 *     { timeoutMs: 5000, fallback: CRITICS.topicCoverage.fallback },
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

// Helpers (ENTITY_VERBS, STOP_WORDS) and the criticLabel() lookup
// were extracted to critic-helpers.ts to keep this file focused on
// the CRITICS object. Re-exported below for backward compat.
// (STOP_WORDS_LEGACY kept as a deprecated alias for the same reason.)
import { ENTITY_VERBS } from "./critic-helpers.js";
export { ENTITY_VERBS, STOP_WORDS, STOP_WORDS_LEGACY, criticLabel } from "./critic-helpers.js";

// ── CRITICS - All critic prompt definitions ─────────────────────────────────

export const CRITICS = {
  // ═══════════════════════════════════════════════════════════════════════
  // Topic Drift - Triple critic: coverage + divergence + completeness
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

  /**
   * Does a subtask list fully cover the parent task?
   * Used by verify_claim action=decomposition. Binary yes/no.
   */
  decompositionCoverage: {
    label: "Decomposition Coverage",
    criteria: {
      systemPrompt:
        "You are a task decomposition reviewer. Given a parent task and a list " +
        "of proposed subtasks, determine if the subtasks together fully cover " +
        "the parent task. A subtask list 'covers' the parent when every feature, " +
        "component, and concern of the parent is represented in at least one " +
        "subtask. Missing minor naming or wording is acceptable. " +
        "Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Parent task: {{parentTask}}\n\n" +
        "Proposed subtasks:\n- {{subtasks}}\n\n" +
        "Do the subtasks together fully cover the parent task?",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  /**
   * Classify the current work topic from assistant text.
   * Used by context-lifecycle/signal-detector to detect topic shifts.
   * Replaces the hardcoded TOPIC_KEYWORDS keyword map (8 topics × 5-8
   * keywords each) which produced too many false negatives.
   * Answer with ONE topic label: implementation, debugging, refactoring,
   * testing, exploration, documentation, planning, verification, or general.
   */
  topicClassification: {
    label: "Topic Classification",
    criteria: {
      systemPrompt:
        "You are a work-topic classifier. Given a chunk of assistant activity " +
        "(text from a recent turn or sequence of tool calls), determine the " +
        "primary topic of the work. Answer with exactly ONE label, lowercase, " +
        "no explanation:\n" +
        "- implementation: writing new code or adding features\n" +
        "- debugging: fixing bugs, diagnosing errors, tracing failures\n" +
        "- refactoring: restructuring code without changing behavior\n" +
        "- testing: writing tests, running tests, asserting correctness\n" +
        "- exploration: reading, searching, browsing, investigating unknown code\n" +
        "- documentation: writing docs, comments, READMEs, explanations\n" +
        "- planning: designing approaches, listing steps, choosing strategies\n" +
        "- verification: confirming a prior result, sanity-checking, finalizing\n" +
        "- general: none of the above fits",
      userPrompt: "Recent assistant activity:\n{{text}}",
    },
    options: { timeoutMs: 3000 },
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
   */
  trajectoryPattern: {
    label: "Trajectory Pattern",
    criteria: {
      systemPrompt:
        "You are a workflow-pattern classifier. Given a comma-separated sequence " +
        "of tool names from a completed agent task, name the dominant workflow " +
        "pattern. Prefer one of these known patterns (exact spelling, hyphenated):\n" +
        "- Read-Fix-Verify: read file, edit, run command to verify\n" +
        "- Read-Fix-Test: read file, edit, run tests (multiple bash)\n" +
        "- Read-Create-Verify: read existing, write new file, verify\n" +
        "- Error-Diagnose-Fix: error from command, read output, edit\n" +
        "- Read-Test-Fix-Verify: read, test, edit, test again\n" +
        "- Research-Read-Fix-Verify: web search, read, edit, verify\n" +
        "- Repeated-Test: multiple verify/test commands in a row\n" +
        "- Multi-Source-Investigation: read multiple files to understand\n" +
        "- Iterative-Fix-Verify: edit-edit-test loop\n" +
        "If none of the above fit, invent a concise hyphenated name like " +
        "'Read-Edit-Edit' or 'Investigate-Write'. The name should be 1-4 " +
        "words, each word 1-12 chars. Return only the pattern name, no explanation.",
      userPrompt: "Tool sequence: {{tools}}",
    },
    options: { timeoutMs: 3000 },
  } satisfies CriticDef,

  /** Legacy heuristic fallback for topic drift (stop-word anchor matching). */

  // ═══════════════════════════════════════════════════════════════════════
  // Claim Contradiction - Triple critic: contradiction + support + overconfidence
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
    options: { timeoutMs: 5000 },
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
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  /** Does the claim contain unwarranted certainty (overconfidence)? */
  claimOverconfidence: {
    label: "Overconfidence",
    criteria: {
      systemPrompt:
        "You are a confidence assessor. Determine if the claim contains unwarranted " +
        "certainty - absolutes like 'always', 'never', 'guaranteed', 'definitely', " +
        "'impossible', 'must', or superlatives that aren't supported by the context. " +
        "Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Claim: {{claim}}\nAvailable context: {{context}}\n" +
        "Does the claim contain unwarranted certainty?",
    },
    options: { timeoutMs: 5000 },
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
        "You are a behavioral loop detector. Determine if the agent is repeating " +
        "the same tool calls across consecutive turns without making progress. " +
        "Reading different files is fine. Calling the same tool on the same file " +
        "repeatedly without progress is a loop. Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Recent tool usage (most recent first):\n{{toolSequences}}\n" +
        "Is the agent in a repetitive loop?",
    },
    options: { timeoutMs: 5000 },
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
    options: { timeoutMs: 5000 },
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
    options: { timeoutMs: 5000 },
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
    options: { timeoutMs: 5000 },
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
    options: { timeoutMs: 5000 },
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
        "You are a context density evaluator. Given a sample of conversation " +
        "messages, determine if the context has HIGH, MEDIUM, or LOW signal density. " +
        "HIGH = most messages contain meaningful, non-boilerplate content. " +
        "MEDIUM = mixed - some signal, some noise (duplicates, errors, boilerplate). " +
        "LOW = mostly noise - repetitive commands, traceback dumps, trivial responses. " +
        "Answer with exactly one word: HIGH, MEDIUM, or LOW. Do not explain.",
      userPrompt:
        "Context sample ({{sampleCount}} messages):\n{{messages}}\n" +
        "Rate the signal density of this context.",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  /**
   * Determine how urgently context compression is needed.
   * Replaces the static threshold tree in detection/compression-strategy.ts.
   */
  compressionUrgency: {
    label: "Compression Urgency",
    criteria: {
      systemPrompt:
        "You are a context compression advisor. Given the current session state, " +
        "determine the appropriate compression level. Consider: turn count, " +
        "reasoning depth, failure rate, and time since last compression. " +
        "Answer with exactly one word: NONE, CONSERVATIVE, SEMANTIC, or AGGRESSIVE. " +
        "NONE = context is fresh and efficient. " +
        "CONSERVATIVE = prune only obvious noise. " +
        "SEMANTIC = summarize reasoning chains. " +
        "AGGRESSIVE = extract patterns to memory, remove most raw context. " +
        "Do not explain.",
      userPrompt:
        "Turns since last compression: {{turnsSinceCompression}}\n" +
        "Total turns: {{totalTurns}}\n" +
        "Consecutive failures: {{consecutiveFailures}}\n" +
        "Reasoning chain depth: {{reasoningDepth}}\n" +
        "Message count: {{messageCount}}\n" +
        "What compression level is needed?",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  /**
   * Legacy heuristic fallback for compression urgency.
   * Returns the existing static-threshold logic from compression-strategy.ts.
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
        "You are a quality degradation assessor. Given samples of recent agent " +
        "output, determine if output quality has degraded. Look for: confused " +
        "or contradictory statements, shallow analysis, repeated mistakes, " +
        "loss of task focus, or decline in reasoning depth. " +
        "Answer with exactly one word: DEGRADED or STABLE. Do not explain.",
      userPrompt:
        "Recent agent outputs:\n{{outputSamples}}\n" +
        "Has agent output quality degraded?",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  /**
   * Legacy heuristic fallback for qualitative degradation.
   * Conservative: assume no degradation when LLM unavailable.
   */

  // ═══════════════════════════════════════════════════════════════════════
  // Removal Safety - filter-safe-to-remove batch assessment
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Assess whether a given message is safe to remove before context compaction.
   * Replaces the rule-based heuristics in filter-safe-to-remove.ts
   * (error markers, path matching, duplicate detection).
   */
  removalSafety: {
    label: "Removal Safety",
    criteria: {
      systemPrompt:
        "You are a context compaction assistant. Given a single conversation " +
        "message, determine if it is SAFE to remove before LLM summarization. " +
        "A message is safe to remove if it is clearly redundant, superseded, " +
        "or non-essential: duplicate file reads, resolved error outputs, " +
        "oversized non-critical tool results (ls/find/grep), ephemeral system " +
        "steer messages, or resolved bug trace dumps. " +
        "A message is NOT safe if it contains unique information, is a user " +
        "request, is an assistant response, or is a write/modify operation. " +
        "Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Message role: {{role}}\n" +
        "Tool name: {{toolName}}\n" +
        "Content snippet: {{content}}\n" +
        "Is this message safe to remove before compaction?",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  // ═══════════════════════════════════════════════════════════════════════
  // Error Type - register-auto-retry-end error classification
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Classify an error message into retry-handling category.
   * Replaces the 3-line regex in register-auto-retry-end.ts.
   */
  errorType: {
    label: "Error Type",
    criteria: {
      systemPrompt:
        "You are a retry-error classifier. Given an error message, classify it " +
        "into exactly one category. Answer only the category name. Do not explain.\n" +
        "Categories:\n" +
        "- rate_limit: 429, rate limiting, quota exceeded, too many requests\n" +
        "- server_error: 5xx, server error, internal error, overloaded, unavailable\n" +
        "- network: connection refused, fetch failed, socket hang up, timeout, dns\n" +
        "- auth: 401, 403, unauthorized, forbidden, invalid key, authentication\n" +
        "- unknown: anything else",
      userPrompt: "{{errorMsg}}",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  /** Legacy fallback for error type classification. */

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
        "You are a requirement classifier. Given a requirement body, determine " +
        "its strength level according to RFC 2119 semantics:\n" +
        "- SHALL/MUST: absolute requirement\n" +
        "- SHOULD: recommended, not mandatory\n" +
        "- MAY: optional\n" +
        "Answer only the strength word. Do not explain.",
      userPrompt: "{{body}}",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  /** Legacy fallback for instruction strength. */

  // ═══════════════════════════════════════════════════════════════════════
  // Command Type - probe-handler command classification
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Classify a shell command into its execution pattern.
   * Replaces probe-handler.ts command regex classification.
   */
  commandType: {
    label: "Command Type",
    criteria: {
      systemPrompt:
        "You are a shell command classifier. Given a command string, classify it " +
        "into exactly one category. Answer only the category name. Do not explain.\n" +
        "Categories:\n" +
        "- pipeline: chaining commands with |, pipe, xargs\n" +
        "- loop: iterative/conditional constructs like for, while, until\n" +
        "- dangerous: destructive operations like rm -rf, dd, mkfs, chmod 777\n" +
        "- edit: modifying files with sed, awk in-place, redirects >, >>\n" +
        "- info: reading files, grep, find, ls, cat, head, tail\n" +
        "- build: compile, install, npm/pip/yarn, make, cargo\n" +
        "- safe: everything else",
      userPrompt: "{{cmd}}",
    },
    options: { timeoutMs: 3000 },
  } satisfies CriticDef,

  /** Legacy fallback for command type classification. */

  // ═══════════════════════════════════════════════════════════════════════
  // Input Polish Critics - input-polisher pre-classification
  // ═══════════════════════════════════════════════════════════════════════

  /** Is this text primarily code (not natural language)? */
  inputCodeHeavy: {
    label: "Input Code-Heavy",
    criteria: {
      // System prompt: pure persona. No instructions, no format, no
      // content. This matches the input-polisher pattern (PERSONA in
      // system, instructions + content in user) and prevents the
      // model from treating instructions as authoritative when they
      // appear in user content.
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      // User prompt: explicit instructions + the content wrapped in
      // XML tags (anti-prompt-leakage guard). The XML wrapper signals
      // to the model that the text is content, not commands.
      userPrompt:
        "Your task: classify whether the text below is primarily code (not natural language).\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n{{text}}\n</text>",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  /** Is this text well-written with correct grammar/spelling/structure? */
  inputWellWritten: {
    label: "Input Well-Written",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: classify whether the text below is well-written English " +
        "(correct grammar, spelling, sentence structure).\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n{{text}}\n</text>",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  /** Is this message clearly written and coherent? */
  inputClarity: {
    label: "Input Clarity",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: classify whether the text below is clearly written and coherent " +
        "(logical flow, communicates its intent effectively).\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n{{text}}\n</text>",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  /** Does this message contain vague or ambiguous requests? */
  inputAmbiguity: {
    label: "Input Ambiguity",
    criteria: {
      systemPrompt:
        "You are a binary text classifier. You do one thing: " +
        "look at text inside <text> tags and decide if it matches a criterion.",
      userPrompt:
        "Your task: classify whether the text below contains vague, underspecified, " +
        "or ambiguous requests (uses words like 'it', 'that thing' without clear referents; " +
        "asks questions that could be interpreted multiple ways).\n" +
        "Reply with exactly one word: yes or no. No explanation, no punctuation, no other text.\n\n" +
        "<text>\n{{text}}\n</text>",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  // inputCodeHeavyFallback doesn't need to import from the input-polisher.


  /** Heuristic fallback: >30% non-whitespace chars are code-like = code-heavy. */

  /** Heuristic fallback: sentence count + capitalization + repeated chars. */

  /** Heuristic fallback: short text + long run-on sentences + contradiction markers. */

  /** Heuristic fallback: vague phrases + single-word messages. */

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
        "You are a relevance classifier. Determine if the given behavioral hint " +
        "is relevant to the user's current task. A hint is relevant ONLY if it " +
        "describes a strategy or workflow that could plausibly apply to the " +
        "current task based on shared topic, tool, or methodology. " +
        "Generic hints like 'Fix type error: Reproduce → Locate → Apply' are NOT " +
        "relevant even if vaguely applicable. " +
        "Answer only 'yes' or 'no'. Do not explain.",
      userPrompt:
        "Current task: {{currentTask}}\n" +
        "Hint: {{hint}}\n" +
        "Is this hint relevant to the current task?",
    },
    options: { timeoutMs: 3000 },
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
        "You are a resolution classifier for an AI agent's knowledge conflict system. " +
        "Determine if the given text contains language that RESOLVES a knowledge conflict " +
        "(deciding which evidence to trust). " +
        "Answer with exactly one word: 'resolved_for', 'resolved_against', or 'none'. " +
        "'resolved_for' = text selects and favors one side of a conflict. " +
        "'resolved_against' = text explicitly rejects or disproves a claim. " +
        "'none' = text does not resolve any conflict. Do not explain.",
      userPrompt: "Does this message resolve a knowledge conflict? {{text}}",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  /**
   * Heuristic fallback for conflict resolution detection.
   * Preserves the original keyword-based logic as graceful degradation.
   */

  // ═══════════════════════════════════════════════════════════════════════
  // Compliance Framing - latent-activator compliance detection
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Detect if a task description uses compliance framing language.
   * Replaces COMPLIANCE_PATTERNS keyword list in latent-activator.
   */
  complianceFraming: {
    label: "Compliance Framing",
    criteria: {
      systemPrompt:
        "You are a compliance framing detector. Determine if the given text " +
        "uses language that frames the task as a compliance requirement - " +
        "words like 'must', 'required', 'mandatory', 'shall', 'strictly', " +
        "'obligatory', 'it is essential', 'is expected to'. " +
        "Answer only 'yes' or 'no'. Do not explain.",
      userPrompt: "{{text}}",
    },
    options: { timeoutMs: 3000 },
  } satisfies CriticDef,
  // complianceFramingFallback was previously defined here but is not
  // called anywhere (replaced by direct LLM-only call sites in
  // latent-activator). Removed as dead code.

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
        "You are a polarity classifier. Given a sentence, determine if it " +
        "makes a positive or negative assertion about a technical claim. " +
        "Answer only 'positive', 'negative', or 'neutral'. Do not explain.",
      userPrompt: "{{sentence}}",
    },
    options: { timeoutMs: 3000 },
  } satisfies CriticDef,

  /** Legacy fallback for polarity detection. */

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
        "You are a claim detector. Determine if the given sentence contains " +
        "a factual claim about a technical entity (function, API, database, " +
        "module, class, method, tool, interface, etc.). " +
        "Answer only 'yes' or 'no'. Do not explain.",
      userPrompt: "{{sentence}}",
    },
    options: { timeoutMs: 3000 },
  } satisfies CriticDef,

  /** Legacy fallback for entity extraction. */

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
        "You are a sycophancy pressure detector. Determine if the given user message " +
        "is trying to pressure the assistant into agreeing, using flattery, loaded questions, " +
        "authority claims, skepticism, or forcing agreement. " +
        "These are messages designed to make the assistant less objective. " +
        "Answer only 'yes' or 'no'. Do not explain.",
      userPrompt: "Does this message use sycophancy pressure tactics?\n\n{{text}}",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  /** Legacy fallback for sycophancy tactics detection. */

  /**
   * Detect validation-before-correction (VbC) in assistant responses:
   * agreeing with the user's premise before correcting it.
   */
  vbCDetection: {
    label: "VbC Detection",
    criteria: {
      systemPrompt:
        "You are a validation-before-correction detector. Determine if the given " +
        "text validates before correcting - i.e., it first agrees with the user's " +
        "premise then contradicts it.\n" +
        "Examples of VbC:\n" +
        '- "You\'re right that X... however Y"\n' +
        '- "That\'s a fair point... but actually"\n' +
        '- "I understand your concern... however the issue is"\n' +
        "Answer only 'yes' or 'no'. Do not explain.",
      userPrompt: "Does this response do validation-before-correction?\n\n{{text}}",
    },
    options: { timeoutMs: 5000 },
  } satisfies CriticDef,

  /** Legacy fallback for VbC detection. */
} as const;
