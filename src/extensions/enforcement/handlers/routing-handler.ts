import { createLogger } from "../../../lib/core/logger.js";
import { classify } from "../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const log = createLogger("enforcement");
/**
 * Routing Handler - Route to correct tools based on task intent
 *
 * Research: Routing-based enforcement directs agents to appropriate tools.
 * Uses task classification + tool recommendation.
 *
 * Design: Non-blocking routing nudge that suggests alternative/specialized tools.
 *
 * Intent detection uses CRITICS.topicClassification (LLM judge) instead of
 * a hand-tuned keyword map. The keyword map was fragile: e.g. "explore" was
 * in the exploration list but also implicitly triggered 'debugging' via
 * "look[ing for]" intent. The LLM handles semantic intent correctly.
 */

export type TaskIntent =
  | "exploration" // Reading, searching, understanding
  | "implementation" // Writing, editing code
  | "verification" // Testing, validating
  | "refactoring" // Improving existing code
  | "debugging" // Finding and fixing bugs
  | "planning" // Thinking, planning, strategizing
  | "documentation" // Writing docs, comments
  | "unknown"; // Unclassified

interface ToolMapping {
  intent: TaskIntent;
  primaryTools: string[];
  specializedTools: string[];
  warning?: string;
}

const INTENT_TOOLS: ToolMapping[] = [
  {
    intent: "exploration",
    primaryTools: ["read", "grep", "find", "ls", "bash"],
    specializedTools: ["codebase_tree", "analyze_image"],
  },
  {
    intent: "implementation",
    primaryTools: ["write", "edit", "bash"],
    specializedTools: [],
  },
  {
    intent: "verification",
    primaryTools: ["bash"],
    specializedTools: ["repl"],
    warning: "Verify with tests, not just code review",
  },
  {
    intent: "debugging",
    primaryTools: ["grep", "read", "bash", "think"],
    specializedTools: ["repl"],
    warning: "Hypothesize before debugging - understand root cause first",
  },
  {
    intent: "refactoring",
    primaryTools: ["read", "edit", "bash"],
    specializedTools: [],
    warning: "Ensure tests pass before and after",
  },
  {
    intent: "planning",
    primaryTools: ["think", "hypothesize"],
    specializedTools: ["plan"],
    warning: "Use think() or hypothesize() to explore paths before implementing",
  },
  {
    intent: "documentation",
    primaryTools: ["write", "edit"],
    specializedTools: ["read_document"],
  },
];

// ── Topic → TaskIntent mapping ───────────────────────────────────────────────

/** Map CRITICS.topicClassification labels to routing TaskIntents. */
const TOPIC_TO_INTENT: Record<string, TaskIntent> = {
  implementation: "implementation",
  debugging: "debugging",
  refactoring: "refactoring",
  testing: "verification",
  exploration: "exploration",
  documentation: "documentation",
  planning: "planning",
  verification: "verification",
  general: "unknown",
};

/**
 * Detect the current task intent from recent tools + message via the
 * LLM topic critic. Replaces the previous hand-tuned keyword map
 * (~50 keywords across 7 intents) which produced too many false
 * attributions (e.g. "look[ing for]" was in exploration but
 * also triggered debugging via "fix" detection elsewhere).
 *
 * Falls back to "unknown" on degradation (LLM unavailable, timeout,
 * or unknown label).
 */
export async function detectIntent(
  recentTools: string[],
  message: string,
  ctx: ExtensionContext,
): Promise<{ intent: TaskIntent; confidence: number; reasoning: string }> {
  const combined = `Recent tools: ${recentTools.length > 0 ? recentTools.join(", ") : "(none)"}\n\nMessage:\n${message.slice(0, 1500)}`;
  try {
    const result = await classify(
      ctx,
      CRITICS.topicClassification.criteria,
      { text: combined },
      { timeoutMs: 3000, fallback: () => "general" },
    );
    const label = result.label.trim().toLowerCase();
    const intent = TOPIC_TO_INTENT[label] ?? "unknown";
    return {
      intent,
      confidence: result.confidence,
      reasoning: `LLM topic classification: ${label}`,
    };
  } catch (err) {
    log.debug(`detectIntent failed: ${err}`);
    return { intent: "unknown", confidence: 0, reasoning: "LLM unavailable" };
  }
}

/**
 * Check if current tool is appropriate for detected intent
 */
export function checkRoutingMismatch(
  currentTool: string,
  detectedIntent: TaskIntent,
): { mismatch: boolean; suggestion: string } {
  const mapping = INTENT_TOOLS.find((m) => m.intent === detectedIntent);
  if (!mapping) {
    return { mismatch: false, suggestion: "" };
  }

  // Check if tool is in primary or specialized
  const isPrimary = mapping.primaryTools.includes(currentTool);
  const isSpecialized = mapping.specializedTools.includes(currentTool);

  if (isPrimary || isSpecialized) {
    return { mismatch: false, suggestion: "" };
  }

  // Tool doesn't match intent
  const suggestions: string[] = [];
  if (mapping.primaryTools.length > 0) {
    suggestions.push(`For ${detectedIntent}, consider: ${mapping.primaryTools.join(", ")}`);
  }
  if (mapping.warning) {
    suggestions.push(mapping.warning);
  }

  return {
    mismatch: true,
    suggestion: suggestions.join(". "),
  };
}

/**
 * Get routing hint for current context
 */
export function getRoutingHint(detectedIntent: TaskIntent, turnHistory: string[]): string | null {
  const mapping = INTENT_TOOLS.find((m) => m.intent === detectedIntent);
  if (!mapping) return null;

  // Only suggest if no recent specialized tools used
  const recentSpecialized = turnHistory
    .slice(-5)
    .filter((t) => mapping.specializedTools.includes(t));

  if (recentSpecialized.length > 0) {
    return null; // Already using specialized tools
  }

  // Only suggest if context is simple enough to benefit
  if (detectedIntent === "planning" && !turnHistory.includes("think")) {
    return "Planning detected - use think() or hypothesize() before implementing";
  }

  if (detectedIntent === "verification" && !turnHistory.includes("bash")) {
    return "Verification needed - run tests to confirm, not just review";
  }

  return null;
}
