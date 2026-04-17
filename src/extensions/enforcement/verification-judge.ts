/**
 * Verification Judge - LLM-based work quality audit
 *
 * Replaces regex-based claim/lazy detection with structured LLM analysis
 * at strategic checkpoints (pre-finalize, verification gap, periodic drift).
 *
 * Uses completeSimple() to call the utility model. Evaluates whether
 * the agent's work aligns with the user's request, whether code changes
 * are verified, and whether shortcuts were taken.
 */

import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { VERIFICATION_JUDGE_SYSTEM_PROMPT } from "./judge-prompt.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("verification-judge");

/**
 * Result from the verification judge analysis
 */
export interface VerificationVerdict {
	/** Overall pass/fail/warn */
	verdict: "pass" | "warn" | "fail";
	/** Confidence 0-100 */
	confidence: number;
	/** Human-readable summary */
	summary: string;
	/** Specific issues found (empty if pass) */
	issues: VerificationIssue[];
	/** Whether code changes exist that haven't been verified */
	unverifiedChanges: boolean;
}

export interface VerificationIssue {
	severity: "critical" | "high" | "medium" | "low";
	category: "unverified" | "incomplete" | "shortcut" | "claim" | "scope";
	description: string;
}

/**
 * Context snapshot passed to the judge for analysis
 */
export interface JudgeContext {
	/** User's original request/task */
	userRequest: string | undefined;
	/** Tools used during this session (unique set) */
	toolsUsed: string[];
	/** Tool execution log (chronological) */
	toolLog: string[];
	/** Has code been modified (edit/write) */
	hasCodeChanges: boolean;
	/** Has verification been run (bash with test commands) */
	hasVerification: boolean;
	/** Agent's last response text (for claim detection) */
	lastResponse: string;
	/** Agent's thinking/reasoning text (if available) */
	thinking: string;
}

/**
 * Get a suitable model for verification analysis
 */
export function getVerificationModel(ctx: ExtensionContext): Model<Api> | undefined {
	let model: Model<Api> | undefined;
	try {
		model = (ctx as any).getUtilityModel?.();
	} catch {
		// Polyfill not patched yet (no session_start in -p mode)
	}

	if (!model) {
		model = ctx.model;
		if (model?.reasoning) {
			const availableModels = ctx.modelRegistry.getAvailable();
			const nonReasoning = availableModels.filter((m) => !m.reasoning);
			nonReasoning.sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output));
			model = nonReasoning[0];
		}
	}

	return model;
}

/**
 * Build the verification analysis prompt
 */
function buildVerificationPrompt(context: JudgeContext): string {
	const sections: string[] = [];

	if (context.userRequest) {
		sections.push(`## USER REQUEST\n${context.userRequest}\n`);
	}

	sections.push("## TOOLS USED");
	sections.push(context.toolsUsed.length > 0 ? context.toolsUsed.join(", ") : "(none)");
	sections.push("");

	if (context.toolLog.length > 0) {
		sections.push("## TOOL EXECUTION LOG");
		sections.push(context.toolLog.slice(-30).join("\n")); // Last 30 entries
		sections.push("");
	}

	sections.push(`## CODE CHANGES: ${context.hasCodeChanges ? "YES" : "NO"}`);
	sections.push(`## VERIFICATION RUN: ${context.hasVerification ? "YES" : "NO"}`);
	sections.push("");

	if (context.thinking) {
		sections.push("## AGENT REASONING (thinking blocks)");
		sections.push(context.thinking);
		sections.push("");
	}

	if (context.lastResponse) {
		sections.push("## AGENT RESPONSE (visible text)");
		sections.push(context.lastResponse);
	}

	return sections.join("\n");
}

/**
 * Parse judge output with robust error handling
 */
export function parseVerificationOutput(raw: string): VerificationVerdict | null {
	try {
		if (!raw || typeof raw !== "string") return null;

		let jsonStr = raw.trim();

		// Remove markdown code blocks
		const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch?.[1]) {
			jsonStr = jsonMatch[1].trim();
		}

		// Find JSON start/end
		const jsonStartMatch = jsonStr.match(/[[{]/);
		if (jsonStartMatch) {
			jsonStr = jsonStr.slice(jsonStartMatch.index!);
		}

		const lastBrace = jsonStr.lastIndexOf("}");
		const lastBracket = jsonStr.lastIndexOf("]");
		const jsonEnd = Math.max(lastBrace, lastBracket);
		if (jsonEnd > 0 && jsonEnd < jsonStr.length - 1) {
			jsonStr = jsonStr.slice(0, jsonEnd + 1);
		}

		if (!jsonStr || jsonStr.length < 10) return null;

		const parsed = JSON.parse(jsonStr);

		const issues: VerificationIssue[] = (parsed.issues ?? [])
			.filter((i: Record<string, unknown>) => i.description && i.category)
			.map((i: Record<string, unknown>) => ({
				severity: (i.severity as VerificationIssue["severity"]) ?? "medium",
				category: i.category as VerificationIssue["category"],
				description: i.description as string,
			}));

		const verdict = ["pass", "warn", "fail"].includes(parsed.verdict)
			? (parsed.verdict as VerificationVerdict["verdict"])
			: "warn";

		return {
			verdict,
			confidence: Math.min(100, Math.max(0, parsed.confidence ?? 50)),
			summary: parsed.summary ?? "Analysis complete",
			issues,
			unverifiedChanges: parsed.unverifiedChanges ?? false,
		};
	} catch {
		return null;
	}
}

/**
 * Format judge result as enforcement nudge message
 */
export function formatVerificationNudge(result: VerificationVerdict): string {
	const lines: string[] = [];

	const icon = result.verdict === "fail" ? "[FAIL]" : result.verdict === "warn" ? "[WARN]" : "[PASS]";
	lines.push(`## ${icon} VERIFICATION JUDGE: ${result.verdict.toUpperCase()}`);

	if (result.summary) {
		lines.push(`\n**Summary:** ${result.summary}`);
	}

	if (result.issues.length > 0) {
		lines.push("\n**Issues:**");
		for (const issue of result.issues) {
			const prefix = issue.severity === "critical" ? "🔴" : issue.severity === "high" ? "🟠" : "🟡";
			lines.push(`- ${prefix} [${issue.category}] ${issue.description}`);
		}
	}

	if (result.unverifiedChanges) {
		lines.push("\n**Unverified code changes detected.** Run tests or commands to verify before finalizing.");
	}

	lines.push(`\n*Confidence: ${result.confidence}%*`);

	return lines.join("\n");
}

/**
 * Run the verification judge analysis
 *
 * @param ctx - Extension context for model access
 * @param judgeContext - Context snapshot for analysis
 * @returns Verification verdict or null on failure
 */
export async function runVerificationJudge(
	ctx: ExtensionContext,
	judgeContext: JudgeContext,
	options: { timeoutMs?: number } = {},
): Promise<VerificationVerdict | null> {
	const model = getVerificationModel(ctx);
	if (!model) {
		log.warn("No model available");
		return null;
	}

	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	if (!apiKey) {
		log.warn("No API key available");
		return null;
	}

	const prompt = buildVerificationPrompt(judgeContext);
	const maxTokens = Math.min(Math.max(500, Math.floor(prompt.length / 8)), 2000);

	const context: Context = {
		systemPrompt: VERIFICATION_JUDGE_SYSTEM_PROMPT,
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	};

	const timeoutMs = options.timeoutMs ?? 30000;
	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("Verification judge timeout")), timeoutMs);
	});

	try {
		const result = await Promise.race([
			completeSimple(model as Model<Api>, context, {
				apiKey,
				maxTokens,
				temperature: 0.1,
			}),
			timeoutPromise,
		]);

		if (result.errorMessage) {
			log.error("LLM error:", result.errorMessage);
			return null;
		}

		const textContent = result.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
		const rawOutput = textContent.length > 0 ? textContent[0].text : "";

		return parseVerificationOutput(rawOutput);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error("Analysis failed:", message);
		return null;
	}
}
