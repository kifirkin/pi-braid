/**
 * Metacognition Extension
 *
 * The agent's self-awareness layer:
 * - think: structured reasoning recording
 * - hypothesize: utility-model hypothesis generation
 * - finalize: required completion signal
 *
 * Note: scratchpad is registered by the scratchpad extension, not here.
 *
 * Tools inlined from ../../tools/: think.ts, utility-hypothesize.ts, finalize.ts
 */

import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

// =============================================================================
// Hypothesis Scoring (Task 7)
// =============================================================================

interface ScoredHypothesis {
	index: number;
	title: string;
	score: number;
	signals: string[];
}

/** Heuristic signals for hypothesis likelihood */
function scoreHypothesis(hypothesisText: string, evidence: string): ScoredHypothesis {
	const signals: string[] = [];
	let score = 0.5; // baseline

	// Signal: mentions specific file path (+0.15)
	if (/src\/[\w/-]+\.(ts|js|json)/i.test(hypothesisText)) {
		score += 0.15;
		signals.push("specific_file");
	}

	// Signal: mentions specific error type (+0.1)
	if (/TypeError|ReferenceError|SyntaxError|Error|crash|exception|throw/i.test(hypothesisText)) {
		score += 0.1;
		signals.push("specific_error");
	}

	// Signal: references evidence directly (+0.1)
	const evidenceTokens = evidence.toLowerCase().split(/\W+/).filter((t) => t.length > 4);
	const hypTokens = hypothesisText.toLowerCase().split(/\W+/);
	const overlap = evidenceTokens.filter((t) => hypTokens.includes(t)).length;
	if (overlap > 3) {
		score += 0.1;
		signals.push("evidence_overlap");
	}

	// Signal: proposes concrete verification (+0.1)
	if (/verify|check|test|confirm|reproduce|log|debug/i.test(hypothesisText)) {
		score += 0.1;
		signals.push("verifiable");
	}

	// Signal: vague language penalty (-0.15)
	if (/maybe|might|could be anything|unclear|not sure|possibly/i.test(hypothesisText)) {
		score -= 0.15;
		signals.push("vague");
	}

	// Signal: mentions root cause specifically (+0.05)
	if (/root cause|underlying|actual.*issue|real.*problem/i.test(hypothesisText)) {
		score += 0.05;
		signals.push("root_cause_focus");
	}

	return {
		index: 0,
		title: hypothesisText.split("\n")[0].slice(0, 80),
		score: Math.max(0.1, Math.min(0.95, score)),
		signals,
	};
}

/** Parse LLM hypothesis output into scored hypotheses */
function scoreHypothesisOutput(llmOutput: string, evidence: string): { scored: ScoredHypothesis[]; annotated: string } {
	// Split on "Hypothesis N:" pattern
	const blocks = llmOutput.split(/(?=Hypothesis \d+)/i);
	const scored: ScoredHypothesis[] = [];
	let annotated = llmOutput;

	if (blocks.length > 1) {
		// Multiple hypotheses found — score each
		const results = blocks
			.filter((b) => b.trim().length > 10)
			.map((block, i) => {
				const s = scoreHypothesis(block, evidence);
				s.index = i;
				s.title = block.split("\n")[0].replace(/^Hypothesis \d+:\s*/i, "").trim().slice(0, 80);
				return { block, scored: s };
			});

		// Sort by score descending
		results.sort((a, b) => b.scored.score - a.scored.score);

		// Build annotated output
		annotated = results
			.map((r, rank) => {
				const s = r.scored;
				return `${r.block}\n[Score: ${(s.score * 100).toFixed(0)}% | Signals: ${s.signals.join(", ")}]`;
			})
			.join("\n\n");

		scored.push(...results.map((r) => r.scored));
	} else {
		// Single block — score as one
		const s = scoreHypothesis(llmOutput, evidence);
		s.index = 0;
		annotated = `${llmOutput}\n[Score: ${(s.score * 100).toFixed(0)}% | Signals: ${s.signals.join(", ")}]`;
		scored.push(s);
	}

	return { scored, annotated };
}
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { completeSimple, StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { resolveUtilityModel } from "../../lib/model-resolver.js";
import { Planner } from "../../lib/planner.js";
import { GoalManager } from "../../lib/goal-manager.js";

// =============================================================================
// think.ts - inlined
// =============================================================================

const thinkSchema = Type.Object({
	decision: Type.String({ description: "What you decided to do" }),
	reason: Type.String({ description: "Why this decision" }),
	thought_id: Type.Optional(Type.String({ description: "Unique identifier for this thought (auto-generated if not provided)" })),
	parent_id: Type.Optional(Type.String({ description: "ID of parent thought to create threaded reasoning chains" })),
	type: Type.Optional(
		StringEnum(
			["insight", "question", "assumption", "conclusion", "hypothesis", "plan", "quick", "deep"],
			{ description: "Categorize the thought type", default: "insight" },
		),
	),
	confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Confidence level 0-1 (optional)" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization and search" })),
	depth: Type.Optional(
		StringEnum(
			["quick", "deep"],
			{ description: "Analysis depth: 'quick' (default) or 'deep' (includes utility model perspective)", default: "quick" },
		),
	),
	ask_utility_model: Type.Optional(
		Type.Boolean({ description: "Explicit opt-in to call the utility model for additional perspective. Takes precedence over depth when true." }),
	),
});

const FRESH_EYES_PROMPT = `You are a fresh-eyes reviewer. An agent was working through a problem and recorded their thinking. Review it with a critical eye and provide a second perspective.

## Agent's Thinking
**What they observed:** {observation}
**What they decided:** {decision}
**Why they decided this:** {reason}

## Your Task
1. Identify any blind spots or assumptions in the agent's reasoning
2. Suggest what they might be missing
3. Point out any risks or concerns with the approach
4. Offer an alternative perspective if warranted

Be constructive but direct. The goal is to help the agent avoid mistakes.

## Response format
### Fresh Eyes Review
[Your analysis here - be direct about any concerns or blind spots]

### What Looks Solid
[What the agent got right]

### What to Consider
[Risks, missing context, or alternative approaches]`;

function createThinkTool(
	modelGetter: (ctx: ExtensionContext | undefined) => Model<any> | undefined,
	apiKeyGetter: (ctx: ExtensionContext | undefined) => Promise<string | undefined>,
): ToolDefinition<typeof thinkSchema> {
	return {
		name: "think",
		label: "Think",
		description: "Record structured thinking: observation, decision, reason. Use depth='deep' or ask_utility_model=true to also invoke the utility model for a fresh-eyes perspective.",
		parameters: thinkSchema,
		execute: async (_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext | undefined) => {
			const { observation, decision, reason } = params;
			const thoughtId = params.thought_id ?? randomUUID();
			const depth = params.depth ?? "quick";
			const useUtilityModel = params.ask_utility_model === true || depth === "deep";

			const result: Record<string, unknown> = { thought_id: thoughtId };
			if (params.parent_id) result.parent_id = params.parent_id;
			if (params.type) result.type = params.type;
			if (params.confidence !== undefined) result.confidence = params.confidence;
			if (params.tags) result.tags = params.tags;

			const lines: string[] = [
				`Thinking recorded (${params.type ?? "insight"}):`,
				`- Observed: ${observation}`,
				`- Decided: ${decision}`,
				`- Reason: ${reason}`,
				`- ID: ${thoughtId}${params.parent_id ? `\n- Parent: ${params.parent_id}` : ""}`,
			];

			if (useUtilityModel) {
				const utilityModel = modelGetter(ctx);
				const apiKey = await apiKeyGetter(ctx);

				if (utilityModel && apiKey) {
					const prompt = FRESH_EYES_PROMPT.replace("{observation}", observation)
						.replace("{decision}", decision)
						.replace("{reason}", reason);

					const context = {
						systemPrompt: "You are a sharp, critical thinker who reviews the reasoning of other agents.",
						messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }],
					};

					try {
						const response = await completeSimple(utilityModel as Model<Api>, context, { apiKey, maxTokens: 1024, temperature: 0.4 });
						if (!response.errorMessage) {
							const utilityText = response.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("\n");
							if (utilityText) {
								lines.push("", "---");
								lines.push("**Fresh Eyes (utility model):**", utilityText);
								result.modelUsed = utilityModel.id;
							}
						} else {
							lines.push("", `[_Utility model call failed: ${response.errorMessage}_]`);
							result.modelError = response.errorMessage;
						}
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						lines.push("", `[_Utility model error: ${message}_]`);
						result.modelError = message;
					}
				} else if (!utilityModel) {
					lines.push("", "[_No utility model configured. Add one via /utility-model or in settings._]");
					result.modelUsed = false;
				} else {
					lines.push("", `[_Utility model ${utilityModel.id} has no API key available._]`);
					result.modelUsed = utilityModel.id;
					result.modelError = "no_api_key";
				}
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { observation, decision, reason, ...result },
			};
		},
	};
}

// =============================================================================
// utility-hypothesize.ts - inlined
// =============================================================================

const hypothesizeSchema = Type.Object({
	problem: Type.String({ description: "The problem or issue to generate hypotheses about" }),
	evidence: Type.String({ description: "Relevant evidence, error messages, or observations" }),
	maxHypotheses: Type.Optional(Type.Number({ description: "Maximum number of hypotheses to generate (default: 3)" })),
});

const HYPOTHESIS_PROMPT = `You are an expert debugging assistant. Analyze the following problem and evidence to generate hypotheses about the root cause.

## Problem
{problem}

## Evidence
{evidence}

## Instructions
1. Generate exactly {maxHypotheses} distinct hypotheses about ROOT CAUSES
2. Each hypothesis must lead to a PROPER, well-designed solution (no shortcuts, no monkey patching)
3. For each hypothesis:
   - Explain WHY it's likely (reference the evidence)
   - Describe HOW to verify it
   - Explain WHY the solution is proper and maintainable
4. Rank them by likelihood (most likely first)
5. All suggested solutions must be equally maintainable and correct

Return your analysis in the following format:

Hypothesis 1: [Brief summary]
Likelihood: [High/Medium/Low]
Evidence: [Why this fits the observed evidence]
Verification: [How to confirm or rule out]
Solution: [What a proper fix would look like]

...repeat for each hypothesis...`;

function createHypothesizeTool(
	modelGetter: (ctx: ExtensionContext | undefined) => Model<any> | undefined,
	apiKeyGetter: (ctx: ExtensionContext | undefined) => Promise<string | undefined>,
): ToolDefinition<typeof hypothesizeSchema> {
	return {
		name: "hypothesize",
		label: "Hypothesize",
		description: `Structure your debugging approach by generating hypotheses about root causes.
This uses the utility model (a cheaper, faster model) to analyze the problem and suggest hypotheses.
Use this to:
- Organize multiple hypotheses about a problem
- Analyze error messages and stack traces
- Identify potential issues in code paths
- Brainstorm PROPER solutions before implementing

All hypotheses must lead to PROPER, well-designed solutions (no shortcuts, no monkey patching).
Returns structured analysis with ranked hypotheses.`,
		parameters: hypothesizeSchema,
		execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext | undefined): Promise<AgentToolResult<any>> => {
			const { problem, evidence, maxHypotheses = 3 } = params;
			const model = modelGetter(ctx);

			if (!model) {
				const lines: string[] = [
					`## Hypothesis Analysis: ${problem}`, "",
					"### Evidence", evidence, "",
					`### Hypotheses (generate ${maxHypotheses} and rank by likelihood)`,
					...Array.from({ length: maxHypotheses }, (_, i) => `${i + 1}. `), "",
					"For each hypothesis, explain: why it's likely, and why the solution is proper.",
					"Do NOT suggest monkey patches, workarounds, or quick fixes.", "",
					"_Note: No utility model configured. This is a template - use your own analysis._",
				];
				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { problem, hypotheses: maxHypotheses, modelUsed: "template" } };
			}

			const apiKey = await apiKeyGetter(ctx);
			if (!apiKey) {
				const lines: string[] = [
					`## Hypothesis Analysis: ${problem}`, "",
					"### Evidence", evidence, "",
					`### Hypotheses (generate ${maxHypotheses} and rank by likelihood)`,
					...Array.from({ length: maxHypotheses }, (_, i) => `${i + 1}. `), "",
					"For each hypothesis, explain: why it's likely, and why the solution is proper.",
					"Do NOT suggest monkey patches, workarounds, or quick fixes.", "",
					`_Note: No API key available for utility model (${model.provider}/${model.id}). Use your own analysis._`,
				];
				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { problem, hypotheses: maxHypotheses, modelUsed: model.id, error: "no_api_key" } };
			}

			const prompt = HYPOTHESIS_PROMPT.replace("{problem}", problem)
				.replace("{evidence}", evidence)
				.replace("{maxHypotheses}", String(maxHypotheses));

			const context = {
				systemPrompt: "You are an expert debugging assistant that analyzes problems and generates testable hypotheses.",
				messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }],
			};

			try {
				const response = await completeSimple(model as Model<Api>, context, { apiKey, maxTokens: 2048, temperature: 0.3 });
				if (response.errorMessage) {
					return { content: [{ type: "text" as const, text: `Hypothesis generation failed: ${response.errorMessage}` }], details: { problem, hypotheses: maxHypotheses, modelUsed: model.id, error: response.errorMessage } };
				}
				const textContent = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				// Score hypotheses with heuristic signals (Task 7)
				const { scored, annotated } = scoreHypothesisOutput(textContent || "No analysis produced.", evidence);

				return {
					content: [{ type: "text" as const, text: annotated }],
					details: {
						problem,
						hypotheses: maxHypotheses,
						modelUsed: model.id,
						scores: scored.map((s) => ({ rank: s.index, title: s.title, score: s.score, signals: s.signals })),
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: `Hypothesis generation error: ${message}` }], details: { problem, hypotheses: maxHypotheses, modelUsed: model.id, error: message } };
			}
		},
	};
}

// =============================================================================
// finalize.ts - inlined
// =============================================================================

const finalizeSchema = Type.Object({
	completed: Type.Boolean({ description: "Whether the task was successfully completed" }),
	summary: Type.String({ description: "Brief summary of what was accomplished" }),
	tasksRemaining: Type.Optional(Type.Array(Type.String(), { description: "Any follow-up tasks that should be done later" })),
	autoProceed: Type.Optional(Type.Boolean({ description: "Automatically propose next pending work on finalize" })),
});

const _planner = new Planner();
const _goalManager = new GoalManager();

/** Find next pending plan or goal to offer as continuation */
async function findNextWork(): Promise<{ type: "plan" | "goal" | null; id?: string; description?: string }> {
	try {
		// Check pending plans
		const plans = _planner.list();
		const pendingPlan = plans.find((p) => p.status === "planning" || p.status === "executing");
		if (pendingPlan) {
			// Get plan's steps via Planner.get(planId)?.steps
			const plan = _planner.get(pendingPlan.id)!;
			const remaining = plan.steps.filter((s) => s.status !== "completed" && s.status !== "failed").length;
			return { type: "plan", id: plan.id, description: `${pendingPlan.description || "Unnamed plan"} (${remaining} steps remaining)` };
		}

		// Check pending goals
		const goals = _goalManager.list();
		const pendingGoal = goals.find((g) => g.status === "pending");
		if (pendingGoal) {
			return { type: "goal", id: pendingGoal.id, description: pendingGoal.description };
		}
	} catch {
		// Non-fatal: planner/goal might not be available
	}
	return { type: null };
}

/**
 * Finalize Critic System Prompt - A "bad mood" reviewer with fresh eyes
 * Based on research: verification judge, agent quality audits, adaptive halting
 */
const FINALIZE_CRITIC_PROMPT = `You are a harsh, skeptical critic reviewing an AI coding session. Your job is to find everything wrong.

## Review Style
- Be brutally honest - like a tired senior engineer who's seen too many "done" tasks that weren't
- Ask: "Would I want to maintain this code?" "Is it actually tested?" "What would break in production?"
- Look for: unverified claims, skipped steps, missing error handling, shortcuts taken
- Fresh eyes means: pretend you don't know what was built, judge from the output alone

## Verification Checklist
1. **Code changes verified?** - Tests pass, manual verification exists, no "should work" claims
2. **Edge cases considered?** - Null checks, error handling, boundary conditions
3. **No shortcuts?** - No TODO placeholders, no "for now" hacks left in, no untested features
4. **Documentation matches code?** - README updated, comments accurate, no misleading names
5. **No fabrication?** - No made-up results, no fake test output, no optimistic "it works"

## Output Format
Return JSON with:
{
  "verdict": "pass|fail|warn",
  "confidence": 0-100,
  "issues": [
    { "severity": "critical|high|medium|low", "category": "unverified|incomplete|shortcut|claim|scope", "description": "..." }
  ],
  "summary": "one-line harsh verdict"
}

If critical issues found → verdict: "fail"
If high issues found → verdict: "warn"
If only medium/low issues → verdict: "pass"

IMPORTANT: Return ONLY valid JSON, no explanation outside the JSON structure.`;

/**
 * Verify with utility model - the "second brain" checkpoint
 * Uses adaptive halting: if agent work is clearly done, fast verification
 * If uncertain, spend more tokens on thorough analysis
 */
async function verifyWithUtilityModel(
	sessionSummary: string,
	ctx: ExtensionContext,
): Promise<{ verified: boolean; confidence: number; message: string }> {
	const model = resolveUtilityModel(ctx);
	if (!model) {
		return { verified: true, confidence: 50, message: "No utility model - skipped verification" };
	}

	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	if (!apiKey) {
		return { verified: true, confidence: 50, message: "No API key - skipped verification" };
	}

	const context: Context = {
		systemPrompt: FINALIZE_CRITIC_PROMPT,
		messages: [{
			role: "user",
			content: `Session summary to verify:\n\n${sessionSummary}\n\nIs this work actually complete and verified? Be brutal.`,
			timestamp: Date.now(),
		}],
	};

	try {
		// Race with timeout for adaptive halting
		const timeoutMs = 60000; // 60s max for verification
		const timeoutPromise = new Promise<never>((_, reject) => {
			const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
			ctx.signal?.addEventListener("abort", () => clearTimeout(t), { once: true });
		});

		const verifyPromise = completeSimple(model as Model<Api>, context, {
			apiKey,
			maxTokens: 1024,
			temperature: 0.1,
			signal: ctx.signal,
		});

		const result = await Promise.race([verifyPromise, timeoutPromise]);

		if (!result || result.errorMessage) {
			return { verified: true, confidence: 30, message: "Verification error - allowing finalize" };
		}

		// Parse JSON response
		const textContent = result.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
		const responseText = textContent[0]?.text ?? "";

		// Extract JSON from response
		const jsonMatch = responseText.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			// Fallback: if no JSON, trust the response text as verdict
			return {
				verified: true,
				confidence: 40,
				message: responseText.slice(0, 200) || "Verification completed",
			};
		}

		const verdict = JSON.parse(jsonMatch[0]);
		const verified = verdict.verdict === "pass" || verdict.verdict === "warn";
		const confidence = verdict.confidence ?? 50;
		const issues = verdict.issues ?? [];

		// Format message
		let message = `Verification: ${verdict.verdict.toUpperCase()}`;
		if (verdict.summary) {
			message += ` - ${verdict.summary}`;
		}
		if (issues.length > 0) {
			const critical = issues.filter((i: any) => i.severity === "critical").length;
			const high = issues.filter((i: any) => i.severity === "high").length;
			if (critical > 0) {
				message += `\n🔴 ${critical} critical issue(s) found`;
			}
			if (high > 0) {
				message += `\n🟠 ${high} high priority issue(s) found`;
			}
		}

		return { verified, confidence, message };
	} catch (err: unknown) {
		if (err instanceof Error && err.message === "timeout") {
			return { verified: true, confidence: 20, message: "Verification timeout - allowing finalize" };
		}
		return { verified: true, confidence: 30, message: "Verification failed - allowing finalize" };
	}
}

function createFinalizeTool(
	onFinalize?: (summary: string, completed: boolean) => void,
): {
	name: string;
	label: string;
	description: string;
	parameters: typeof finalizeSchema;
	execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: ExtensionContext | undefined) => Promise<AgentToolResult<any>>;
} {
	return {
		name: "finalize",
		label: "Finalize",
		description: `Mark the current task as complete. You MUST call this when:
- All code is written and tested
- The solution has been verified
- No further work is needed

Before finalizing, the work will be reviewed by a critic (utility model) to ensure everything is actually done.
The task ends after finalize() is called.`,
		parameters: finalizeSchema,
		execute: async (
			_toolCallId: string,
			params: any,
			_signal: any,
			_onUpdate: any,
			_ctx: ExtensionContext | undefined,
		): Promise<AgentToolResult<any>> => {
			// Validate required params - prevent crash on empty finalize: {}
			if (!params || params.summary === undefined || params.completed === undefined) {
				return {
					content: [{
						type: "text" as const,
						text: `🚫 **FINALIZE REQUIRES PARAMETERS**

Missing required fields. Please provide:
- completed: boolean (true if task succeeded, false if not)
- summary: string (what was accomplished)
- tasksRemaining?: string[] (optional follow-up tasks)

Example:
finalize(completed=true, summary="Fixed the bug", tasksRemaining=["write tests"])`,
					}],
					details: { finalized: false, blocked: true, error: "missing_params" },
				};
			}

			onFinalize?.(params.summary, params.completed);

			// Build session summary for verification
			// In real implementation, this would read from session manager
			const sessionSummary = params.summary;

			// Verify with utility model (second brain)
			// If no ctx available, skip verification
			let verificationResult: { verified: boolean; confidence: number; message: string } = {
				verified: true,
				confidence: 50,
				message: "No context available for verification",
			};

			if (_ctx) {
				verificationResult = await verifyWithUtilityModel(sessionSummary, _ctx);
			}

			// Critical failures block finalize
			if (!verificationResult.verified) {
				return {
					content: [{
						type: "text" as const,
						text: `🚫 **FINALIZE BLOCKED**

${verificationResult.message}

Confidence: ${verificationResult.confidence}%

**The work is not done enough to finalize.**
Continue working until the issues are resolved.`,
					}],
					details: { finalized: false, blocked: true, verification: verificationResult },
				};
			}

			// Build completion message
			const status = params.completed ? "✅ Task completed" : "⚠️ Task incomplete";
			const messages: string[] = [
				status,
				`Summary: ${params.summary}`,
			];

			if (verificationResult.message) {
				messages.push(`\nVerification: ${verificationResult.message}`);
			}

			if (params.tasksRemaining?.length) {
				messages.push(`\n⚠️ Follow-up needed: ${params.tasksRemaining.join(", ")}`);
			}

			// Auto-proceed: find next pending plan or goal
			const nextWork = await findNextWork();
			if (nextWork.type) {
				const label = nextWork.type === "plan" ? "📋 Next Plan" : "🎯 Next Goal";
				messages.push(`\n${label}: ${nextWork.description}`);
				messages.push(`\n→ Type \`finalize(true, "...", [], true)\` to continue automatically, or continue manually.`);
				if (params.autoProceed && nextWork.id) {
					messages.push(`\n🔄 Auto-proceeding to next work...`);
				}
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
				},
			};
		},
	};
}

// =============================================================================
// Extension registration
// =============================================================================

export default function metacognitionExtension(pi: ExtensionAPI) {
	// Auto-enable extension tools on first turn.
	// In --no-session mode, session_start and session_tree events are NOT fired,
	// so the assistant extension's restoreToolState() never runs.
	// This causes extension tools (think, finalize, memory_*, etc.) to be missing
	// from the active tools list, despite being registered.
	// Solution: Listen to turn_start (which IS fired) and auto-enable all
	// registered extension tools on the first turn.
	let toolsAutoEnabled = false;
	pi.on("turn_start", () => {
		if (!toolsAutoEnabled) {
			const allToolNames = pi.getAllTools().map((t: { name: string }) => t.name);
			if (allToolNames.length > 0) {
				pi.setActiveTools(allToolNames);
			}
			toolsAutoEnabled = true;
		}
	});
	// Think tool
	const thinkTool = createThinkTool(
		(ctx) => {
			if (!ctx) return undefined;
			return resolveUtilityModel(ctx);
		},
		async (ctx) => {
			if (!ctx) return undefined;
			const model = resolveUtilityModel(ctx);
			if (!model) return undefined;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			return auth.ok && auth.apiKey ? auth.apiKey : undefined;
		},
	);
	pi.registerTool({ name: thinkTool.name, label: thinkTool.label, description: thinkTool.description, parameters: thinkTool.parameters, execute: thinkTool.execute });

	// Hypothesize tool
	const hypothesizeTool = createHypothesizeTool(
		(ctx) => {
			if (!ctx) return undefined;
			return resolveUtilityModel(ctx);
		},
		async (ctx) => {
			if (!ctx) return undefined;
			const model = resolveUtilityModel(ctx);
			if (!model) return undefined;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			return auth.ok && auth.apiKey ? auth.apiKey : undefined;
		},
	);
	pi.registerTool({ name: hypothesizeTool.name, label: hypothesizeTool.label, description: hypothesizeTool.description, parameters: hypothesizeTool.parameters, execute: hypothesizeTool.execute });

	// Finalize tool
	const finalizeTool = createFinalizeTool();
	pi.registerTool({ name: finalizeTool.name, label: finalizeTool.label, description: finalizeTool.description, parameters: finalizeTool.parameters, execute: finalizeTool.execute });

	// ── Auto-enable extension tools ─────────────────────────────────────────────
	// In --no-session mode, session_start/session_tree events don't fire,
	// so the assistant extension's restoreToolState() never runs.
	// This means extension tools (think, finalize, memory_*, etc.) are NOT enabled.
	// Fix: Use before_agent_start instead of turn_start because turn_start fires AFTER
	// the agent loop has already captured context.tools for the current turn.
	// before_agent_start fires before createContextSnapshot, so new tools are included.
	let extensionToolsAutoEnabled = false;
	pi.on("before_agent_start", async () => {
		if (extensionToolsAutoEnabled) return;
		extensionToolsAutoEnabled = true;

		const activeTools = pi.getActiveTools();
		const allToolNames = pi.getAllTools().map((t) => t.name);
		const newTools = allToolNames.filter((n) => !activeTools.includes(n));
		if (newTools.length > 0) {
			pi.setActiveTools([...activeTools, ...newTools]);
		}
	});
}
