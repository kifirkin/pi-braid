// ── Think Tool v2 ──────────────────────────────────────────────────────────────
// Records structured thinking with chain tracking, calibration feedback, and depth budgets.
// Uses the session model (ctx.model) directly - no separate utility model.

import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callLlm } from "../../../../lib/ai/llm-call.js";
import { resolveUtilityModel } from "../../../../lib/ai/model-resolver.js";
import {
  estimateComplexity,
  complexityToDepth,
  getBudget,
  getCalibrationStats,
  computeCalibrationError,
  THINK_TYPES,
  DEFAULT_THINK_TYPE,
  DEPTH_LEVELS,
} from "./think-budget.js";
import { criticGate } from "../../../../lib/ai/critic-gate.js";
import { getExtensionState } from "../../../../lib/state/extension-state.js";
import { createLogger } from "../../../../lib/core/logger.js";

const log = createLogger("metacognition");

// ── Session-Scoped State ──────────────────────────────────────────────────────

interface ThoughtChainState {
  thoughts: ThoughtRecord[];
  calibrationSamples: CalibrationSample[];
  lastFinalizeMs: number;
}

interface ThoughtRecord {
  id: string;
  parentId: string | null;
  type: string;
  observation: string;
  decision: string;
  reason: string;
  confidence: number | null;
  tags: string[];
  depth: string;
  tokensUsed: number;
  tokensBudget: number;
  outcome: "pending" | "success" | "failure";
  createdAt: number;
}

interface CalibrationSample {
  thoughtId: string;
  predictedConfidence: number;
  actualOutcome: "success" | "failure";
  calibrationError: number; // |predicted - actual|
  createdAt: number;
}

function getChainState(ctx: ExtensionContext): ThoughtChainState {
  return getExtensionState(ctx, "think-chain", () => ({
    thoughts: [],
    calibrationSamples: [],
    lastFinalizeMs: 0,
  }));
}

// ── Schema ───────────────────────────────────────────────────────────────────

const thinkSchema = Type.Object({
  thought_id: Type.Optional(
    Type.String({ description: "Unique identifier (auto-generated if omitted)" }),
  ),
  parent_id: Type.Optional(
    Type.String({ description: "Parent thought ID for threaded reasoning chains" }),
  ),
  type: Type.Optional(
    Type.String({
      description: `Type of thinking. One of: ${THINK_TYPES.join(", ")}. Defaults to "${DEFAULT_THINK_TYPE}" if omitted. Tags the entry for later filtering; does not change tool behavior.`,
      enum: [...THINK_TYPES],
    }),
  ),
  observation: Type.Optional(Type.String({ description: "What you observed or decided to do" })),
  decision: Type.String({ description: "What you decided to do" }),
  reason: Type.Optional(Type.String({ description: "Why this decision" })),
  confidence: Type.Optional(
    Type.Number({ description: "Confidence level 0-1", minimum: 0, maximum: 1 }),
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
  depth: Type.Optional(
    Type.String({
      enum: [...DEPTH_LEVELS],
      description:
        `Analysis depth. Allowed: minimal, low, quick, medium, high, max, deep. ` +
        `If omitted, defaults to "quick" or auto-routes via observation/complexity. ` +
        `When set explicitly, depth wins over complexity (the complexity value is then ignored and noted in the output).`,
    }),
  ),
  complexity: Type.Optional(
    Type.Number({
      description:
        `Task complexity 0-1, used for ODAR Fast/Slow routing: 0-0.3=quick, 0.3-0.7=medium, 0.7+=deep. ` +
        `Ignored when an explicit depth is set. Note: complexity itself is NOT auto-estimated -- only depth is (via the observation text) -- so passing complexity is the only way to drive routing without auto-estimation kicking in for long observations.`,
      minimum: 0,
      maximum: 1,
    }),
  ),
  auto_depth: Type.Optional(
    Type.Boolean({
      description:
        `Force auto-estimation of depth from the observation, even for short observations. ` +
        `Has no effect if either depth or complexity is already set. ` +
        `Note: long observations (> 30 chars) auto-estimate even without auto_depth=true -- there is a hidden default that routes them via ODAR. ` +
        `Set auto_depth=false and pass a short observation if you want the tool to use depth="quick" with no routing.`,
    }),
  ),
  ask_utility_model: Type.Optional(
    Type.Boolean({
      description: "Explicit opt-in to session-model review (fresh-eyes perspective)",
    }),
  ),
  alternatives: Type.Optional(
    Type.Array(Type.String(), { description: "Alternative approaches considered" }),
  ),
  on_failure: Type.Optional(
    Type.String({ enum: ["diagnose", "propose_fix"], description: "What to do on failure" }),
  ),
  outcome: Type.Optional(
    Type.String({
      enum: ["success", "failure", "pending"],
      description: "Task outcome for closed-loop learning",
    }),
  ),
  show_chain: Type.Optional(
    Type.Boolean({ description: "Include the reasoning chain summary in the response" }),
  ),
});

const FRESH_EYES_PROMPT = `You are a sharp, critical thinker who reviews the reasoning of other agents.

## Context
You are reviewing thinking from an agent working on a TypeScript/Node.js codebase (pi-braid agent framework).
Available tools include: think, hypothesize, read, write, edit, bash, grep, browser_*, memory_*, health_maintenance tools.

## Thinking Entry
- Observation: {observation}
- Decision: {decision}
- Reason: {reason}

## Critique
Provide a brief, honest critique:
1. Is the reasoning sound given the codebase context?
2. What assumptions might be wrong given the tools and patterns?
3. What could go wrong with this decision in practice?
4. Any better alternatives given what's been tried?

Keep it concise - 4-6 sentences max. Focus on what matters for a TypeScript codebase.`;

// ── Chain Summary ─────────────────────────────────────────────────────────────

function buildChainSummary(thoughts: ThoughtRecord[]): string {
  if (thoughts.length === 0) return "";

  // Build tree from parent links
  const byId = new Map<string, ThoughtRecord>();
  for (const t of thoughts) byId.set(t.id, t);

  const root = thoughts.filter((t) => !t.parentId);

  function render(t: ThoughtRecord, indent: string): string {
    const outcomeBadge = t.outcome === "success" ? "[ok]" : t.outcome === "failure" ? "[fail]" : "[wait]";
    const conf = t.confidence !== null ? ` [${Math.round(t.confidence * 100)}%]` : "";
    const budget = `${t.tokensUsed}/${t.tokensBudget} tokens`;
    const line = `${indent}${outcomeBadge} ${t.type}: ${t.decision.slice(0, 60)}${conf} (${budget})`;
    const children = thoughts.filter((c) => c.parentId === t.id);
    const childLines = children.map((c) => render(c, indent + "  "));
    return [line, ...childLines].join("\n");
  }

  const lines = root.map((t) => render(t, ""));
  return `**Reasoning chain (${thoughts.length} thoughts):**\n${lines.join("\n")}`;
}

// ── Process Supervision (Loop, Think, Generalize 2604.07822) ────────────────────
// Check logical consistency between consecutive reasoning steps.

/** Check if a reasoning step is consistent with its parent step. */
export function stepConsistencyCheck(
  current: ThoughtRecord,
  parent: ThoughtRecord | null,
): string[] {
  if (!parent) return [];
  const issues: string[] = [];
  const pl = parent.decision.toLowerCase();
  const cl = current.decision.toLowerCase();
  const contradictions = [
    ["but", "however", "although"],
    ["wrong", "correct"],
    ["fail", "succeed"],
    ["error", "working"],
    ["impossible", "possible"],
  ];
  for (const [neg, pos] of contradictions) {
    if ((pl.includes(neg) && cl.includes(pos)) || (pl.includes(pos) && cl.includes(neg))) {
      issues.push(
        `Contradiction: "${parent.decision.slice(0, 40)}" vs "${current.decision.slice(0, 40)}"`,
      );
    }
  }
  if (/\bbecause\b/i.test(cl) && !/\bbecause\b/i.test(pl)) {
    issues.push("Unsupported 'because': parent provides no causal link");
  }
  if (
    current.confidence !== null &&
    parent.confidence !== null &&
    parent.confidence > 0.7 &&
    current.confidence < 0.3
  ) {
    issues.push(
      `Confidence drop: ${Math.round(parent.confidence * 100)}% -> ${Math.round(current.confidence * 100)}%`,
    );
  }
  return issues;
}

// ── Main Tool ────────────────────────────────────────────────────────────────

export function createThinkTool(): ToolDefinition<any, any, any> {
  return {
    name: "think" as const,
    label: "Think",
    description:
      `Think deeply with structured reasoning before making any decisions. Required before editing, writing files, or making high-stakes changes.` +
      `Required: decision. Recommended: observation, reason, confidence 0-1. ` +
      `parent_id links a prior thought_id. Process supervision flags contradictions. ` +
      `depth sets the thinking budget. Use quick, medium, or deep -- for ODAR routing; minimal, low, high, or max -- for finer control. deep triggers fresh-eyes review. Explicit depth wins over complexity 0-1; long observations auto-route. ` +
      `type is a tag, with default insight. ` +
      `outcome, success or failure, feeds calibration when show_chain=true.`,
    promptSnippet:
      "Record structured thinking with decision, observation, reason, and optional parent_id/depth/complexity",
    parameters: thinkSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext | undefined,
    ) => {
      const observation = params.observation ?? params.decision ?? "";
      const decision = params.decision ?? "";
      const reason = params.reason ?? "";
      const thoughtId = params.thought_id ?? crypto.randomUUID();
      // Depth resolution precedence: explicit depth > complexity > auto > "quick"
      //
      // - Explicit depth: respects agent intent (no surprise override).
      // - Complexity:    agent-controlled value, mapped to a depth level.
      // - Auto:          estimate from observation. Also fires implicitly
      //                  for long observations (> 30 chars) without auto_depth.
      // - Quick:         default for trivial / unanalyzed entries.
      let depth: string;
      let routingNote = "";
      if (params.depth) {
        depth = params.depth;
        if (params.complexity !== undefined) {
          routingNote = ` (explicit depth wins over complexity=${params.complexity})`;
        }
      } else if (params.complexity !== undefined) {
        depth = complexityToDepth(params.complexity);
        routingNote = ` (routed via complexity=${params.complexity})`;
      } else if (params.auto_depth || observation.length > 30) {
        // Auto-estimate when: auto_depth=true, OR task has substance (>30 chars)
        const estimated = estimateComplexity(observation);
        depth = complexityToDepth(estimated);
        routingNote = ` (auto-estimated: complexity=${estimated.toFixed(2)}, len=${observation.length})`;
        log.debug(`ODAR: auto depth ${depth} (complexity=${estimated.toFixed(2)}, len=${observation.length})`);
      } else {
        depth = "quick";
      }
      const budget = getBudget(depth);
      const useDeepReview = params.ask_utility_model === true || depth === "deep";
      const confidence = params.confidence ?? null;
      const consistencyIssues: string[] = []; // Process Supervision (2604.07822)

      // Persist to session chain
      const tokensUsed = 0;
      if (ctx) {
        const chain = getChainState(ctx);
        const record: ThoughtRecord = {
          id: thoughtId,
          parentId: params.parent_id ?? null,
          type: params.type ?? DEFAULT_THINK_TYPE,
          observation,
          decision,
          reason,
          confidence,
          tags: params.tags ?? [],
          depth,
          tokensUsed: 0, // filled in after model call
          tokensBudget: budget.tokens,
          outcome: "pending",
          createdAt: Date.now(),
        };
        chain.thoughts.push(record);

        // Process Supervision: check consistency after pushing
        if (params.parent_id) {
          const parent = chain.thoughts.find((t) => t.id === params.parent_id);
          if (parent) {
            const issues = stepConsistencyCheck(record, parent);
            if (issues.length > 0) {
              log.debug(`Process supervision: ${issues.length} consistency issues`);
              consistencyIssues.push(...issues.slice(0, 3));
            }
          }
        }
      }

      const result: Record<string, unknown> = { thought_id: thoughtId };
      if (params.parent_id) result.parent_id = params.parent_id;
      if (params.type) result.type = params.type;
      if (confidence !== null) result.confidence = confidence;
      if (params.alternatives) result.alternatives = params.alternatives;
      result.outcome = "pending";

      const type = params.type ?? DEFAULT_THINK_TYPE;
      const lines: string[] = [
        `Thinking recorded (${type}):`,
        `- Observed: ${observation}`,
        `- Decided: ${decision}`,
        reason ? `- Reason: ${reason}` : "",
        `- Depth: ${depth} (${budget.guidance})${routingNote}`,
        `- ID: ${thoughtId}${params.parent_id ? `\n- Parent: ${params.parent_id}` : ""}`,
      ].filter(Boolean);

      if (useDeepReview && ctx?.model) {
        // Pre-check: does this decision warrant a deep review?
        const wantsReview = await criticGate(ctx, {
          name: "fresh-eyes-precheck",
          criteria: {
            systemPrompt:
              "You are a triage classifier for reasoning review. Determine if the given decision " +
              "is complex enough to warrant a 'fresh eyes' deep review. " +
              "Answer 'yes' if the decision involves trade-offs, uncertainty, or significant impact. " +
              "Answer 'no' for simple routine decisions (e.g., 'reading a file', 'trivial fix'). " +
              "Answer 'deep' if the decision crosses architectural boundaries or has high stakes. " +
              "Answer with exactly one word: 'yes', 'no', or 'deep'. Do not explain.",
            userPrompt: "Observation: {{observation}}\nDecision: {{decision}}\nReason: {{reason}}",
          },
          input: { observation, decision: decision || "(not stated)", reason: reason || "(not stated)" },
          fallback: () => {
            // Heuristic: decisions mentioning complexity keywords deserve review
            const keywords = ["refactor", "delete", "remove", "redesign", "migrate", "replace", "significant", "critical", "architecture", "breaking"];
            return keywords.some((kw) => (decision + " " + (reason || "")).toLowerCase().includes(kw)) ? "deep" : "yes";
          },
          timeoutMs: 60_000,
          // P2-11 B-class: keyword-list heuristic misses many decisions that
          // warrant review (any non-listed architectural decision gets "yes"
          // i.e. skipped). tierPolicy: fallback-only downweights to 0.5
          // confidence so the Tier 2 LLM has the final say.
          tierPolicy: "fallback-only",
          modelPreference: "quality",
        });

        if (!wantsReview.shouldProceed) {
          lines.push("", `[_Fresh eyes skipped: ${wantsReview.message}_]`);
        } else {
          try {
            const prompt = FRESH_EYES_PROMPT.replace("{observation}", observation)
              .replace("{decision}", decision)
              .replace("{reason}", reason);

            // Prefer utility model (cheaper for review), fall back to session model
            const utilityModel = resolveUtilityModel(ctx);
            const reviewModel = utilityModel ?? ctx.model;
            const apiKey = await ctx.modelRegistry.getApiKeyForProvider(reviewModel.provider);
            const llmResult = await callLlm(
              reviewModel,
              apiKey,
              "You are a sharp, critical thinker who reviews the reasoning of other agents.",
              prompt,
              {
                maxTokens: wantsReview.suggestedDepth === "deep" ? Math.min(budget.tokens * 2, 2000) : budget.tokens,
                temperature: 0.4,
                // The think tool is fundamentally about reasoning
                // - reviewing another agent's reasoning requires
                // extended thinking. Use "high" so the model can
                // allocate a substantial thinking budget before
                // producing the review. pi-ai's clampThinkingLevel
                // gracefully maps "high" to whatever the model
                // supports (most reasoning models do).
                reasoning: "high",
                signal,
              },
            );

            let reviewText = "";
            if (!("error" in llmResult)) {
              reviewText = llmResult.text;
            }

            // Track tokens used
            if (ctx) {
              const chain = getChainState(ctx);
              const record = chain.thoughts.find((t) => t.id === thoughtId);
              if (record) record.tokensUsed = tokensUsed;
            }

            if (reviewText) {
              lines.push("", "---");
              lines.push("**Fresh Eyes (session model):**", reviewText);
              result.modelUsed = ctx!.model.id;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            lines.push("", `[_Session model review error: ${message}_]`);
            result.modelError = message;
          }
        }
      }
      // Process Supervision: inject consistency check results
      if (consistencyIssues.length > 0) {
        lines.push("", "[warn] Consistency check:");
        for (const issue of consistencyIssues) {
          lines.push(`  * ${issue.slice(0, 120)}`);
        }
      }

      // Show chain summary if requested
      if (params.show_chain && ctx) {
        const chain = getChainState(ctx);
        const recentThoughts = chain.thoughts.slice(-10);
        const chainSummary = buildChainSummary(recentThoughts);
        if (chainSummary) {
          lines.push("", "---");
          lines.push(chainSummary);
          const stats = getCalibrationStats(chain);
          lines.push(`\n*Calibration: ${stats.bias} (${stats.error} avg error, n=${stats.n})*`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { observation, decision, reason, consistencyIssues, ...result },
      };
    },
  };
}

// ── Calibration API (called by finalize) ──────────────────────────────────────

/**
 * Record calibration data after a task outcome is known.
 * Called from finalize with the predicted confidence of the last thought
 * and the actual outcome.
 */
export function recordCalibration(
  ctx: ExtensionContext,
  predictedConfidence: number,
  actualOutcome: "success" | "failure",
): void {
  const chain = getChainState(ctx);
  const lastThought = chain.thoughts[chain.thoughts.length - 1];
  if (lastThought) {
    lastThought.outcome = actualOutcome;
    // Update the predicted confidence if it wasn't set
    if (lastThought.confidence === null) {
      lastThought.confidence = predictedConfidence;
    }
  }

  const sample: CalibrationSample = {
    thoughtId: lastThought?.id ?? "unknown",
    predictedConfidence,
    actualOutcome,
    calibrationError: computeCalibrationError(predictedConfidence, actualOutcome),
    createdAt: Date.now(),
  };
  chain.calibrationSamples.push(sample);
  chain.lastFinalizeMs = Date.now();

  // Keep calibration samples bounded (last 50)
  if (chain.calibrationSamples.length > 50) {
    chain.calibrationSamples = chain.calibrationSamples.slice(-50);
  }

  log.info(
    `Calibration: predicted=${predictedConfidence.toFixed(2)} actual=${actualOutcome} error=${sample.calibrationError.toFixed(2)} bias=${getCalibrationStats(chain).bias}`,
  );
}
