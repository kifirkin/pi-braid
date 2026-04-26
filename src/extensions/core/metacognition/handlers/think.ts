// ── Think Tool v2 ──────────────────────────────────────────────────────────────
// Records structured thinking with chain tracking, calibration feedback, and depth budgets.
// Uses the session model (ctx.model) directly — no separate utility model.

import { Type } from "typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { getExtensionState } from "../../../../lib/extension-state.js";
import { createLogger } from "../../../../lib/logger.js";

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

// ── Calibration ────────────────────────────────────────────────────────────────

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
	const avgError = state.calibrationSamples.reduce((s, c) => s + c.calibrationError, 0) / state.calibrationSamples.length;
	const avgPredicted = state.calibrationSamples.reduce((s, c) => s + c.predictedConfidence, 0) / state.calibrationSamples.length;
	const avgActual = state.calibrationSamples.reduce((s, c) => s + (c.actualOutcome === "success" ? 1 : 0), 0) / state.calibrationSamples.length;
	const bias = avgPredicted > avgActual + 0.05 ? "overconfident" : avgPredicted < avgActual - 0.05 ? "underconfident" : "calibrated";
	return { error: Math.round(avgError * 100) / 100, n: state.calibrationSamples.length, bias };
}

// ── Depth Budgets ─────────────────────────────────────────────────────────────

/** Per-step effort calibration: depth → (maxTokens, guidance) */
const DEPTH_BUDGETS: Record<string, { tokens: number; guidance: string }> = {
	minimal: { tokens: 128, guidance: "One-line summary only." },
	low:     { tokens: 256, guidance: "Brief: 1-2 sentences." },
	quick:   { tokens: 512, guidance: "Concise reasoning." },
	medium:  { tokens: 1024, guidance: "Standard analysis." },
	high:    { tokens: 2048, guidance: "Thorough analysis with alternatives." },
	max:     { tokens: 4096, guidance: "Deep analysis with critique, alternatives, and failure modes." },
	deep:    { tokens: 4096, guidance: "Deep analysis with critique, alternatives, and failure modes." },
};

function getBudget(depth: string) {
	return DEPTH_BUDGETS[depth] ?? DEPTH_BUDGETS.quick;
}

// ── Schema ───────────────────────────────────────────────────────────────────

const thinkSchema = Type.Object({
	thought_id:      Type.Optional(Type.String({ description: "Unique identifier (auto-generated if omitted)" })),
	parent_id:       Type.Optional(Type.String({ description: "Parent thought ID for threaded reasoning chains" })),
	type:            Type.Optional(Type.String({ description: "Type of thinking", enum: ["observation", "planning", "execution", "reflection", "conclusion", "debugging", "design"] })),
	observation:     Type.Optional(Type.String({ description: "What you observed or decided to do" })),
	decision:        Type.String({ description: "What you decided to do" }),
	reason:          Type.Optional(Type.String({ description: "Why this decision" })),
	confidence:      Type.Optional(Type.Number({ description: "Confidence level 0-1", minimum: 0, maximum: 1 })),
	tags:            Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
	depth:           Type.Optional(Type.String({ enum: ["minimal", "low", "medium", "high", "max", "quick", "deep"], description: "Analysis depth" })),
	ask_utility_model: Type.Optional(Type.Boolean({ description: "Explicit opt-in to session-model review (fresh-eyes perspective)" })),
	alternatives:    Type.Optional(Type.Array(Type.String(), { description: "Alternative approaches considered" })),
	on_failure:      Type.Optional(Type.String({ enum: ["diagnose", "propose_fix"], description: "What to do on failure" })),
	outcome:         Type.Optional(Type.String({ enum: ["success", "failure", "pending"], description: "Task outcome for closed-loop learning" })),
	show_chain:      Type.Optional(Type.Boolean({ description: "Include the reasoning chain summary in the response" })),
});

const FRESH_EYES_PROMPT = `You are a sharp, critical thinker who reviews the reasoning of other agents.

## Context
You are reviewing thinking from an agent working on a TypeScript/Node.js codebase (pi-braid agent framework).
Available tools include: think, hypothesize, read, write, edit, bash, grep, browser_*, memory_*, evolve tools.

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

// ── Main Tool ────────────────────────────────────────────────────────────────

export function createThinkTool() {
	return {
		name: "think" as const,
		label: "Think",
		description:
			"Record structured thinking: decision (required), observation and reason (optional). Use depth='deep' or ask_utility_model=true to also invoke the session model for a fresh-eyes perspective.",
		parameters: thinkSchema,
		execute: async (_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext | undefined) => {
			const observation  = params.observation ?? params.decision ?? "";
			const decision     = params.decision ?? "";
			const reason      = params.reason ?? "";
			const thoughtId    = params.thought_id ?? crypto.randomUUID();
			const depth       = params.depth ?? "quick";
			const budget      = getBudget(depth);
			const useDeepReview = params.ask_utility_model === true || depth === "deep";
			const confidence  = params.confidence ?? null;

			// Persist to session chain
			let tokensUsed = 0;
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
			}

			const result: Record<string, unknown> = { thought_id: thoughtId };
			if (params.parent_id)     result.parent_id     = params.parent_id;
			if (params.type)          result.type          = params.type;
			if (confidence !== null)  result.confidence    = confidence;
			if (params.alternatives)  result.alternatives  = params.alternatives;
			result.outcome = "pending";

			const lines: string[] = [
				`Thinking recorded (${params.type ?? "insight"}):`,
				`- Observed: ${observation}`,
				`- Decided: ${decision}`,
				reason ? `- Reason: ${reason}` : "",
				`- Depth: ${depth} (${budget.guidance})`,
				`- ID: ${thoughtId}${params.parent_id ? `\n- Parent: ${params.parent_id}` : ""}`,
			].filter(Boolean);

			if (useDeepReview && ctx?.model) {
				try {
					const prompt = FRESH_EYES_PROMPT
						.replace("{observation}", observation)
						.replace("{decision}", decision)
						.replace("{reason}", reason);

					const response = await complete(
						ctx.model,
						{
							systemPrompt: "You are a sharp, critical thinker who reviews the reasoning of other agents.",
							messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }],
						},
						{ maxTokens: budget.tokens, temperature: 0.4 },
					);

					const reviewText = Array.isArray(response)
						? response.map((r) => (r as { text?: string }).text || "").join("\n")
						: typeof response === "string"
							? response
							: "";

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
				details: { observation, decision, reason, ...result },
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

	log.info(`Calibration: predicted=${predictedConfidence.toFixed(2)} actual=${actualOutcome} error=${sample.calibrationError.toFixed(2)} bias=${getCalibrationStats(chain).bias}`);
}
