/**
 * MARS (Memory-Augmented Reflection) — principle + procedure reflection.
 *
 * Based on MARS (2601.11974) which introduces two reflection types:
 *   1. Principle reflection: After task completion, extract general rules
 *      ("what should I follow to avoid errors?") → store as heuristics.
 *   2. Procedure reflection: After successful task, extract steps that
 *      led to success → store as episodic memory.
 *
 * Triggers: on task completion (finalize called with completed=true, or
 * significant work done without finalize). Not every turn — the original
 * MARS paper fires reflection only at episode boundaries.
 *
 * The old statistical tool-usage frequency analyzer was renamed to
 * `tool-usage-analyzer.ts`. This file implements the actual MARS paper.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../core/logger.js";
import { getMemoryState } from "../../extensions/heartbeat/heartbeat-scheduler/state.js";
import {
  addPrinciple,
  addEpisode,
} from "../../extensions/memory/three-memory-stores/index.js";

const log = createLogger("mars");

// ── Types ──────────────────────────────────────────────────────────────────

/** A single reflection produced by MARS. */
export interface MARSReflection {
  /** Principle (heuristic rule) or procedure (episodic steps). */
  type: "principle" | "procedure";
  /** The reflection content — the principle rule or procedure steps. */
  content: string;
  /** Model confidence (0-1) based on pattern strength. */
  confidence: number;
  /** Context summary for the task that triggered this reflection. */
  taskContext: string;
}

/** Session data snapshot for the reflection to analyze. */
export interface SessionSnapshot {
  toolsUsed: string[];
  uniqueToolCount: number;
  totalToolCalls: number;
  errorCount: number;
  thinkCalls: number;
  scratchpadCalls: number;
  verifyCalls: number;
  editCalls: number;
  writeCalls: number;
  finalizeCalled: boolean;
  turnCount: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Minimum tool calls before reflection is meaningful. */
const MIN_TOOL_CALLS_FOR_REFLECTION = 5;

/** Minimum session turns before reflection fires. */
const MIN_TURNS_FOR_REFLECTION = 3;

/** Confidence boost for a strong pattern (multiple data points). */
const STRONG_PATTERN_CONFIDENCE = 0.85;

/** Moderate pattern confidence. */
const MODERATE_PATTERN_CONFIDENCE = 0.6;

/** Weak pattern confidence. */
const WEAK_PATTERN_CONFIDENCE = 0.4;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Analyze the session snapshot and produce principle reflections.
 * Principle reflections are general rules extracted from failure/success
 * patterns: "After editing, always verify" or "Use think before edits."
 *
 * @param ctx - Extension context
 * @param session - Session snapshot at task completion
 * @returns Array of principle reflections
 */
export function reflectPrinciples(
  ctx: ExtensionContext,
  session: SessionSnapshot,
): MARSReflection[] {
  const principles: MARSReflection[] = [];
  const taskContext = buildTaskContext(session);

  if (session.totalToolCalls < MIN_TOOL_CALLS_FOR_REFLECTION) return principles;

  // Pattern: edits without prior think
  if (session.editCalls > 0 && session.thinkCalls === 0) {
    principles.push({
      type: "principle",
      content: "Before editing files, call think(observation, decision, reason) to validate your reasoning first. Editing without thinking is the most common source of wasted turns.",
      confidence: session.editCalls > 3 ? STRONG_PATTERN_CONFIDENCE : MODERATE_PATTERN_CONFIDENCE,
      taskContext,
    });
  }

  // Pattern: edits without verification
  if (session.editCalls + session.writeCalls > 0 && session.verifyCalls === 0) {
    principles.push({
      type: "principle",
      content: "After changing code, run verify(target=\"code\", criteria=[\"...\", \"...\"]) before moving on. Verification catches errors that rereading would miss.",
      confidence: session.editCalls + session.writeCalls > 3
        ? STRONG_PATTERN_CONFIDENCE
        : MODERATE_PATTERN_CONFIDENCE,
      taskContext,
    });
  }

  // Pattern: work without scratchpad
  if (session.totalToolCalls > 5 && session.scratchpadCalls === 0) {
    principles.push({
      type: "principle",
      content: "Before starting work, set a goal with scratchpad(action=\"set_goal\", text=\"...\") and break it into steps with scratchpad(action=\"add_plan\", text=\"...\"). A clear plan prevents drift and enables session resumption.",
      confidence: session.totalToolCalls > 10 ? STRONG_PATTERN_CONFIDENCE : WEAK_PATTERN_CONFIDENCE,
      taskContext,
    });
  }

  // Pattern: high error rate
  if (session.errorCount > 0 && session.totalToolCalls > 0) {
    const errorRate = session.errorCount / session.totalToolCalls;
    if (errorRate > 0.3) {
      principles.push({
        type: "principle",
        content: "When tool errors recur, step back and think(type=\"reflection\") to identify the root cause. The tools work reliably — the failure is almost always an agent mistake: wrong arguments, stale content, or incorrect indentation.",
        confidence: errorRate > 0.5 ? STRONG_PATTERN_CONFIDENCE : MODERATE_PATTERN_CONFIDENCE,
        taskContext,
      });
    }
  }

  // Pattern: narrow tool diversity (over-reliance on a single tool category)
  if (session.uniqueToolCount <= 3 && session.totalToolCalls >= 8) {
    principles.push({
      type: "principle",
      content: `Used only ${session.uniqueToolCount} unique tools across ${session.totalToolCalls} calls. Consider a broader approach: grep/find for code search, read for context, think for reasoning — each tool serves a different purpose.`,
      confidence: MODERATE_PATTERN_CONFIDENCE,
      taskContext,
    });
  }

  return principles;
}

/**
 * Analyze the session snapshot and produce procedure reflections.
 * Procedure reflections capture the concrete steps that led to success,
 * stored as episodic memory for cross-session retrieval.
 *
 * @param ctx - Extension context
 * @param session - Session snapshot at task completion
 * @returns Array of procedure reflections
 */
export function reflectProcedures(
  ctx: ExtensionContext,
  session: SessionSnapshot,
): MARSReflection[] {
  const procedures: MARSReflection[] = [];
  const taskContext = buildTaskContext(session);

  if (session.totalToolCalls < MIN_TOOL_CALLS_FOR_REFLECTION) return procedures;

  // Classify task type based on tool distribution
  const taskType = classifyTaskType(session);

  // Build a procedure from the tool sequence
  const procedureSteps = buildProcedureDescription(session, taskType);
  if (procedureSteps) {
    procedures.push({
      type: "procedure",
      content: procedureSteps,
      confidence: session.finalizeCalled ? MODERATE_PATTERN_CONFIDENCE : WEAK_PATTERN_CONFIDENCE,
      taskContext,
    });
  }

  return procedures;
}

/**
 * Full reflection pass — runs both principle and procedure reflection
 * and stores the results to heuristics/episodic memory. This is the
 * main entry point for the mars-handler.
 *
 * @param ctx - Extension context
 * @param session - Session snapshot at task completion
 * @returns Array of all reflections produced
 */
export function reflectOnTaskCompletion(
  ctx: ExtensionContext,
  session: SessionSnapshot,
): MARSReflection[] {
  if (session.totalToolCalls < MIN_TOOL_CALLS_FOR_REFLECTION) return [];
  if (session.turnCount < MIN_TURNS_FOR_REFLECTION) return [];

  const reflections: MARSReflection[] = [];

  // Principle reflections
  const principles = reflectPrinciples(ctx, session);
  for (const p of principles) {
    log.info(`Principle reflection: "${p.content.slice(0, 80)}..." (confidence=${p.confidence})`);
    storePrinciple(ctx, p);
  }
  reflections.push(...principles);

  // Procedure reflections — only on actual completion
  if (session.finalizeCalled) {
    const procedures = reflectProcedures(ctx, session);
    for (const p of procedures) {
      log.info(`Procedure reflection: "${p.content.slice(0, 80)}..." (confidence=${p.confidence})`);
      storeProcedure(ctx, p);
    }
    reflections.push(...procedures);
  }

  return reflections;
}

// ── Storage ────────────────────────────────────────────────────────────────

/**
 * Store a principle reflection as a heuristic rule via the three-memory-stores.
 * Principles with sufficient confidence are added as heuristics; evolver.ts
 * will boost/discount them over time based on actual usage.
 */
function storePrinciple(ctx: ExtensionContext, reflection: MARSReflection): void {
  if (reflection.confidence < WEAK_PATTERN_CONFIDENCE) return;

  const memState = getMemoryState(ctx);
  if (!memState) {
    log.debug("Cannot store principle: no memory state available");
    return;
  }

  const condition = extractCondition(reflection.content);
  addPrinciple(memState, reflection.content, condition);
  log.info(`Stored principle "${reflection.content.slice(0, 60)}..." as heuristic [condition=${condition}]`);
}

/**
 * Store a procedure reflection as an episodic memory entry.
 * Procedures are stored with tags for cross-session retrieval.
 */
function storeProcedure(ctx: ExtensionContext, reflection: MARSReflection): void {
  const memState = getMemoryState(ctx);
  if (!memState) {
    log.debug("Cannot store procedure: no memory state available");
    return;
  }

  const tags = extractProcedureTags(reflection.taskContext);
  addEpisode(
    memState,
    reflection.taskContext,
    reflection.content,
    "success",
    [],
    [...tags, "mars-reflection", "procedure"],
  );
  log.info(`Stored procedure for "${reflection.taskContext.slice(0, 60)}..." as episode`);
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a human-readable task context string from the session snapshot.
 */
function buildTaskContext(session: SessionSnapshot): string {
  if (session.toolsUsed.length === 0) return "empty session";

  // Use the last 3 unique tools as a signature
  const uniqueTools = [...new Set(session.toolsUsed.slice(-10))].slice(0, 5);
  const toolStr = uniqueTools.join(", ");

  return `${session.totalToolCalls} tool calls, ${session.uniqueToolCount} unique tools (${toolStr}), ${session.turnCount} turns, ${session.errorCount} errors`;
}

/**
 * Classify the task type based on tool distribution.
 */
function classifyTaskType(session: SessionSnapshot): string {
  const hasCodeTools = session.editCalls > 0 || session.writeCalls > 0;
  const hasVerifyTools = session.verifyCalls > 0;
  const hasSearchTools = session.toolsUsed.some((t) =>
    ["grep", "find", "read"].includes(t),
  );
  const hasBrowserTools = session.toolsUsed.some((t) =>
    ["browser_navigate", "browser_snapshot"].includes(t),
  );

  if (hasCodeTools && hasVerifyTools) return "code-change-with-verification";
  if (hasCodeTools) return "code-change";
  if (hasBrowserTools) return "web-research";
  if (hasSearchTools && !hasCodeTools) return "code-exploration";
  if (hasSearchTools) return "research";
  return "general";
}

/**
 * Build a procedure description from the session tool usage pattern.
 */
function buildProcedureDescription(session: SessionSnapshot, taskType: string): string | null {
  const steps: string[] = [];

  switch (taskType) {
    case "code-change-with-verification":
      steps.push("1. Understand the problem (read error, grep for symptom)");
      steps.push("2. Plan the fix (think about root cause, consider alternatives)");
      steps.push("3. Edit the fix (use edit/write for targeted changes)");
      steps.push("4. Verify correctness (use verify tool to check)");
      steps.push("5. Confirm completion (run tests, call finalize)");
      break;

    case "code-change":
      steps.push("1. Read the relevant files to understand current state");
      steps.push("2. Think about the approach and alternatives");
      steps.push("3. Make the code change (edit/write)");
      steps.push("4. Verify the change before moving on");
      break;

    case "web-research":
      steps.push("1. Navigate to the source (browser_navigate)");
      steps.push("2. Extract relevant content (browser_*)");
      steps.push("3. Synthesize findings into structured notes");
      break;

    case "code-exploration":
      steps.push("1. Search for relevant symbols/types (grep/find)");
      steps.push("2. Read the files to understand structure (read)");
      steps.push("3. Map dependencies and interfaces");
      break;

    case "research":
      steps.push("1. Fetch the source material (web_fetch/read)");
      steps.push("2. Extract key claims and evidence");
      steps.push("3. Verify claims against multiple sources");
      break;

    default:
      return null;
  }

  return `Procedure for ${taskType}:\n${steps.join("\n")}`;
}

/**
 * Extract a heuristic condition from a principle's content.
 * The condition is used by the recaller to match against current context.
 */
function extractCondition(principleContent: string): string {
  // Extract key action-oriented phrases
  const patterns = [
    /(before\s+\w+)/i,
    /(after\s+\w+)/i,
    /(when\s+\w+)/i,
    /(\w+\s+is\s+the most common)/i,
  ];

  for (const pattern of patterns) {
    const match = principleContent.match(pattern);
    if (match) return match[1].toLowerCase();
  }

  // Fallback: use first meaningful verb phrase
  const firstSentence = principleContent.split(/[.!]/)[0];
  return firstSentence.slice(0, 60).toLowerCase();
}

/**
 * Extract tags from the task context for episodic storage.
 */
function extractProcedureTags(taskContext: string): string[] {
  const tags: string[] = [];
  if (taskContext.includes("error")) tags.push("error-recovery");
  if (taskContext.includes("code")) tags.push("code");
  if (taskContext.includes("research")) tags.push("research");
  if (/unique|diverse/.test(taskContext)) tags.push("tool-usage");
  return tags;
}