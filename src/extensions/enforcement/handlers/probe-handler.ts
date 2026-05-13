import { createLogger } from "../../../lib/logger.js";

const log = createLogger("enforcement");
/**
 * Probe Handler - Analyze task complexity before tool use
 *
 * Research: Probe-based enforcement checks complexity before tool execution.
 * This enables adaptive resource allocation (easy = fewer tokens, hard = more).
 *
 * Design: Non-blocking probe that suggests tool complexity assessment.
 * Uses heuristics + optional LLM probe for uncertain cases.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
  bash: "moderate", // Depends on command
  analyze_image: "simple",
  read_document: "simple",
  // Moderate: Can modify state but reversible
  write: "moderate",
  edit: "moderate",
  think: "simple",
  hypothesize: "moderate",
  // Complex: Side effects, data modification
  // bash with write permissions
  // git commands
  // npm/package management
};

const COMPLEXITY_THRESHOLDS = {
  // Files touched / complexity score
  SIMPLE: 0,
  MODERATE: 3,
  COMPLEX: 7,
};

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

  // Adjust based on parameters
  if (params) {
    // File operations - count files
    if (params.path || params.paths) {
      const paths = Array.isArray(params.paths) ? params.paths : params.path ? [params.path] : [];
      complexityScore += paths.length * 0.5;
      if (paths.length > 5) {
        hints.push("Multiple files detected - consider batch approach");
      }
    }

    // Bash commands - check for risky operations
    if (tool === "bash" && params.command) {
      const cmd = String(params.command);
      if (/\|\s*grep|\|\s*awk|\|\s*sed/.test(cmd)) {
        complexityScore += 1;
        hints.push("Pipeline detected - verify each step");
      }
      if (/for|while|\$\(/.test(cmd)) {
        complexityScore += 2;
        hints.push("Shell expansion detected - test script parts");
      }
      if (/sudo|rm\s|>\s*\/|mv\s+.*\s+.*/.test(cmd)) {
        complexityScore += 3;
        hints.push("Potentially destructive - verify carefully");
      }
    }

    // Edit operations - check for patterns
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

  // Determine final complexity level
  let level: ComplexityLevel = "simple";
  if (complexityScore >= COMPLEXITY_THRESHOLDS.COMPLEX) {
    level = "complex";
  } else if (complexityScore >= COMPLEXITY_THRESHOLDS.MODERATE) {
    level = "moderate";
  }

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
  // High context usage + complex tool = potential overflow risk
  if (turnState.contextUsage > 70 && probe.level === "complex") {
    return {
      mismatch: true,
      suggestion:
        "Context at " +
        turnState.contextUsage.toFixed(0) +
        "% - consider simpler approach or /compact first",
    };
  }

  // Too many simple tools for what seems complex = inefficient
  if (turnState.totalToolCalls > 20 && probe.level === "simple") {
    return {
      mismatch: true,
      suggestion:
        "20+ tool calls detected - consider summarizing progress with think() before continuing",
    };
  }

  return { mismatch: false, suggestion: "" };
}
