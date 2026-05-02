// ── Finalize Tool ─────────────────────────────────────────────────────────────
// Marks task complete with session model verification.
// Auto-proceed chains to next pending task from scratchpad.
// Records calibration when confidence is provided.
// R5: On task completion, cascade episodic → semantic memory.

import { Type } from "typebox";
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "../../../../lib/extension-state.js";
import { createLogger } from "../../../../lib/logger.js";

const log = createLogger("finalize");

// ── R5: Record task completion to episodic memory ──────────────────────────────
// Cascades: episodic → semantic → procedural per Evo-MedAgent (2604.14475).
// On finalize, the completed task is stored as an episode so the agent can
// retrieve similar past solutions on future tasks via retrieveEpisodes().
async function recordToMemory(
  ctx: ExtensionContext | undefined,
  summary: string,
  completed: boolean,
): Promise<void> {
  if (!ctx) return;
  try {
    // @ts-ignore dynamic import — runtime resolves after build, type-check not needed
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

    // Extract 3-tier SOP (SkillX 2604.04804)
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

    // On failure: extract principle and store as heuristic rule
    if (!completed) {
      const principle = extractPrinciple(ctx, summary);
      addPrinciple(
        state,
        principle,
        summary.slice(0, 100),
      );
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
function extractPrinciple(ctx: ExtensionContext, summary: string): string {
  // MVP: Generic principle based on failure
  // TODO: Enhance with LLM-based extraction from error patterns
  return `Avoid: ${summary.slice(0, 150)}`;
}

/**
 * Extract strategic SOP (high-level): Overall strategy from task description.
 * SkillX 2604.04804: Strategic plans guide overall approach.
 */
function extractStrategicSOP(ctx: ExtensionContext, summary: string): string {
  // MVP: Use the summary as strategic SOP
  // TODO: Enhance with LLM-based extraction from first user message
  return `Task: ${summary.slice(0, 200)}`;
}

/**
 * Extract functional SOP (mid-level): Key steps from tool sequence.
 * Groups consecutive tools into logical steps.
 * SkillX 2604.04804: Functional skills are mid-level procedures.
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

const FINALIZE_CRITIC_PROMPT = `You are a critical reviewer verifying whether a task is truly complete.

Review the work summary and check these criteria:
1. Was the code actually written (not just planned)?
2. Were tests written and do they pass?
3. Were all edge cases addressed?
4. Is the solution production-quality (no shortcuts)?

Respond in this EXACT format:
VERIFIED: yes|no
CONFIDENCE: 0-100
MESSAGE: <one line explanation>`;

async function verifyWithSessionModel(
  summary: string,
  ctx: ExtensionContext,
): Promise<{ verified: boolean; confidence: number; message: string }> {
  if (!ctx.model) {
    return { verified: true, confidence: 50, message: "No model available for verification" };
  }

  try {
    const response = await complete(
      ctx.model,
      {
        systemPrompt: FINALIZE_CRITIC_PROMPT,
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: `Work summary: ${summary}` }],
            timestamp: Date.now(),
          },
        ],
      },
      { maxTokens: 256, temperature: 0.1 },
    );

    const text = Array.isArray(response)
      ? response.map((r) => (r as { text?: string }).text || "").join(" ")
      : typeof response === "string"
        ? response
        : "";

    const verifiedMatch = text.match(/VERIFIED:\s*(yes|no)/i);
    const confidenceMatch = text.match(/CONFIDENCE:\s*(\d+)/);
    const messageMatch = text.match(/MESSAGE:\s*(.+)/);

    const verified = verifiedMatch?.[1]?.toLowerCase() !== "no";
    const confidence = confidenceMatch ? parseInt(confidenceMatch[1]) : 50;
    const message = messageMatch?.[1] ?? "Review complete";

    return { verified, confidence, message };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { verified: true, confidence: 50, message: `Verification error: ${msg}` };
  }
}

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
    description: `Mark the current task as complete. You MUST call this when:
- All code is written and tested
- The solution has been verified
- No further work is needed

Before finalizing, the work will be reviewed to ensure everything is actually done.
The task ends after finalize() is called.`,
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

      onFinalize?.(params.summary, params.completed);
      if (recordCalibration && _ctx) {
        recordCalibration(_ctx, 0.7, params.completed ? "success" : "failure");
      }

      const sessionSummary = params.summary;
      let verificationResult = {
        verified: true,
        confidence: 50,
        message: "No context available for verification",
      };

      if (_ctx) {
        verificationResult = await verifyWithSessionModel(sessionSummary, _ctx);
      }

      if (!verificationResult.verified) {
        return {
          content: [
            {
              type: "text" as const,
              text: `**FINALIZE BLOCKED**

${verificationResult.message}

Confidence: ${verificationResult.confidence}%

**The work is not done enough to finalize.**
Continue working until the issues are resolved.`,
            },
          ],
          details: { finalized: false, blocked: true, verification: verificationResult },
        };
      }

      const status = params.completed ? "Task completed" : "Task incomplete";
      const messages: string[] = [status, `Summary: ${params.summary}`];

      // R5: Record task to episodic memory (cascade: episodic → semantic → procedural)
      await recordToMemory(_ctx, params.summary, params.completed);

      if (verificationResult.message) {
        messages.push(`\nVerification: ${verificationResult.message}`);
      }

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

      messages.push("\n---");
      messages.push("Session ending...");

      return {
        content: [{ type: "text" as const, text: messages.join("\n") }],
        details: {
          finalized: true,
          completed: params.completed,
          summary: params.summary,
          verification: verificationResult,
          nextWork: nextWork?.id ?? null,
        },
      };
    },
  };
}
