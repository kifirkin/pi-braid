// Generate structured hypotheses about root causes using the session model.

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveUtilityModel, tryModelChain } from "../../../../lib/ai/model-resolver.js";
import type { LlmCallOptions } from "../../../../lib/ai/llm-call.js";
import { criticGate } from "../../../../lib/ai/critic-gate.js";
import { classify } from "../../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../../lib/ai/critic-registry.js";
import { scoreHypothesisOutput } from "./scoring.js";

import { withMeta } from "../../../../lib/types/standard-result.js";
import { createLogger } from "../../../../lib/core/logger.js";

const log = createLogger("hypothesize");

/**
 * P2-11 B-class: preserve the 4 regex dimension checks as the Tier 1 fallback
 * for hypothesis signal detection. The LLM path enhances when the heuristic
 * returns "none" or when the agent needs richer signal analysis.
 */
function hypothesisSignalFallback(text: string): string {
  const signals: string[] = [];
  if (/verify|check|test|confirm|reproduce/i.test(text)) signals.push("verification-plan");
  if (/because|caused by|due to|root cause|underlying/i.test(text))
    signals.push("causal-reasoning");
  if (/proper|maintainable|clean|refactor|fix.*properly/i.test(text))
    signals.push("proper-solution");
  if (/edge case|boundary|corner case|failure mode/i.test(text)) signals.push("edge-case-aware");
  return signals.length > 0 ? signals.join(", ") : "none";
}

/**
 * Empty-response retry decision (pure, unit-testable without model
 * plumbing): given the final error text of a tryModelChain attempt,
 * return the options for a single mechanical regeneration retry — or
 * null when the error is not empty-class (rate limits, aborts, auth
 * failures already exhausted the provider-side retry ladder in
 * llm-call and must not be re-driven here).
 *
 * reasoning: "off" — per llm-call.ts docs, reasoning tokens count
 * against max_tokens for most providers, so a reasoning-enabled call
 * can burn its entire budget thinking and produce 0 output tokens (the
 * empty-string symptom). pi-ai's clampThinkingLevel accepts "off" at
 * runtime and clamps per model, so "off" is safe for every provider.
 */
export function emptyResponseRetryOptions(lastError: string): LlmCallOptions | null {
  if (!/empty response/i.test(lastError ?? "")) return null;
  return { temperature: 0.3, maxTokens: 4000, reasoning: "off" };
}

const FORMAT_OPTIONS = ["ranked", "tree", "list"] as const;

const hypothesizeSchema = Type.Object({
  problem: Type.String({ description: "The problem or issue to generate hypotheses about" }),
  evidence: Type.String({ description: "Relevant evidence, error messages, or observations" }),
  maxHypotheses: Type.Optional(
    Type.Number({ description: "Maximum number of hypotheses to generate (default: 3)" }),
  ),
  format: Type.Optional(
    StringEnum([...FORMAT_OPTIONS], {
      description: "Output format: ranked (default), tree (causal chain), or list",
    }),
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
      "Use indentation: Level-A causes -> Level-B causes -> Level-C hypotheses. " +
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
You aim for proper, well-designed solutions - not quick patches or workarounds.${verificationSection}`;
}

export function createHypothesizeTool(): ToolDefinition<any, any, any> {
  return {
    name: "hypothesize" as const,
    label: "Hypothesize",
    promptSnippet: "Generate hypotheses about root causes of a problem",
    description:
      "Generate root-cause hypotheses when a first fix attempt fails, using fresh-eyes debugging analysis.",
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

      // Pre-check: is this problem worth deep analysis?
      const gate = await criticGate(ctx, {
        name: "hypothesis-precheck",
        criteria: {
          systemPrompt:
            "You are a triage classifier. Determine if the given problem has enough " +
            "specific evidence for meaningful root-cause hypothesis generation. " +
            "Answer 'yes' if there is concrete evidence (error messages, code diffs, " +
            "stack traces, specific observations). Answer 'no' if the problem is vague, " +
            "has no evidence, or is purely speculative. Answer 'deep' if the evidence " +
            "is detailed enough to warrant multi-hypothesis analysis. " +
            "Answer with exactly one word: 'yes', 'no', or 'deep'. Do not explain.",
          userPrompt: "Problem: {{problem}}\nEvidence: {{evidence}}",
        },
        input: { problem, evidence: evidence || "(none provided)" },
        fallback: () => (problem.length > 50 && (evidence?.length ?? 0) > 30 ? "deep" : "yes"),
        timeoutMs: 60_000,
        // P2-11 B-class: length-based heuristic is a poor proxy for
        // "needs deep analysis" (a short problem with rich evidence can
        // need deep; a long problem with no evidence doesn't).
        // tierPolicy: fallback-only downweights to 0.5 confidence so
        // the Tier 2 LLM has the final say.
        tierPolicy: "fallback-only",
        modelPreference: "quality",
      });

      if (!gate.shouldProceed) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `[?] **Problem**: ${problem.slice(0, 200)}${problem.length > 200 ? "..." : ""}\n\n` +
                (evidence
                  ? `**Evidence**: ${evidence.slice(0, 200)}${evidence.length > 200 ? "..." : ""}\n\n`
                  : "") +
                `**Gate decision**: ${gate.message}\n\n` +
                `**Hypothesis generation skipped** - the input lacks sufficient specific evidence for meaningful root-cause analysis. ` +
                `Provide concrete evidence (error messages, code diffs, test failures) for better results.`,
            },
          ],
          details: { problem, evidence: evidence ?? "", skipped: true, reason: gate.message },
        };
      }

      // Proceed with generative LLM call (normal or deep depth)
      try {
        const prompt = buildPrompt({
          problem,
          evidence,
          maxHypotheses:
            gate.suggestedDepth === "deep" ? Math.max(maxHypotheses, 5) : maxHypotheses,
          format,
          verificationPlan,
        });

        // Try the merged role first (accuracy-critical), then the session
        // model. maxTokens 4000 + reasoning "low": reasoning tokens count
        // against max_tokens for most providers (see llm-call.ts), so default
        // reasoning can consume the whole budget thinking and return empty
        // text — the owner-visible "Empty response from model" failure.
        // The resolver list is shared so the empty-class retry below runs
        // the identical chain.
        const resolvers = [() => resolveUtilityModel(ctx), () => ctx.model];
        let llmResult = await tryModelChain(
          ctx,
          resolvers,
          "You are an expert debugging assistant that analyzes problems and generates testable hypotheses.",
          prompt,
          { temperature: 0.3, signal, maxTokens: 4000, reasoning: "low" },
        );

        if ("error" in llmResult) {
          // Live failure path: tryModelChain never returns empty text as
          // success — on empty/error from every resolver it returns
          // { error }. Empty-class errors (reasoning consumed the token
          // budget) get ONE mechanical regeneration retry with reasoning
          // off. Attempt-number logging only — no error dumps.
          const retryOptions = emptyResponseRetryOptions(llmResult.error);
          if (retryOptions) {
            log.debug(
              "hypothesize: attempt 1 hit the empty-response class, retrying with reasoning off (attempt 2)",
            );
            llmResult = await tryModelChain(
              ctx,
              resolvers,
              "You are an expert debugging assistant that analyzes problems and generates testable hypotheses.",
              prompt,
              { ...retryOptions, signal },
            );
          }
        }

        if ("error" in llmResult) {
          // Graceful degradation: all models in chain failed (including the
          // empty-class retry when one ran). The fallback carries the FINAL
          // error text so the owner sees the true last state.
          log.debug(`hypothesize: all models failed: ${llmResult.error}`);
          return withMeta(
            {
              content: [
                {
                  type: "text" as const,
                  text:
                    `## Hypothesis Generation Unavailable\n\n` +
                    `All available models failed to generate hypotheses for this problem.\n` +
                    `**Error:** ${llmResult.error}\n\n` +
                    `Try again later, or provide more specific evidence to narrow the search space.`,
                },
              ],
              details: {
                problem,
                evidence: evidence ?? "",
                skipped: true,
                reason: llmResult.error,
              },
            },
            { confidence: 0, alternativesConsidered: 0 },
          );
        }

        const text = llmResult.text.trim();

        if (!text) {
          // Graceful degradation: model returned empty text.
          // This is a transient model issue (overload, content rejection, timeout).
          // Return a fallback instead of crashing the tool.
          log.debug(`hypothesize: model returned empty text (model=${ctx.model.id})`);
          return withMeta(
            {
              content: [
                {
                  type: "text" as const,
                  text:
                    `## Hypothesis Generation Returned Empty\n\n` +
                    `The model (${ctx.model.id}) returned an empty response. ` +
                    `This is usually a transient issue (model overload, content policy, or timeout).\n\n` +
                    `**Suggestions:**\n` +
                    `1. Try again — the model may be recovering from a transient error\n` +
                    `2. Narrow the problem statement to reduce token count\n` +
                    `3. Use \`think()\` to manually reason about root causes`,
                },
              ],
              details: {
                problem,
                evidence: evidence ?? "",
                skipped: true,
                reason: "empty_response",
              },
            },
            { confidence: 0, alternativesConsidered: 0 },
          );
        }

        // Score hypotheses with heuristic signals + evidence pool
        const { scored, annotated } = scoreHypothesisOutput(text, evidence, ctx ?? undefined);

        // P2-11 B-class: enhance signal detection with LLM when heuristic fails
        // (tierPolicy: fallback-only means the heuristic fires first with 0.5 confidence,
        // and the LLM path covers edge cases the regexes miss).
        try {
          const signalResult = await classify(
            ctx,
            CRITICS.hypothesisSignals.criteria,
            { hypothesisText: text },
            {
              label: CRITICS.hypothesisSignals.label,
              fallback: () => hypothesisSignalFallback(text),
              tierPolicy: "fallback-only",
            },
          );
          if (signalResult.label && signalResult.label !== "none") {
            const llmSignals = signalResult.label.split(",").map((s: string) => s.trim());
            for (const s of scored) {
              for (const ls of llmSignals) {
                if (!s.signals.includes(ls)) {
                  s.signals.push(ls);
                }
              }
            }
          }
        } catch {
          // Swallow: signal enhancement is best-effort, heuristic results are sufficient
        }

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
            suggestedNextTool: scored.some((s) => s.evidenceMatches.length)
              ? "explore_paths"
              : undefined,
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`hypothesize: model analysis failed - ${message}`, { cause: err });
      }
    },
  };
}
