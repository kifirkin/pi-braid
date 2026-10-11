/**
 * Metacognition Extension - structured thinking, hypothesis generation, and task finalization.
 *
 * Decomposed into: think, hypothesize, finalize (each in handlers).
 * All tools use the session model (ctx.model) directly - no separate utility model.
 * Research: docs/research/bicameral-mind-analysis.md
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { createThinkTool, recordCalibration } from "./handlers/think.js";
import { createHypothesizeTool } from "./handlers/hypothesize.js";
import { createFinalizeTool } from "./handlers/finalize.js";
import { createVerifyTool } from "./handlers/verify.js";
import { registerClaimVerificationTools } from "./handlers/claim-verification.js";

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
  // Register tools. Each factory returns a properly typed ToolDefinition,
  // so the call site needs no `as` cast.
  pi.registerTool(createThinkTool());
  pi.registerTool(createHypothesizeTool());
  pi.registerTool(
    createFinalizeTool({
      onFinalize: (_summary, _completed) => {
        // Logging handled by the finalize tool's own execution
      },
      recordCalibration,
      // Labels persist through the extension API; the session manager instance
      // exposes no setter.
      setLabel: (entryId, label) => pi.setLabel(entryId, label),
    }),
  );

  pi.registerTool(createVerifyTool());

  registerClaimVerificationTools(pi);

  // Tool metrics are fed from the `tool_result` event: it is the one that
  // carries both the validated arguments (`input`) and the tool's result
  // details (`details`). `tool_execution_end` carries only
  // `{toolCallId, toolName, result, isError}`, so reading `params` / `details`
  // off it left every counter below permanently at zero.
  pi.on("tool_result", (event: any, ctx: ExtensionContext) => {
    const toolName = event?.toolName ?? "";
    if (!ctx || !toolName) return;
    const state = getMetaState(ctx);
    const input: Record<string, any> = event?.input ?? {};
    const details: Record<string, any> = event?.details ?? {};

    if (toolName === "think") {
      state.thinks++;
      const depth = input.depth ?? "quick";
      state.depthDistribution[depth] = (state.depthDistribution[depth] ?? 0) + 1;
      const tags: string[] = input.tags ?? [];
      for (const tag of tags) {
        state.reasoningTags[tag] = (state.reasoningTags[tag] ?? 0) + 1;
      }
      if (input.confidence !== undefined) {
        state.totalConfidence += input.confidence;
      }
    } else if (toolName === "hypothesize") {
      state.hypothesizes++;
      state.hypothesesGenerated += details.hypotheses ?? input.maxHypotheses ?? 3;
      if (details.scores?.some((s: any) => s.signals?.includes("verification-plan"))) {
        state.hypothesesWithVerification++;
      }
    } else if (toolName === "finalize") {
      state.finalizes++;
      if (details.blocked) {
        state.finalizationsBlocked++;
      }
    } else if (toolName === "verify") {
      state.verifies++;
      if (details.passed) {
        state.verificationsPassed++;
      }
    }
  });
}
