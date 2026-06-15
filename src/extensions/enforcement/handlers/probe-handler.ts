
import { classify } from "../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";


/**
 * Probe Handler - Analyze task complexity before tool use
 *
 * Research: Probe-based enforcement checks complexity before tool execution.
 * This enables adaptive resource allocation (easy = fewer tokens, hard = more).
 *
 * Design: Non-blocking probe that suggests tool complexity assessment.
 * Uses heuristics + optional LLM probe for uncertain cases.
 */

export type ComplexityLevel = "simple" | "moderate" | "complex";

export interface ComplexityProbe {
  tool: string;
  level: ComplexityLevel;
  confidence: number;
  hints: string[];
}

const TOOL_COMPLEXITY_MAP: Record<string, ComplexityLevel> = {
  // Simple: read-only, no modification risk
  read: "simple",
  ls: "simple",
  find: "simple",
  grep: "simple",
  bash: "moderate",
  analyze_image: "simple",
  read_document: "simple",
  // Moderate: Can modify state but reversible
  write: "moderate",
  edit: "moderate",
  think: "simple",
  hypothesize: "moderate",
};

const COMPLEXITY_THRESHOLDS = {
  SIMPLE: 0,
  MODERATE: 3,
  COMPLEX: 7,
};

/** Fast heuristic - classify command type without LLM. */
function classifyCommandTypeHeuristic(cmd: string): string {
  if (/\|\s*grep|\|\s*awk|\|\s*sed/.test(cmd) && !/npm|yarn|pnpm|xargs/.test(cmd)) return "pipeline";
  if (/for|while|\$\(/.test(cmd)) return "loop";
  if (/sudo|rm\s|>\s*\/|mv\s+.*\s+.*/.test(cmd)) return "dangerous";
  return "info";
}

/**
 * Estimate task complexity from tool and parameters
 */
export function estimateComplexity(
  tool: string,
  params: Record<string, unknown> | undefined,
): ComplexityProbe {
  const baseComplexity = TOOL_COMPLEXITY_MAP[tool] || "moderate";
  const hints: string[] = [];
  let complexityScore =
    COMPLEXITY_THRESHOLDS[baseComplexity.toUpperCase() as keyof typeof COMPLEXITY_THRESHOLDS] || 1;

  if (params) {
    if (params.path || params.paths) {
      const paths = Array.isArray(params.paths) ? params.paths : params.path ? [params.path] : [];
      complexityScore += paths.length * 0.5;
      if (paths.length > 5) hints.push("Multiple files detected - consider batch approach");
    }

    if (tool === "bash" && params.command) {
      const cmd = String(params.command);
      const cmdType = classifyCommandTypeHeuristic(cmd);
      if (cmdType === "pipeline") {
        complexityScore += 1;
        hints.push("Pipeline detected - verify each step");
      }
      if (cmdType === "loop") {
        complexityScore += 2;
        hints.push("Shell expansion detected - test script parts");
      }
      if (cmdType === "dangerous") {
        complexityScore += 3;
        hints.push("Potentially destructive - verify carefully");
      }
    }

    if (tool === "edit" && params.oldText) {
      const size = String(params.oldText).length;
      if (size > 500) {
        complexityScore += 2;
        hints.push("Large edit - consider breaking into smaller changes");
      }
      if (/function|class|interface|const\s+\w+\s*=/.test(String(params.oldText))) {
        hints.push("Code modification - verify tests pass");
      }
    }
  }

  let level: ComplexityLevel = "simple";
  if (complexityScore >= COMPLEXITY_THRESHOLDS.COMPLEX) level = "complex";
  else if (complexityScore >= COMPLEXITY_THRESHOLDS.MODERATE) level = "moderate";

  const confidence = Math.min(0.95, 0.5 + complexityScore * 0.05);
  return { tool, level, confidence, hints };
}

/**
 * Check if tool complexity is appropriate for the task context
 */
export function checkComplexityMismatch(
  probe: ComplexityProbe,
  turnState: { totalToolCalls: number; contextUsage: number },
): { mismatch: boolean; suggestion: string } {
  if (turnState.contextUsage > 70 && probe.level === "complex") {
    return {
      mismatch: true,
      suggestion:
        "Context at " +
        turnState.contextUsage.toFixed(0) +
        "% - consider simpler approach or /compact first",
    };
  }
  if (turnState.totalToolCalls > 20 && probe.level === "simple") {
    return {
      mismatch: true,
      suggestion:
        "20+ tool calls detected - consider summarizing progress with think() before continuing",
    };
  }
  return { mismatch: false, suggestion: "" };
}

/**
 * Classify command type using LLM judge with heuristic fallback.
 * Opt-in async - callers without ctx get heuristic only.
 */
export async function classifyCommandType(
  cmd: string,
  ctx?: import("../../../types/extension-context.js").ExtensionContext,
): Promise<string> {
  if (!ctx) return classifyCommandTypeHeuristic(cmd);

  try {
    const result = await classify(
      ctx,
      CRITICS.commandType.criteria,
      { cmd },
      {
        maxTokens: 10,
        timeoutMs: 3000,
        label: CRITICS.commandType.label,
        // Q9: heuristic misses chmod 777, mkfs, dd if=, curl | sh. Always use LLM.
        tierPolicy: "always-llm",
      },
    );
    return result.label;
  } catch {
    return classifyCommandTypeHeuristic(cmd);
  }
}
