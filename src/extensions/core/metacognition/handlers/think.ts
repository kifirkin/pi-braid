// ── Think Tool v2 ──────────────────────────────────────────────────────────────
// Records structured thinking with chain tracking, calibration feedback, and depth budgets.
// Uses the session model (ctx.model) directly — no separate utility model.

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callLlm } from "../../../../lib/ai/llm-call.js";
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

// ── Complexity Estimation (ODAR — Optimal Depth Allocation Routing) ──────────────────
// Estimates task complexity (0-1) from task description for Fast/Slow routing.
// Heuristic: keyword counting + length threshold. Not a learned routing algorithm.
// References: docs/research/braid-loop-research.md (Improvement 3: Fast/Slow System Routing)
//
// Complexity signals:
//   + High: long text (>300 chars), technical terms, multi-step keywords
//   + Medium: some technical terms, moderate length
//   + Low: short, imperative, simple keywords
//
// Research finding: ODAR saves 30-60% tokens on simple tasks by routing to fast system.
// For pi-braid: "fast" = quick depth (minimal reasoning), "slow" = deep (full analysis).

const COMPLEXITY_KEYWORDS = {
  high: [
    /\b(architectur|design\s+pattern|algorithm|optimize|refactor|benchmark|security|concurren|async|parallel|middleware|plugin|extension)\b/i,
    /\b(integrat|deploy|docker|kubernetes|ci\/|cd\/|pipeline|auth|oauth|jwt|encrypt)\b/i,
    /\b(migrate|upgrade|deprecat|legacy|monolith|microservice|api\s+design)\b/i,
    /\b(database|schema|migration|transaction|index|query\s+optim|partition)\b/i,
  ],
  medium: [
    /\b(function|class|interface|type\s+alias|module|import|export|async|await)\b/i,
    /\b(error|exception|handler|middleware|callback|promise|observable)\b/i,
    /\b(test|spec|assert|mock|stub|coverage|debug|profil)\b/i,
    /\b(config|environment|variable|setup|install|configure|build|compile)\b/i,
  ],
};

/**
 * Estimate complexity score (0-1) from a task description.
 * 0-0.3: simple (quick depth)
 * 0.3-0.7: medium (standard depth)
 * 0.7-1.0: complex (deep depth)
 */
export function estimateComplexity(taskText: string): number {
  if (!taskText || taskText.length < 10) return 0.1;

  let score = 0.3; // baseline for any non-trivial task

  // Length signal: longer = more complex
  const len = taskText.length;
  if (len > 500) score += 0.2;
  else if (len > 300) score += 0.15;
  else if (len > 150) score += 0.1;
  else if (len < 50) score -= 0.15;

  // High complexity keywords
  for (const re of COMPLEXITY_KEYWORDS.high) {
    if (re.test(taskText)) {
      score += 0.2;
      break;
    }
  }

  // Medium complexity keywords
  let mediumHits = 0;
  for (const re of COMPLEXITY_KEYWORDS.medium) {
    if (re.test(taskText)) mediumHits++;
  }
  score += Math.min(mediumHits * 0.05, 0.15);

  // Multi-step indicators (numbered lists, "first/then/finally")
  const stepIndicators =
    (taskText.match(/\d+\.\s+\w+/g) ?? []).length +
    (taskText.match(/\b(first|then|next|finally|after|before)\b/gi) ?? []).length;
  if (stepIndicators > 3) score += 0.15;
  else if (stepIndicators > 1) score += 0.08;

  // Question marks (uncertainty → possibly complex)
  const questions = (taskText.match(/\?/g) ?? []).length;
  if (questions > 2) score += 0.05;

  // Clamp to [0.05, 0.98]
  return Math.max(0.05, Math.min(0.98, score));
}

/**
 * Map complexity score to ODAR depth level.
 */
export function complexityToDepth(score: number): "quick" | "standard" | "deep" {
  if (score >= 0.7) return "deep";
  if (score >= 0.3) return "standard";
  return "quick";
}

/**
 * Compute calibration error: |predicted confidence - actual outcome|
 * actual outcome = 1.0 for success, 0.0 for failure
 */
function computeCalibrationError(predicted: number, actual: "success" | "failure"): number {
  const actualValue = actual === "success" ? 1.0 : 0.0;
  return Math.abs(predicted - actualValue);
}

/**
 * Get calibration statistics for this session.
 */
function getCalibrationStats(state: ThoughtChainState): { error: number; n: number; bias: string } {
  if (state.calibrationSamples.length === 0) {
    return { error: 0, n: 0, bias: "no data" };
  }
  const avgError =
    state.calibrationSamples.reduce((s, c) => s + c.calibrationError, 0) /
    state.calibrationSamples.length;
  const avgPredicted =
    state.calibrationSamples.reduce((s, c) => s + c.predictedConfidence, 0) /
    state.calibrationSamples.length;
  const avgActual =
    state.calibrationSamples.reduce((s, c) => s + (c.actualOutcome === "success" ? 1 : 0), 0) /
    state.calibrationSamples.length;
  const bias =
    avgPredicted > avgActual + 0.05
      ? "overconfident"
      : avgPredicted < avgActual - 0.05
        ? "underconfident"
        : "calibrated";
  return { error: Math.round(avgError * 100) / 100, n: state.calibrationSamples.length, bias };
}

// ── Depth Budgets ─────────────────────────────────────────────────────────────

/** Per-step effort calibration: depth → (maxTokens, guidance) */
const DEPTH_BUDGETS: Record<string, { tokens: number; guidance: string }> = {
  minimal: { tokens: 128, guidance: "One-line summary only." },
  low: { tokens: 256, guidance: "Brief: 1-2 sentences." },
  quick: { tokens: 512, guidance: "Concise reasoning." },
  medium: { tokens: 1024, guidance: "Standard analysis." },
  high: { tokens: 2048, guidance: "Thorough analysis with alternatives." },
  max: { tokens: 4096, guidance: "Deep analysis with critique, alternatives, and failure modes." },
  deep: { tokens: 4096, guidance: "Deep analysis with critique, alternatives, and failure modes." },
};

function getBudget(depth: string) {
  return DEPTH_BUDGETS[depth] ?? DEPTH_BUDGETS.quick;
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
      description: "Type of thinking",
      enum: [
        "observation",
        "planning",
        "execution",
        "reflection",
        "conclusion",
        "debugging",
        "design",
      ],
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
      enum: ["minimal", "low", "medium", "high", "max", "quick", "deep"],
      description: "Analysis depth",
    }),
  ),
  complexity: Type.Optional(
    Type.Number({
      description:
        "Task complexity 0-1 (auto-estimated from observation if omitted). Used for ODAR Fast/Slow routing: 0-0.3=quick, 0.3-0.7=standard, 0.7+=deep.",
      minimum: 0,
      maximum: 1,
    }),
  ),
  auto_depth: Type.Optional(
    Type.Boolean({
      description:
        "Auto-select depth from complexity estimation (recommended when depth is not explicit). Default: false.",
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
    const outcomeBadge = t.outcome === "success" ? "✅" : t.outcome === "failure" ? "❌" : "⏳";
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
      `Confidence drop: ${Math.round(parent.confidence * 100)}% → ${Math.round(current.confidence * 100)}%`,
    );
  }
  return issues;
}

// ── Main Tool ────────────────────────────────────────────────────────────────

export function createThinkTool() {
  return {
    name: "think" as const,
    label: "Think",
    promptSnippet: "Record structured thinking with decision, observation, and reason",
    description:
      "Record structured reasoning before irreversible actions or complex multi-component decisions.",
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
      // ODAR Fast/Slow routing: complexity → depth
      let depth = params.depth ?? "quick";
      if (params.complexity !== undefined) {
        depth = complexityToDepth(params.complexity);
      } else if (params.auto_depth || (!params.depth && observation.length > 30)) {
        // Auto-estimate when: auto_depth=true, OR depth not provided AND task has substance
        const estimated = estimateComplexity(observation);
        depth = complexityToDepth(estimated);
        log.debug(
          `ODAR: auto depth ${depth} (complexity=${estimated.toFixed(2)}, len=${observation.length})`,
        );
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
          type: params.type ?? "insight",
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

      const lines: string[] = [
        `Thinking recorded (${params.type ?? "insight"}):`,
        `- Observed: ${observation}`,
        `- Decided: ${decision}`,
        reason ? `- Reason: ${reason}` : "",
        `- Depth: ${depth} (${budget.guidance})`,
        params.auto_depth || params.complexity !== undefined
          ? `- Routing: ODAR auto (${params.complexity !== undefined ? `complexity=${params.complexity}` : "auto-estimated"})`
          : "",
        `- ID: ${thoughtId}${params.parent_id ? `\n- Parent: ${params.parent_id}` : ""}`,
      ].filter(Boolean);

      if (useDeepReview && ctx?.model) {
        try {
          const prompt = FRESH_EYES_PROMPT.replace("{observation}", observation)
            .replace("{decision}", decision)
            .replace("{reason}", reason);

          const apiKey = await ctx.modelRegistry.getApiKeyForProvider(ctx.model.provider);
          const llmResult = await callLlm(
            ctx.model,
            apiKey,
            "You are a sharp, critical thinker who reviews the reasoning of other agents.",
            prompt,
            { maxTokens: budget.tokens, temperature: 0.4, signal },
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

      // Process Supervision: inject consistency check results
      if (consistencyIssues.length > 0) {
        lines.push("", "⚠️ Consistency check:");
        for (const issue of consistencyIssues) {
          lines.push(`  • ${issue.slice(0, 120)}`);
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
