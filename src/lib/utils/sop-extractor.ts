/**
 * SOP Extractor - Trajectory → Structured SOP Conversion
 *
 * Analyzes tool call trajectories from successful task completions and
 * extracts three-tier SOPs (Strategic / Functional / Atomic) for
 * storage in procedural memory (three-memory-stores).
 *
 * Paper: Experience Compression Spectrum (2604.15877)
 *   - Strategic SOP: 1000x compression (declarative rules)
 *   - Functional SOP: 50-500x compression (procedural skills)
 *   - Atomic SOP: 5-20x compression (episodic memory)
 *
 * This is a heuristic-based extractor. No LLM calls - fast, deterministic.
 * The LLM-only path (detectPatternWithLLM) is used by the heartbeat
 * scheduler when a context is available; the consolidation channel
 * uses the sync heuristic since it runs in a periodic background tick.
 */

import { createLogger } from "../core/logger.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify } from "../ai/text-classifier.js";
import { CRITICS } from "../ai/critic-registry.js";

const log = createLogger("sop-extractor");

// ── Types ──────────────────────────────────────────────────────────────────

export interface TrajectoryEntry {
  toolName: string;
  /** Arguments stringified for pattern analysis */
  args?: string;
  /** Whether the tool call succeeded */
  success: boolean;
  /** Optional error message on failure */
  error?: string;
}

export interface ExtractionInput {
  /** Task description */
  task: string;
  /** Ordered list of tool calls in this trajectory */
  trajectory: TrajectoryEntry[];
  /** Free-text solution / outcome description */
  solution: string;
  /** Whether the task was completed successfully */
  outcome: "success" | "failure" | "partial";
  /** Optional ExtensionContext. When provided, the trajectory-pattern
   *  detection uses CRITICS.trajectoryPattern (LLM judge) instead of the
   *  sync heuristic window-matcher. */
  ctx?: ExtensionContext;
}

export interface ExtractedSOP {
  strategicSOP: string;
  functionalSOP: string[];
  atomicSOP: string[];
}

// ── Tool Role Classification ────────────────────────────────────────────────

const TOOL_CATEGORIES: Record<string, string> = {
  read: "investigate",
  grep: "investigate",
  find: "investigate",
  ls: "investigate",
  codebase_tree: "investigate",
  web_fetch: "investigate",
  browser_navigate: "investigate",
  read_document: "investigate",

  edit: "modify",
  write: "modify",

  bash: "execute",
  repl: "execute",

  browser_snapshot: "verify",
  browser_eval: "verify",
  analyze_image: "verify",
  file_diff: "verify",

  finalize: "complete",
};

/** Map of tool → what phase of work it typically represents */
const TOOL_PHASES: Record<string, string> = {
  read: "understand",
  grep: "understand",
  codebase_tree: "understand",
  find: "understand",
  ls: "understand",
  web_fetch: "research",
  browser_navigate: "research",

  write: "create",
  edit: "modify",

  bash: "verify",
  repl: "verify",
  browser_snapshot: "verify",
  browser_eval: "verify",

  finalize: "complete",
};

// ── Pattern Detection ──────────────────────────────────────────────────────

/** Common tool sequence patterns as {pattern, description} pairs. */
const COMMON_PATTERNS: Array<{ match: string[]; description: string }> = [
  { match: ["read", "edit", "bash"], description: "Read-Fix-Verify" },
  { match: ["read", "edit", "bash", "bash"], description: "Read-Fix-Test" },
  { match: ["read", "write", "bash"], description: "Read-Create-Verify" },
  { match: ["bash", "read", "edit"], description: "Error-Diagnose-Fix" },
  { match: ["read", "bash", "edit", "bash"], description: "Read-Test-Fix-Verify" },
  { match: ["web_fetch", "read", "edit", "bash"], description: "Research-Read-Fix-Verify" },
  { match: ["bash", "bash", "bash"], description: "Repeated-Test" },
  { match: ["read", "read", "read"], description: "Multi-Source-Investigation" },
  { match: ["edit", "edit", "bash"], description: "Iterative-Fix-Verify" },
];

/**
 * Detect the dominant tool sequence pattern in a trajectory.
 * Returns the best-matching pattern description or a generated summary.
 *
 * Sync (heuristic) path. Used by the consolidation channel which runs
 * in a periodic background tick without an ExtensionContext. For
 * runtime use, prefer detectPatternWithLLM.
 */
export function detectPattern(tools: string[]): string {
  // Check for known patterns (consecutive 3-tool windows)
  for (let i = 0; i <= tools.length - 3; i++) {
    const window = tools.slice(i, i + 3);
    for (const pattern of COMMON_PATTERNS) {
      if (pattern.match.every((t, j) => window[j] === t)) {
        return pattern.description;
      }
    }
  }

  // Fallback: describe by phases
  const phases = [...new Set(tools.map((t) => TOOL_PHASES[t] ?? "other").filter(Boolean))];
  if (phases.length > 1) return phases.join("-").replace(/\b\w/g, (c) => c.toUpperCase());
  if (phases.length === 1)
    return `Focused ${phases[0].charAt(0).toUpperCase() + phases[0].slice(1)}`;
  return "General workflow";
}

/**
 * LLM-based pattern detection. Replaces the 9-hardcoded-pattern
 * window-matching with a single classify() call. The LLM is given
 * the known pattern vocabulary and asked to match or invent a
 * concise descriptive name.
 *
 * On LLM unavailability or degradation, falls back to detectPattern.
 */
export async function detectPatternWithLLM(
  tools: string[],
  ctx: ExtensionContext,
): Promise<string> {
  if (tools.length === 0) return "General workflow";
  try {
    const result = await classify(
      ctx,
      CRITICS.trajectoryPattern.criteria,
      { tools: tools.join(", ") },
      {
        // Inherit all critic options (including validLabels whitelist
        // for the multi-class pattern name) and add our local overrides.
        ...CRITICS.trajectoryPattern.options,
        timeoutMs: 3000,
        // bestEffort: this runs post-session when the session signal
        // is being torn down. TIER 2/3 aborts are expected; we use a
        // 3s timeout and demote failure warns to debug to keep the
        // end-of-loop logs clean. The classifier still returns a result
        // (label: "unknown" on failure) which we treat the same as the
        // heuristic fallback.
        bestEffort: true,
        fallback: () => "",
      },
    );
    const label = result.label.trim();
    if (label && label.length <= 60) return label;
  } catch (err) {
    log.debug(`detectPatternWithLLM failed: ${err}`);
  }
  return detectPattern(tools);
}

/**
 * Build category summary: {investigate: 5, modify: 2, ...}
 */
function categorizeTools(tools: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tools) {
    const cat = TOOL_CATEGORIES[t] ?? "other";
    counts[cat] = (counts[cat] ?? 0) + 1;
  }
  return counts;
}

// ── Main Extraction ─────────────────────────────────────────────────────────

/**
 * Extract structured SOP from a task trajectory.
 *
 * @param input - The task, trajectory, solution, and outcome
 * @returns Three-tier SOP (strategic, functional, atomic)
 */
export async function extractSOP(input: ExtractionInput): Promise<ExtractedSOP> {
  const { task, trajectory, outcome } = input;

  if (trajectory.length === 0) {
    return {
      strategicSOP: `Complete task: ${task}`,
      functionalSOP: [`Execute the task: ${task}`],
      atomicSOP: [],
    };
  }

  const tools = trajectory.map((t) => t.toolName);
  // Use LLM pattern detection when a context is available, else
  // fall through to the sync heuristic. The pattern is part of the
  // strategic SOP so the LLM's better name attribution is worth
  // the small extra cost on the success-path of task completion.
  const pattern = input.ctx
    ? await detectPatternWithLLM(tools, input.ctx)
    : detectPattern(tools);
  const categories = categorizeTools(tools);
  const uniqueTools = [...new Set(tools)];
  const successfulTools = trajectory.filter((t) => t.success).length;
  const totalTools = trajectory.length;

  // ── Strategic SOP (high-level) ────────────────────────────────────────
  // Describes WHAT to do at a strategy level

  const strategyParts: string[] = [`Use ${pattern} approach to ${task.toLowerCase()}`];
  if (uniqueTools.length > 0) {
    strategyParts.push(`Key tools: ${uniqueTools.join(", ")}`);
  }
  if (outcome === "success") {
    strategyParts.push(`Validated with ${successfulTools}/${totalTools} tool calls succeeding`);
  }

  // ── Functional SOP (step-by-step) ─────────────────────────────────────
  // Describes the HOW at a procedural level
  const steps: string[] = [];
  let lastPhase = "";

  for (const t of trajectory) {
    const phase = TOOL_PHASES[t.toolName] ?? "other";
    if (phase !== lastPhase) {
      const action =
        t.toolName === "edit"
          ? `Edit files to fix issues`
          : t.toolName === "read"
            ? `Read files to understand current state`
            : t.toolName === "bash"
              ? `Run commands to build/test/verify`
              : t.toolName === "write"
                ? `Create new files with correct content`
                : t.toolName === "grep" || t.toolName === "find"
                  ? `Search codebase for relevant patterns`
                  : t.toolName === "finalize"
                    ? `Complete and finalize the task`
                    : `Use ${t.toolName} for ${phase}`;
      if (!steps.includes(action)) {
        steps.push(action);
      }
      lastPhase = phase;
    }
  }

  // If no phase transitions detected, generate from category summary
  if (steps.length === 0) {
    if (categories.investigate) steps.push(`Investigate: read files and search for patterns`);
    if (categories.modify) steps.push(`Modify: edit and write files to implement changes`);
    if (categories.execute) steps.push(`Execute: run build/test commands`);
    if (categories.verify) steps.push(`Verify: confirm changes work correctly`);
    if (categories.complete) steps.push(`Complete: finalize the task`);
  }

  if (steps.length === 0) {
    steps.push(`Execute the task: ${task}`);
  }

  // ── Atomic SOP (tool sequence) ─────────────────────────────────────────
  // The actual tool-level sequence, deduplicating consecutive repeats
  const atomicSteps: string[] = [];
  let lastTool = "";
  let repeatCount = 0;

  for (const t of trajectory) {
    if (t.toolName === lastTool) {
      repeatCount++;
      continue;
    }
    if (repeatCount > 1) {
      atomicSteps[atomicSteps.length - 1] = `${lastTool} ×${repeatCount}`;
    }
    atomicSteps.push(t.toolName);
    lastTool = t.toolName;
    repeatCount = 1;
  }
  if (repeatCount > 1) {
    atomicSteps[atomicSteps.length - 1] = `${lastTool} ×${repeatCount}`;
  }

  const sop: ExtractedSOP = {
    strategicSOP: strategyParts.join(". "),
    functionalSOP: steps,
    atomicSOP: atomicSteps,
  };

  log.debug(
    `extracted SOP for "${task.slice(0, 60)}": ` +
      `strategic=${sop.strategicSOP.length}c ` +
      `functional=${sop.functionalSOP.length} steps ` +
      `atomic=${sop.atomicSOP.length} ops`,
  );

  return sop;
}
