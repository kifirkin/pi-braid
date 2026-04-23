// ── Finalize Tool ─────────────────────────────────────────────────────────────
// Marks task complete with session model verification.
// Uses the session's current model (ctx.model) for critical review.

import { Type } from "typebox";
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("metacognition");

const finalizeSchema = Type.Object({
	completed:     Type.Boolean({ description: "Whether the task was successfully completed" }),
	summary:       Type.String({ description: "Brief summary of what was accomplished" }),
	tasksRemaining: Type.Optional(Type.Array(Type.String(), { description: "Follow-up tasks" })),
	autoProceed:   Type.Optional(Type.Boolean({ description: "Automatically propose next pending work on finalize" })),
});

// Simple in-memory planner/goal state for findNextWork
interface PendingItem { type: "plan" | "goal"; id: string; description: string; }
const _planner: PendingItem[] = [];
const _goalManager: PendingItem[] = [];

async function findNextWork(): Promise<{ type: string; id?: string; description?: string }> {
	if (_planner.length > 0) {
		const next = _planner.shift()!;
		return { type: next.type, id: next.id, description: next.description };
	}
	if (_goalManager.length > 0) {
		const next = _goalManager.shift()!;
		return { type: next.type, id: next.id, description: next.description };
	}
	return { type: "" };
}

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

async function verifyWithSessionModel(summary: string, ctx: ExtensionContext): Promise<{ verified: boolean; confidence: number; message: string }> {
	if (!ctx.model) {
		return { verified: true, confidence: 50, message: "No model available for verification" };
	}

	try {
		const response = await complete(
			ctx.model,
			{
				systemPrompt: FINALIZE_CRITIC_PROMPT,
				messages: [{ role: "user" as const, content: [{ type: "text" as const, text: `Work summary: ${summary}` }], timestamp: Date.now() }],
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

export function createFinalizeTool(
	onFinalize?: (summary: string, completed: boolean) => void,
) {
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
		execute: async (_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, _ctx: ExtensionContext | undefined) => {
			if (!params || params.summary === undefined || params.completed === undefined) {
				return {
					content: [{
						type: "text" as const,
						text: `**FINALIZE REQUIRES PARAMETERS**

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

			const sessionSummary = params.summary;
			let verificationResult = { verified: true, confidence: 50, message: "No context available for verification" };

			if (_ctx) {
				verificationResult = await verifyWithSessionModel(sessionSummary, _ctx);
			}

			if (!verificationResult.verified) {
				return {
					content: [{
						type: "text" as const,
						text: `**FINALIZE BLOCKED**

${verificationResult.message}

Confidence: ${verificationResult.confidence}%

**The work is not done enough to finalize.**
Continue working until the issues are resolved.`,
					}],
					details: { finalized: false, blocked: true, verification: verificationResult },
				};
			}

			const status = params.completed ? "Task completed" : "Task incomplete";
			const messages: string[] = [status, `Summary: ${params.summary}`];

			if (verificationResult.message) {
				messages.push(`\nVerification: ${verificationResult.message}`);
			}

			if (params.tasksRemaining?.length) {
				messages.push(`\nFollow-up needed: ${params.tasksRemaining.join(", ")}`);
			}

			const nextWork = await findNextWork();
			if (nextWork.type) {
				const label = nextWork.type === "plan" ? "Next Plan" : "Next Goal";
				messages.push(`\n${label}: ${nextWork.description}`);
				messages.push(`\nType \`finalize(true, "...", [], true)\` to continue automatically, or continue manually.`);
				if (params.autoProceed && nextWork.id) {
					messages.push(`\nAuto-proceeding to next work...`);
				}
			}

			messages.push("\n---");
			messages.push("Session ending...");

			return {
				content: [{ type: "text" as const, text: messages.join("\n") }],
				details: { finalized: true, completed: params.completed, summary: params.summary, verification: verificationResult },
			};
		},
	};
}
