// ── Hypothesize Tool ──────────────────────────────────────────────────────────
// Generate structured hypotheses about root causes using the session model.

import { Type } from "typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { scoreHypothesisOutput } from "./scoring.js";
import { createLogger } from "../../../../lib/logger.js";

const log = createLogger("metacognition");

const hypothesizeSchema = Type.Object({
  problem: Type.String({ description: "The problem or issue to generate hypotheses about" }),
  evidence: Type.String({ description: "Relevant evidence, error messages, or observations" }),
  maxHypotheses: Type.Optional(
    Type.Number({ description: "Maximum number of hypotheses to generate (default: 3)" }),
  ),
});

const HYPOTHESIS_PROMPT = `Analyze this problem and generate {maxHypotheses} testable hypotheses about the root cause.

Problem: {problem}

Evidence:
{evidence}

For each hypothesis:
1. State the hypothesis clearly
2. Explain WHY this could be the root cause (mechanism, not correlation)
3. What evidence would CONFIRM this hypothesis?
4. What evidence would DISPROVE this hypothesis?
5. How to fix it (proper solution, not a workaround)

Rank hypotheses by likelihood (most likely first).
You aim for proper, well-designed solutions — not quick patches or workarounds.`;

export function createHypothesizeTool() {
  return {
    name: "hypothesize" as const,
    label: "Hypothesize",
    promptSnippet: "Generate hypotheses about root causes of a problem",
    description:
      "Generate hypotheses about root causes before selecting a fix. Call this when debugging — a first attempt at fixing something fails. Generates multiple ranked hypotheses using the session model for fresh-eyes analysis.",
    parameters: hypothesizeSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext | undefined,
    ) => {
      const { problem, evidence, maxHypotheses = 3 } = params;

      if (!ctx?.model) {
        throw new Error(
          `hypothesize: no model available for session model analysis. ` +
            `Problem: "${problem.slice(0, 50)}..." | Evidence: "${evidence.slice(0, 50)}..."`,
        );
      }

      try {
        const prompt = HYPOTHESIS_PROMPT.replace("{problem}", problem)
          .replace("{evidence}", evidence)
          .replace("{maxHypotheses}", String(maxHypotheses));

        const response = await complete(
          ctx.model,
          {
            systemPrompt:
              "You are an expert debugging assistant that analyzes problems and generates testable hypotheses.",
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: prompt }],
                timestamp: Date.now(),
              },
            ],
          },
          { maxTokens: 2048, temperature: 0.3 },
        ) as any;

        // Extract text from AssistantMessage (response is an object with .content,
        // NOT an array or raw string). Same pattern as user-message-preprocessor.
        const content = Array.isArray(response?.content)
          ? response.content
          : typeof response?.content === "string"
            ? [{ type: "text" as const, text: response.content }]
            : [];
        const textBlocks = content.filter(
          (c: any): c is { type: "text"; text: string } => c.type === "text",
        );
        const text = textBlocks.length > 0 ? textBlocks[0].text.trim() : "";

        if (!text) {
          throw new Error(
            `hypothesize: session model returned empty response. ` +
              `Model: "${ctx.model.id}". ` +
              `The model may be unavailable or the prompt was rejected. ` +
              `Try again with a more specific problem statement.`,
          );
        }

        // Score hypotheses with heuristic signals + evidence pool
        const { scored, annotated } = scoreHypothesisOutput(
          text,
          evidence,
          ctx ?? undefined,
        );

        return {
          content: [{ type: "text" as const, text: annotated }],
          details: {
            problem,
            hypotheses: maxHypotheses,
            modelUsed: ctx.model.id,
            scores: scored.map((s) => ({
              rank: s.index,
              title: s.title,
              score: s.score,
              signals: s.signals,
            })),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`hypothesize: model analysis failed — ${message}`);
      }
    },
  };
}
