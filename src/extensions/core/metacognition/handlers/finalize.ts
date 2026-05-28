// ── Finalize Tool ─────────────────────────────────────────────────────────────
// Records task outcome, triggers R5 memory cascade, and signals loop termination.
// Auto-proceed chains to next pending task from scratchpad.
// Records calibration when confidence is provided.
// R5: On task completion, cascade episodic → semantic memory.
// Pre-flight: checks if recent verify() passed, blocks finalization if unresolved issues remain.

import { Type } from "typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "../../../../lib/state/extension-state.js";
import { createLogger } from "../../../../lib/core/logger.js";
import { getLastVerification } from "./verify.js";

const log = createLogger("finalize");

// ── R5: Record task completion to episodic memory ──────────────────────────────
// Stores completed task as an episode so the agent can retrieve similar past
// solutions via retrieveEpisodes(). Currently episodic-only; the full
// cascade (episodic → semantic → procedural) is future work.
// retrieve similar past solutions on future tasks via retrieveEpisodes().
async function recordToMemory(
  ctx: ExtensionContext | undefined,
  summary: string,
  completed: boolean,
): Promise<void> {
  if (!ctx) return;
  try {
    // @ts-expect-error dynamic import — runtime resolves after build, type-check not needed
    const { addEpisode, addPrinciple } = await import("../../memory/three-memory-stores/index.js");
    const state = getExtensionState<any>(ctx, "three-memory-stores", () => ({
      episodes: [],
      heuristics: [],
      toolStats: new Map<string, unknown>(),
      currentSessionTools: [] as string[],
      sessionStartTime: Date.now(),
    }));
    const project = ctx.cwd ?? "unknown";
    const tags = inferTagsFromSummary(summary);
    const toolSeq = getSessionToolSequence(ctx);
    const outcome = completed ? "success" : "failure";

    // Extract 2-tier SOP: strategic (high-level plan) + functional (tool sequence)
    const strategicSOP = extractStrategicSOP(ctx, summary);
    const functionalSOP = extractFunctionalSOP(toolSeq);
    const atomicSOP = toolSeq; // Already the atomic-level SOP

    // addEpisode expects MemoryStoresState, we pass a compatible shape
    const episode = addEpisode(
      state,
      summary,
      `Outcome: ${outcome}`,
      outcome,
      toolSeq,
      tags,
      project,
      strategicSOP,
      functionalSOP,
      atomicSOP,
    );
    log.info(`R5: Recorded episode ${episode.id} (${outcome}) for: ${summary.slice(0, 60)}`);

    // R6: Feed successful outcomes into consolidation pipeline for hint generation.
    // This closes the loop: finalize → episode → consolidation → prompt hints.
    if (completed) {
      try {
        const { executeConsolidation } = await import("../../../../lib/consolidation-channel.js");
        const result = executeConsolidation({
          id: episode.id,
          task: summary,
          outcome: "success",
          project,
          strategicSOP,
          functionalSOP,
          toolSequence: atomicSOP,
        });
        if (result) {
          log.info(
            `R6: Consolidation candidate enqueued ` +
              `(score=${result.consolidationScore.toFixed(2)})`,
          );
        }
      } catch (consolErr) {
        log.debug(`R6: Consolidation skipped: ${(consolErr as Error).message}`);
      }
    }

    // On failure: extract principle and store as heuristic rule
    if (!completed) {
      const principle = extractPrinciple(ctx, summary);
      addPrinciple(state, principle, summary.slice(0, 100));
      log.info(`R5: Extracted principle from failure: ${principle.slice(0, 60)}`);
    }
  } catch (err) {
    log.debug(`R5: Memory recording skipped: ${(err as Error).message}`);
  }
}

/**
 * Extract principle from failed task.
 * MARS 2601.11974: Principle-based reflection ("What general rule should I follow?")
 */
function extractPrinciple(_ctx: ExtensionContext, summary: string): string {
  // Extract a concise principle from the outcome summary.
  // Uses keyword matching to generate a meaningful rule.
  // For now: simple pattern extraction; could use LLM in future.
  const lower = summary.toLowerCase();
  if (lower.includes("learned:") || lower.includes("principle:")) {
    const match = summary.match(/(?:learned|principle):\s*([^.]+)/i);
    if (match) return match[1].trim();
  }
  if (lower.includes("avoid")) {
    const match = summary.match(/avoid[^.]*/i);
    if (match) return match[0].trim();
  }
  if (lower.includes("should") || lower.includes("always") || lower.includes("never")) {
    const match = summary.match(/(?:should|always|never)[^.]*/i);
    if (match) return match[0].trim();
  }
  return summary.length > 120 ? summary.slice(0, 117) + "..." : summary;
}

/**
 * Extract strategic SOP (high-level): Overall strategy from task description.
 * Simple implementation: uses the summary directly. Full extraction is future work.
 */
function extractStrategicSOP(_ctx: ExtensionContext, summary: string): string {
  return `Task: ${summary.slice(0, 200)}`;
}

/**
 * Extract functional SOP (mid-level): Key steps from tool sequence.
 * Groups consecutive tools into logical steps.
 */
function extractFunctionalSOP(toolSeq: string[]): string[] {
  if (toolSeq.length === 0) return [];

  const steps: string[] = [];
  let currentStep = "";
  let lastTool = "";

  for (const tool of toolSeq) {
    // Group consecutive same-type tools
    if (tool === lastTool) {
      // Part of same step, skip
      continue;
    }

    // New tool type - save previous step and start new
    if (currentStep) {
      steps.push(currentStep);
    }
    currentStep = tool;
    lastTool = tool;
  }

  if (currentStep) {
    steps.push(currentStep);
  }

  return steps.length > 0 ? steps : ["No clear steps identified"];
}

function inferTagsFromSummary(summary: string): string[] {
  const tags: string[] = [];
  const lower = summary.toLowerCase();
  if (lower.includes("fix") || lower.includes("bug")) tags.push("bug-fix");
  if (lower.includes("audit")) tags.push("audit");
  if (lower.includes("test")) tags.push("testing");
  if (lower.includes("refactor")) tags.push("refactoring");
  if (lower.includes("feature")) tags.push("feature");
  if (lower.includes("session") || lower.includes("memory")) tags.push("session-isolation");
  if (lower.includes("retry")) tags.push("retry-system");
  if (lower.includes("behavior")) tags.push("behavior-research");
  if (lower.includes("three-memory") || lower.includes("three memory")) tags.push("three-memory");
  return tags.length > 0 ? tags : ["general"];
}

function getSessionToolSequence(ctx: ExtensionContext): string[] {
  try {
    const analytics = getExtensionState<any>(ctx, "analytics", () => null);
    if (analytics?.toolCallSequence) return analytics.toolCallSequence.slice(-20);
  } catch {
    // best-effort
  }
  return [];
}

const finalizeSchema = Type.Object({
  completed: Type.Boolean({ description: "Whether the task was successfully completed" }),
  summary: Type.String({ description: "Brief summary of what was accomplished" }),
  tasksRemaining: Type.Optional(Type.Array(Type.String(), { description: "Follow-up tasks" })),
  autoProceed: Type.Optional(
    Type.Boolean({ description: "Automatically propose next pending work on finalize" }),
  ),
});

/**
 * Find the next pending task from scratchpad's task store.
 * Returns the first incomplete task, or null if none.
 */
async function findNextWork(
  ctx?: ExtensionContext,
): Promise<{ id: string; description: string } | null> {
  if (!ctx) return null;

  try {
    const scratchpad = getExtensionState<any>(ctx, "scratchpad", () => null);
    if (!scratchpad?.taskStore?.tasks) return null;

    const pending = scratchpad.taskStore.tasks.find(
      (t: any) => t.status === "pending" || t.status === "in_progress",
    );
    if (!pending) return null;

    return { id: pending.id, description: pending.text || pending.description || pending.id };
  } catch {
    return null;
  }
}

export interface FinalizeCallbacks {
  onFinalize?: (summary: string, completed: boolean) => void;
  sendNextTask?: (description: string) => void;
  recordCalibration?: (
    ctx: ExtensionContext,
    confidence: number,
    outcome: "success" | "failure",
  ) => void;
}

export function createFinalizeTool(callbacks: FinalizeCallbacks = {}) {
  const { onFinalize, sendNextTask, recordCalibration } = callbacks;

  return {
    name: "finalize" as const,
    label: "Finalize",
    promptSnippet: "Mark the current task as complete and trigger review",
    description: `Mark a task complete and record it to session memory. Checks recent verify() result and blocks if unresolved issues remain. After finalize, respond with text only (no tool calls) to end the agent loop cleanly.`,
    parameters: finalizeSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: unknown,
      _onUpdate: unknown,
      _ctx: ExtensionContext | undefined,
    ) => {
      if (!params || params.summary === undefined || params.completed === undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: `**FINALIZE REQUIRES PARAMETERS**

Missing required fields. Please provide:
- completed: boolean (true if task succeeded, false if not)
- summary: string (what was accomplished)
- tasksRemaining?: string[] (optional follow-up tasks)

Example:
finalize(completed=true, summary="Fixed the bug", tasksRemaining=["write tests"])`,
            },
          ],
          details: { finalized: false, blocked: true, error: "missing_params" },
        };
      }

      // ── Pre-flight check: verify() must have passed ──────────────────────
      if (_ctx && !params.completed) {
        const lastVerification = getLastVerification(_ctx);
        if (lastVerification && !lastVerification.passed) {
          const elapsedMs = Date.now() - lastVerification.createdAt;
          // Only block if verify result is recent (within last 5min)
          if (elapsedMs < 300_000) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `**⚠️ FINALIZE BLOCKED — verify() found unresolved issues**

Last verification (${Math.round(elapsedMs / 1000)}s ago):
- Target: ${lastVerification.target}
- Issues: ${lastVerification.issueCount}
- Confidence: ${(lastVerification.confidence * 100).toFixed(0)}%

Run \`verify()\` again after fixing the issues, or set \`completed: true\` to finalize as-is.`,
                },
              ],
              details: {
                finalized: false,
                blocked: true,
                reason: "verify_failed",
                lastVerification: {
                  target: lastVerification.target,
                  issues: lastVerification.issueCount,
                  confidence: lastVerification.confidence,
                },
              },
            };
          }
        }
      }

      onFinalize?.(params.summary, params.completed);
      if (recordCalibration && _ctx) {
        recordCalibration(_ctx, 0.7, params.completed ? "success" : "failure");
      }

      // Fire-and-forget: record to memory asynchronously (don't block tool result on I/O)
      recordToMemory(_ctx, params.summary, params.completed).catch(() => {});

      const status = params.completed ? "Task completed" : "Task incomplete";
      const messages: string[] = [status, `Summary: ${params.summary}`];

      if (params.tasksRemaining?.length) {
        messages.push(`\nFollow-up needed: ${params.tasksRemaining.join(", ")}`);
      }

      const nextWork = await findNextWork(_ctx);
      if (nextWork) {
        messages.push(`\n📋 **Next pending task:** ${nextWork.description}`);
        if (params.autoProceed) {
          messages.push(`\n✅ Auto-proceeding to next task...`);
          setTimeout(() => {
            sendNextTask?.(nextWork.description);
          }, 500);
        } else {
          messages.push(`\n💡 Set \`autoProceed: true\` to continue automatically.`);
        }
      } else {
        messages.push(`\n✅ No pending tasks remaining.`);
      }

      messages.push("");
      messages.push("**IMPORTANT: DO NOT call any tools after this message.**");
      messages.push(
        "The agent loop terminates cleanly when you respond with text only — no tool calls.",
      );
      messages.push("Acknowledge completion in a brief text response, then stop.");

      return {
        content: [{ type: "text" as const, text: messages.join("\n") }],
        details: {
          finalized: true,
          completed: params.completed,
          summary: params.summary,
          nextWork: nextWork?.id ?? null,
        },
      };
    },
  };
}
