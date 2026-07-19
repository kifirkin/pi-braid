// ── Finalize Tool ─────────────────────────────────────────────────────────────
// Records task outcome, triggers R5 memory cascade, and signals loop termination.
// Auto-proceed chains to next pending task from scratchpad.
// Records calibration when confidence is provided.
// R5: On task completion, cascade episodic -> semantic memory.
// Pre-flight: checks if recent verify() passed, blocks finalization if unresolved issues remain.

import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../../../lib/state/extension-state.js";
import { createLogger } from "../../../../lib/core/logger.js";
import { getLastVerification } from "./verify.js";
import { addEpisode, addPrinciple } from "../../../memory/three-memory-stores/index.js";
import { executeConsolidation } from "../../../../lib/events/consolidation-channel.js";
import { handleArchiveDone, handlePersistLearnings } from "../../../memory/scratchpad/handlers.js";
import type { TaskScratchpad, KeyLearning } from "../../../memory/scratchpad/types.js";
import { getSessionManager } from "../../../../lib/state/session-manager.js";
import { getUnresolvedConflicts } from "../../../../lib/store/evidence-pool.js";
import { getCognitiveMemory } from "../../../../lib/memory/index.js";
import type { CognitiveMemoryType } from "../../../../lib/memory/types.js";
import { deriveProjectIdFromCwd } from "../../../../lib/memory/past-insights.js";

const log = createLogger("finalize");

// ── R5: Record task completion to episodic memory ──────────────────────────────
// Stores completed task as an episode so the agent can retrieve similar past
// solutions via retrieveEpisodes(). Currently episodic-only; the full
// cascade (episodic -> semantic -> procedural) is future work.
// retrieve similar past solutions on future tasks via retrieveEpisodes().
async function recordToMemory(
  ctx: ExtensionContext | undefined,
  summary: string,
  completed: boolean,
): Promise<void> {
  if (!ctx) return;
  try {
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
    // This closes the loop: finalize -> episode -> consolidation -> prompt hints.
    if (completed) {
      try {
        const result = await executeConsolidation({
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
 *
 * The previous implementation used three fragile keyword regexes
 * (looking for "learned:" / "avoid" / "should|always|never" prefixes)
 * that always defaulted to a summary slice when no keyword matched.
 * The LLM tier does the principled extraction; the heuristic is just
 * a truncation that always succeeds and stores something useful.
 */
function extractPrinciple(_ctx: ExtensionContext, summary: string): string {
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
    Type.Boolean({
      description: "Automatically propose next pending work on finalize. Defaults to true when there are pending tasks.",
    }),
  ),
});

/**
 * Find the next pending task from scratchpad's plan items.
 * Returns the first incomplete plan step, or null if none.
 */
function findNextWork(
  ctx?: ExtensionContext,
): { id: string; description: string } | null {
  if (!ctx) return null;

  try {
    const cache = getExtensionState<{ pad: TaskScratchpad | null }>(
      ctx, "scratchpad-cache", () => ({ pad: null }),
    );
    if (!cache?.pad) return null;

    const pending = cache.pad.plan.find((p) => p.doneTurn === 0);
    if (!pending) return null;

    return { id: pending.id, description: pending.text };
  } catch {
    return null;
  }
}

/**
 * Find unpersisted learnings in the scratchpad.
 * Returns the count of learnings with persisted===false, or null if scratchpad unavailable.
 */
function findUnpersistedLearnings(ctx?: ExtensionContext): number | null {
  if (!ctx) return null;
  try {
    const cache = getExtensionState<{ pad: TaskScratchpad | null }>(
      ctx, "scratchpad-cache", () => ({ pad: null }),
    );
    if (!cache?.pad) return null;
    const unpersisted = cache.pad.key_learnings.filter((l) => !l.persisted);
    return unpersisted.length > 0 ? unpersisted.length : null;
  } catch {
    return null;
  }
}

/**
 * Archive done items to disk and clear from scratchpad after successful finalize.
 * Uses handleArchiveDone (append-only JSONL) instead of handleClearDone (wipe)
 * so the done history survives across sessions.
 * Fire-and-forget: failures are logged but not surfaced.
 */
async function archiveScratchpadDone(ctx: ExtensionContext): Promise<void> {
  try {
    const cache = getExtensionState<{ pad: TaskScratchpad | null }>(
      ctx, "scratchpad-cache", () => ({ pad: null }),
    );
    if (cache?.pad) {
      await handleArchiveDone(cache.pad);
    }
  } catch {
    // best-effort
  }
}

/**
 * Auto-tag current session position after successful finalize.
 * Creates a named checkpoint so the agent can navigate back to this point.
 * Tag name derived from summary prefix (first 40 chars, sanitized).
 * Fire-and-forget: failures are logged but not surfaced.
 */
async function autoTagPosition(ctx: ExtensionContext, summary: string): Promise<void> {
  try {
    const tagName = "after-" + summary
      .slice(0, 40)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const sm = getSessionManager(ctx);
    const leafId = sm.getLeafId();
    sm.setLabel(leafId, tagName);
    log.info(`Auto-tagged position as "${tagName}" on finalize`);
  } catch {
    // best-effort
  }
}

/**
 * Map scratchpad KeyLearning.category to CognitiveMemoryType.
 */
function mapCategoryToMemoryType(category: KeyLearning["category"]): CognitiveMemoryType {
  switch (category) {
    case "root_cause": return "error";
    case "pattern": return "pattern";
    case "fix": return "pattern";
    case "constraint": return "insight";
    case "codebase_fact": return "semantic";
  }
}

/**
 * Auto-persist unpersisted learnings to long-term memory.
 * Called inside finalize before the no-tools message, so the agent doesn't need
 * to call memory_store separately. Eliminates the contradiction between
 * "store learnings" and "don't call any tools" in the finalize output.
 * Fire-and-forget: failures are logged but not surfaced to the agent.
 */
async function autoPersistLearnings(ctx: ExtensionContext): Promise<number> {
  try {
    const cache = getExtensionState<{ pad: TaskScratchpad | null }>(
      ctx, "scratchpad-cache", () => ({ pad: null }),
    );
    if (!cache?.pad) return 0;

    const unpersisted = cache.pad.key_learnings.filter((l) => !l.persisted);
    if (unpersisted.length === 0) return 0;

    const memory = getCognitiveMemory();
    const projectId = deriveProjectIdFromCwd(ctx.cwd ?? "");

    for (const learning of unpersisted) {
      try {
        await memory.store(
          learning.content,
          mapCategoryToMemoryType(learning.category),
          {
            tags: learning.scope.length > 0 ? learning.scope : undefined,
            source: "finalize",
            importance: 0.5,
            projectId,
          },
        );
      } catch (storeErr) {
        log.warn(`Auto-persist failed for learning ${learning.id}: ${(storeErr as Error).message}`);
      }
    }

    // Mark them persisted in scratchpad
    await handlePersistLearnings(cache.pad);
    return unpersisted.length;
  } catch {
    return 0;
  }
}

export interface FinalizeCallbacks {
  onFinalize?: (summary: string, completed: boolean) => void;
  recordCalibration?: (
    ctx: ExtensionContext,
    confidence: number,
    outcome: "success" | "failure",
  ) => void;
}

export function createFinalizeTool(callbacks: FinalizeCallbacks = {}): ToolDefinition<any, any, any> {
  const { onFinalize, recordCalibration } = callbacks;

  return {
    name: "finalize" as const,
    label: "Finalize",
    promptSnippet: "Mark the current task as complete and trigger review",
    description: `Mark a task complete and record it to session memory. Must call at the end of every task or significant subtask — never finish work without finalizing. Checks recent verify() result and blocks if unresolved issues remain. The verification triple on each done item must guard specific failure modes — 'file was modified' is not a meaningful check, 'behavior changed as expected' is. After finalize, respond with text only (no tool calls) to end the agent loop cleanly.\n\nAutomation (all fire-and-forget):\n- Archives done items to disk (append-only JSONL, survives across sessions)\n- Auto-tags current session position for navigation back to this point\n- Auto-proceeds to next pending task by default (set autoProceed=false to disable)\n- Auto-persists unpersisted learnings to long-term memory (no separate memory_store call needed)`,
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
                  text: `**[warn] FINALIZE BLOCKED - verify() found unresolved issues**

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

      // Fire-and-forget: archive done items and auto-tag position after successful finalize
      if (_ctx && params.completed) {
        archiveScratchpadDone(_ctx).catch(() => {});
        autoTagPosition(_ctx, params.summary).catch(() => {});
      }

      // Auto-persist unpersisted learnings atomically — resolves the contradiction
      // between "store learnings" and "don't call any tools" in the output.
      const persistedCount = _ctx ? await autoPersistLearnings(_ctx) : 0;

      const status = params.completed ? "Task completed" : "Task incomplete";
      const messages: string[] = [status, `Summary: ${params.summary}`];

      if (params.tasksRemaining?.length) {
        messages.push(`\nFollow-up needed: ${params.tasksRemaining.join(", ")}`);
      }

      const nextWork = findNextWork(_ctx);
      const unpersistedLearnings = findUnpersistedLearnings(_ctx);

      // ── Pre-flight: check for unresolved conflicts ──────────────────────
      if (_ctx) {
        const unresolved = getUnresolvedConflicts(_ctx);
        if (unresolved.length > 0) {
          messages.push(
            `\n⚠️ **${unresolved.length} unresolved source conflict(s).** ` +
            `Resolve with \`conflict_qa(action="resolve", ...)\` before they ` +
            `accumulate across sessions.`
          );
        }
      }

      if (persistedCount > 0) {
        messages.push(`\n📚 **${persistedCount} learning(s) auto-persisted to memory.**`);
      } else if (unpersistedLearnings) {
        messages.push(
          `\n📚 **${unpersistedLearnings} learning(s) could not be auto-persisted.** ` +
          `Call \`memory_store(content=..., memoryType=..., tags=...)\` ` +
          `manually, or the next finalize will retry.`
        );
      }

      if (nextWork) {
        messages.push(`\n📋 **Next pending task:** ${nextWork.description}`);
        messages.push(`\n[ok] Auto-proceed to next task.`);
      } else {
        messages.push(`\n[ok] No pending tasks remaining.`);
      }

      messages.push("");
      messages.push("**IMPORTANT: DO NOT call any tools after this message.**");
      messages.push(
        "The agent loop terminates cleanly when you respond with text only - no tool calls.",
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
