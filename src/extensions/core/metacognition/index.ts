/**
 * Metacognition Extension — structured thinking, hypothesis generation, and task finalization.
 *
 * Decomposed into: think, hypothesize, finalize (each in handlers/).
 * All tools use the session model (ctx.model) directly — no separate utility model.
 * Research: docs/research/bicameral-mind-analysis.md
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "../../../lib/extension-state.js";
import { createThinkTool, recordCalibration } from "./handlers/think.js";
import { createHypothesizeTool } from "./handlers/hypothesize.js";
import { createFinalizeTool } from "./handlers/finalize.js";
import { createVerifyTool } from "./handlers/verify.js";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";

interface MetaMetrics {
  thinks: number;
  hypothesizes: number;
  finalizes: number;
  totalConfidence: number;
  hypothesesGenerated: number;
  hypothesesWithVerification: number;
  finalizationsBlocked: number;
  verifies: number;
  verificationsPassed: number;
  depthDistribution: Record<string, number>;
  reasoningTags: Record<string, number>;
}

function getMetaState(ctx: ExtensionContext): MetaMetrics {
  return getExtensionState<MetaMetrics>(ctx, "metacognition-metrics", () => ({
    thinks: 0,
    hypothesizes: 0,
    finalizes: 0,
    totalConfidence: 0,
    hypothesesGenerated: 0,
    hypothesesWithVerification: 0,
    finalizationsBlocked: 0,
    verifies: 0,
    verificationsPassed: 0,
    depthDistribution: {},
    reasoningTags: {},
  }));
}

export default function metacognitionExtension(pi: ExtensionAPI) {
  // Register tools
  pi.registerTool(createThinkTool() as any);
  pi.registerTool(createHypothesizeTool() as any);
  pi.registerTool(
    createFinalizeTool({
      onFinalize: (_summary, _completed) => {
        // Logging handled by the finalize tool's own execution
      },
      sendNextTask: (description) => {
        sendTrackedMessage(
          pi,
          {
            customType: "metacognition",
            content: [
              { type: "text" as const, text: `[system] Continue with next task: ${description}` },
            ],
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true },
          { type: "other", source: "metacognition/next-task" },
        );
      },
      recordCalibration,
    }) as any,
  );

  // ── Verify Tool ───────────────────────────────────────────────────────────
  pi.registerTool(createVerifyTool() as any);

  // Track tool usage
  pi.on("tool_execution_end", (event: any, ctx: ExtensionContext) => {
    const toolName = event?.toolName ?? "";
    if (!ctx || !toolName) return;
    const state = getMetaState(ctx);

    if (toolName === "think") {
      state.thinks++;
      const depth = event?.params?.depth ?? "quick";
      state.depthDistribution[depth] = (state.depthDistribution[depth] ?? 0) + 1;
      const tags: string[] = event?.params?.tags ?? [];
      for (const tag of tags) {
        state.reasoningTags[tag] = (state.reasoningTags[tag] ?? 0) + 1;
      }
      if (event?.params?.confidence !== undefined) {
        state.totalConfidence += event.params.confidence;
      }
    } else if (toolName === "hypothesize") {
      state.hypothesizes++;
      state.hypothesesGenerated += event?.params?.maxHypotheses ?? 3;
      if (event?.details?.scores?.some((s: any) => s.signals?.includes("verification-plan"))) {
        state.hypothesesWithVerification++;
      }
    } else if (toolName === "finalize") {
      state.finalizes++;
      if (event?.details?.blocked) {
        state.finalizationsBlocked++;
      }
    } else if (toolName === "verify") {
      state.verifies++;
      if (event?.details?.passed) {
        state.verificationsPassed++;
      }
    }
  });

  // Tools removed (2026-04-28): cognition_evaluate / heuristics_evaluate.
  // Reason: rarely used, indirect metric. Heuristic definitions kept for enforcement use.
}
