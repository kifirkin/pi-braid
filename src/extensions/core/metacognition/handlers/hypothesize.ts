// ── Hypothesize Tool ──────────────────────────────────────────────────────────
// Generate structured hypotheses about root causes using the session model.

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callLlm } from "../../../../lib/ai/llm-call.js";
import { scoreHypothesisOutput } from "./scoring.js";
import { createLogger } from "../../../../lib/core/logger.js";
import { withMeta } from "../../../../lib/types/standard-result.js";

const log = createLogger("metacognition");

const FORMAT_OPTIONS = ["ranked", "tree", "list"] as const;

const hypothesizeSchema = Type.Object({
  problem: Type.String({ description: "The problem or issue to generate hypotheses about" }),
  evidence: Type.String({ description: "Relevant evidence, error messages, or observations" }),
  maxHypotheses: Type.Optional(
    Type.Number({ description: "Maximum number of hypotheses to generate (default: 3)" }),
  ),
  format: Type.Optional(
    StringEnum([...FORMAT_OPTIONS], { description: "Output format: ranked (default), tree (causal chain), or list (flat enumeration)" }),
  ),
  verificationPlan: Type.Optional(
    Type.String({ description: "Specific action plan for verifying which hypothesis is correct" }),
  ),
});

function buildPrompt(params: {
  problem: string;
  evidence: string;
  maxHypotheses: number;
  format: string;
  verificationPlan?: string;
}): string {
  const formatInstructions: Record<string, string> = {
    ranked:
      "Rank hypotheses by likelihood (most likely first). Use numbered headings (Hypothesis 1, Hypothesis 2, etc.).",
    tree:
      "Present hypotheses as a causal tree showing root cause relationships. " +
      "Use indentation: Level-A causes → Level-B causes → Level-C hypotheses. " +
      "Label each node with its causal chain.",
    list:
      "Present hypotheses as a flat numbered list. Each hypothesis is independent. " +
      "Use bullet points under each for details.",
  };

  const formatLine = formatInstructions[params.format] ?? formatInstructions.ranked;

  const verificationSection = params.verificationPlan
    ? `

## Verification Plan

The following plan should be followed to verify which hypothesis is correct:
${params.verificationPlan}

For each hypothesis above, explicitly state whether the verification plan confirms or rules it out.`
    : "";

  return `Analyze this problem and generate ${params.maxHypotheses} testable hypotheses about the root cause.

Problem: ${params.problem}

Evidence:
${params.evidence}

For each hypothesis:
1. State the hypothesis clearly
2. Explain WHY this could be the root cause (mechanism, not correlation)
3. What evidence would CONFIRM this hypothesis?
4. What evidence would DISPROVE this hypothesis?
5. How to fix it (proper solution, not a workaround)

${formatLine}
You aim for proper, well-designed solutions — not quick patches or workarounds.${verificationSection}`;
}

export function createHypothesizeTool(): ToolDefinition<any, any, any> {
  return {
    name: "hypothesize" as const,
    label: "Hypothesize",
    promptSnippet: "Generate hypotheses about root causes of a problem",
    description:
      "Generate root cause hypotheses when debugging after a first fix attempt fails, using the session model for fresh-eyes analysis.",
    parameters: hypothesizeSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext | undefined,
    ) => {
      const { problem, evidence, maxHypotheses = 3, format = "ranked", verificationPlan } = params;

      if (!ctx?.model) {
        throw new Error(
          `hypothesize: no model available for session model analysis. ` +
            `Problem: "${problem.slice(0, 50)}..." | Evidence: "${evidence.slice(0, 50)}..."`,
        );
      }

      try {
        const prompt = buildPrompt({ problem, evidence, maxHypotheses, format, verificationPlan });

        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(ctx.model.provider);
        const llmResult = await callLlm(
          ctx.model,
          apiKey,
          "You are an expert debugging assistant that analyzes problems and generates testable hypotheses.",
          prompt,
          { maxTokens: 2048, temperature: 0.3, signal },
        );

        if ("error" in llmResult) {
          throw new Error(`hypothesize: session model error: ${llmResult.error}`);
        }

        const text = llmResult.text.trim();

        if (!text) {
          throw new Error(
            `hypothesize: session model returned empty response. ` +
              `Model: "${ctx.model.id}". ` +
              `The model may be unavailable or the prompt was rejected. ` +
              `Try again with a more specific problem statement.`,
          );
        }

        // Score hypotheses with heuristic signals + evidence pool
        const { scored, annotated } = scoreHypothesisOutput(text, evidence, ctx ?? undefined);

        return withMeta(
          {
            content: [{ type: "text" as const, text: annotated }],
            details: {
              problem,
              hypotheses: maxHypotheses,
              format,
              verificationPlan: verificationPlan ?? null,
              modelUsed: ctx.model.id,
              scores: scored.map((s) => ({
                rank: s.index,
                title: s.title,
                score: s.score,
                signals: s.signals,
                evidenceMatches: s.evidenceMatches.map((m) => ({
                  claim: m.claim.slice(0, 200),
                  source: m.source,
                  overlap: m.overlap,
                })),
                evidenceFor: s.evidenceFor ?? [],
                evidenceAgainst: s.evidenceAgainst ?? [],
              })),
            },
          },
          {
            confidence: Math.max(...scored.map((s) => s.score), 0.5),
            alternativesConsidered: scored.length,
            suggestedNextTool:
              scored.some((s) => s.evidenceMatches.length) ? "explore_paths" : undefined,
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`hypothesize: model analysis failed — ${message}`, { cause: err });
      }
    },
  };
}
