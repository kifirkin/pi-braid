/**
 * LLM Judge - Analyzes responses using the session model
 *
 * Uses completeSimple() with the session model (ctx.model) for structured analysis.
 * The judge evaluates responses for contradictions, hallucinations, and
 * other behavioral issues.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { JUDGE_SYSTEM_PROMPT } from "./judge-prompt.js";
import { callLlm, extractJson } from "./judge-utils.js";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("judge");

/**
 * Multi-dimensional scores from judge analysis
 */
export interface JudgeScores {
	contradiction: number; // 0-100: Self-contradiction detection
	hallucination: number; // 0-100: Grounded in context
	selfInterference: number; // 0-100: Internal consistency
	overconfidence: number; // 0-100: Claims vs verification
	logicalCoherence: number; // 0-100: Logical consistency
	completeness: number; // 0-100: Task completion
	compliancePattern: number; // 0-100: Compliance theater (0=strong compliance theater, 100=genuine reasoning)
}

/**
 * A claim extracted from the response
 */
export interface Claim {
	text: string;
	type: "positive_claim" | "recommendation" | "conclusion" | "observation";
	grounded: boolean;
}

/**
 * A contradiction between two claims
 */
export interface Contradiction {
	claim1: string;
	claim2: string;
	severity: "high" | "medium" | "low";
	explanation: string;
}

/**
 * An issue found in the response
 */
export interface JudgeIssue {
	dimension: keyof JudgeScores;
	severity: "high" | "medium" | "low";
	description: string;
	evidence: string;
}

/**
 * Complete judge analysis result
 */
export interface JudgeAnalysis {
	scores: JudgeScores;
	claims: Claim[];
	contradictions: Contradiction[];
	issues: JudgeIssue[];
	verdict: "pass" | "warn" | "fail";
	verdictConfidence: number;
	summary: string;
}

/**
 * Raw JSON structure returned by the judge LLM
 */
interface JudgeRawOutput {
	scores: {
		contradiction?: number;
		hallucination?: number;
		selfInterference?: number;
		overconfidence?: number;
		logicalCoherence?: number;
		completeness?: number;
		[key: string]: number | undefined;
	};
	claims?: Array<{
		text?: string;
		type?: string;
		grounded?: boolean;
	}>;
	contradictions?: Array<{
		claim1?: string;
		claim2?: string;
		severity?: string;
		explanation?: string;
	}>;
	issues?: Array<{
		dimension?: string;
		severity?: string;
		description?: string;
		evidence?: string;
	}>;
	verdict?: string;
	verdictConfidence?: number;
	summary?: string;
}

/**
 * Action to take based on judge analysis
 */
export interface JudgeAction {
	type: "block" | "nudge" | "none";
	reason: string;
	priority: "critical" | "high" | "medium" | "low";
	nudgeMessage?: string;
}

export { getJudgeModel } from "./judge-utils.js";

/**
 * Build the analysis prompt with conversation context
 */
function buildAnalysisPrompt(
	currentMessage: string,
	conversationHistory: string[],
	maxHistoryChars: number = 8000,
): string {
	let historyText = "";

	// Build history from oldest to newest
	for (const msg of conversationHistory) {
		const candidate = `\n${msg}`;
		if (historyText.length + candidate.length > maxHistoryChars) {
			break;
		}
		historyText = candidate + historyText;
	}

	return `Analyze this assistant response for behavioral issues.

## CONVERSATION HISTORY
${historyText || "(No prior conversation)"}

## CURRENT RESPONSE TO ANALYZE
${currentMessage}`;
}

/**
 * Parse judge output with robust error handling
 */
function parseJudgeOutput(raw: string): JudgeAnalysis | null {
	try {
		const jsonStr = extractJson(raw);
		if (!jsonStr) return null;

		// Try to fix incomplete JSON by finding complete objects
		try {
			JSON.parse(jsonStr);
		} catch {
			const scoresMatch = jsonStr.match(/"scores"\s*:\s*\{[^}]+\}/);
			if (scoresMatch) {
				const scoresContent = scoresMatch[0].replace('"scores":', "").trim();
				try {
					JSON.parse(`{"scores": ${scoresContent}}`);
				} catch {
					return null;
				}
			} else {
				return null;
			}
		}

		const parsed: JudgeRawOutput = JSON.parse(jsonStr);

		// Validate and normalize scores
		const scores: JudgeScores = {
			contradiction: Math.min(100, Math.max(0, parsed.scores?.contradiction ?? 100)),
			hallucination: Math.min(100, Math.max(0, parsed.scores?.hallucination ?? 100)),
			selfInterference: Math.min(100, Math.max(0, parsed.scores?.selfInterference ?? 100)),
			overconfidence: Math.min(100, Math.max(0, parsed.scores?.overconfidence ?? 100)),
			logicalCoherence: Math.min(100, Math.max(0, parsed.scores?.logicalCoherence ?? 100)),
			completeness: Math.min(100, Math.max(0, parsed.scores?.completeness ?? 100)),
			compliancePattern: Math.min(100, Math.max(0, parsed.scores?.compliancePattern ?? 0)),
		};

		// Normalize claims
		const claims: Claim[] = (parsed.claims ?? [])
			.filter((c) => c.text && c.type)
			.map((c) => ({
				text: c.text!,
				type: c.type as Claim["type"],
				grounded: c.grounded ?? true,
			}));

		// Normalize contradictions
		const contradictions: Contradiction[] = (parsed.contradictions ?? [])
			.filter((c) => c.claim1 && c.claim2)
			.map((c) => ({
				claim1: c.claim1!,
				claim2: c.claim2!,
				severity: (c.severity as Contradiction["severity"]) ?? "medium",
				explanation: c.explanation ?? "",
			}));

		// Normalize issues
		const issues: JudgeIssue[] = (parsed.issues ?? [])
			.filter((i) => i.description && i.dimension)
			.map((i) => ({
				dimension: i.dimension as keyof JudgeScores,
				severity: (i.severity as JudgeIssue["severity"]) ?? "medium",
				description: i.description!,
				evidence: i.evidence ?? "",
			}));

		// Validate verdict
		const verdict = ["pass", "warn", "fail"].includes(parsed.verdict ?? "")
			? (parsed.verdict as JudgeAnalysis["verdict"])
			: "pass";

		return {
			scores,
			claims,
			contradictions,
			issues,
			verdict,
			verdictConfidence: Math.min(100, Math.max(0, parsed.verdictConfidence ?? 50)),
			summary: parsed.summary ?? "Analysis complete",
		};
	} catch (err) {
		log.error("Failed to parse judge output:", err);
		return null;
	}
}

/**
 * Determine action based on analysis scores.
 *
 * Improvements over naive implementation:
 * 1. Verdict is derived from scores rather than trusting the LLM's independent verdict label
 * 2. Issues with evidence that doesn't exist in the response are filtered out before nudging
 * 3. Minimum confidence threshold required before failing
 */
export function determineAction(analysis: JudgeAnalysis, responseText?: string): JudgeAction {
	// High-severity contradictions always trigger action
	if (analysis.contradictions.length > 0) {
		const highSeverity = analysis.contradictions.filter((c) => c.severity === "high");
		if (highSeverity.length > 0 || analysis.contradictions.length >= 2) {
			return {
				type: "nudge",
				reason: "Contradiction detected",
				priority: "high",
				nudgeMessage: formatContradictionNudge(analysis.contradictions),
			};
		}
	}

	// Check scores for action triggers
	const criticalIssues: string[] = [];
	const highIssues: string[] = [];

	// Contradiction check (low score = high issue)
	if (analysis.scores.contradiction < 40) {
		criticalIssues.push(`Contradiction score: ${analysis.scores.contradiction}/100`);
	} else if (analysis.scores.contradiction < 60) {
		highIssues.push(`Potential contradiction: ${analysis.scores.contradiction}/100`);
	}

	// Hallucination check
	if (analysis.scores.hallucination < 40) {
		criticalIssues.push(`Hallucination detected: ${analysis.scores.hallucination}/100`);
	} else if (analysis.scores.hallucination < 60) {
		highIssues.push(`Unsubstantiated claims: ${analysis.scores.hallucination}/100`);
	}

	// Self-interference check
	if (analysis.scores.selfInterference < 40) {
		criticalIssues.push(`Self-interference: ${analysis.scores.selfInterference}/100`);
	} else if (analysis.scores.selfInterference < 60) {
		highIssues.push(`Inconsistent reasoning: ${analysis.scores.selfInterference}/100`);
	}

	// Overconfidence check
	if (analysis.scores.overconfidence < 50) {
		highIssues.push(`Overconfidence: claims without verification`);
	}

	// Logical coherence check
	if (analysis.scores.logicalCoherence < 40) {
		criticalIssues.push(`Logical errors: ${analysis.scores.logicalCoherence}/100`);
	}

	// Compliance pattern check (compliance theater detection)
	if (analysis.scores.compliancePattern < 40) {
		criticalIssues.push(`Compliance pattern: ${analysis.scores.compliancePattern}/100 — following instructions at letter, ignoring intent`);
	} else if (analysis.scores.compliancePattern < 60) {
		highIssues.push(`Directive-following without reasoning: ${analysis.scores.compliancePattern}/100`);
	}

	// Filter issues with evidence not found in the response (hallucinated evidence)
	let filteredIssues = analysis.issues;
	if (responseText) {
		filteredIssues = analysis.issues.filter((issue) => {
			if (!issue.evidence) return true;
			return responseText.includes(issue.evidence);
		});
	}

	// Derive verdict from scores instead of trusting LLM's independent verdict
	const averageScore =
		(analysis.scores.contradiction +
			analysis.scores.hallucination +
			analysis.scores.selfInterference +
			analysis.scores.overconfidence +
			analysis.scores.logicalCoherence +
			analysis.scores.completeness) /
		6;

	const derivedVerdict: "pass" | "warn" | "fail" = averageScore >= 70 ? "pass" : averageScore >= 40 ? "warn" : "fail";

	// Verdict-based action with confidence threshold
	// Only trigger "fail" if confidence is above 70% to avoid false positives
	if (derivedVerdict === "fail" && analysis.verdictConfidence >= 70) {
		return {
			type: "nudge",
			reason: `Judge verdict: fail (confidence: ${analysis.verdictConfidence}%)`,
			priority: "critical",
			nudgeMessage: formatVerdictNudge({ ...analysis, issues: filteredIssues }),
		};
	}

	// If scores imply fail but confidence is low, treat as warn
	if (derivedVerdict === "fail" || derivedVerdict === "warn" || highIssues.length > 0) {
		const allIssues = [...criticalIssues, ...highIssues];
		return {
			type: "nudge",
			reason: allIssues.length > 0 ? allIssues.join("; ") : `Judge verdict: warn`,
			priority: criticalIssues.length > 0 ? "high" : "medium",
			nudgeMessage: formatScoreNudge(analysis),
		};
	}

	return {
		type: "none",
		reason: "No issues detected",
		priority: "low",
	};
}

/**
 * Format contradiction nudge message
 */
function formatContradictionNudge(contradictions: Contradiction[]): string {
	const lines = ["## Reasoning Inconsistency Detected"];

	for (const c of contradictions.slice(0, 3)) {
		lines.push("");
		lines.push(`**Claim 1:** ${c.claim1}`);
		lines.push(`**Claim 2:** ${c.claim2}`);
		lines.push(`**Explanation:** ${c.explanation}`);
	}

	lines.push("");
	lines.push("What would make these claims consistent with each other?");

	return lines.join("\n");
}

/**
 * Format verdict-based nudge
 */
function formatVerdictNudge(analysis: JudgeAnalysis): string {
	const lines = ["## Response Worth Reconsidering"];

	if (analysis.summary) {
		lines.push("");
		lines.push(`**Summary:** ${analysis.summary}`);
	}

	lines.push("");
	lines.push("**Areas worth examining:**");

	for (const issue of analysis.issues.slice(0, 5)) {
		lines.push(`- [${issue.dimension}] ${issue.description}`);
		if (issue.evidence) {
			const evidence = issue.evidence.length > 100 ? `${issue.evidence.slice(0, 100)}...` : issue.evidence;
			lines.push(`  Evidence: "${evidence}"`);
		}
	}

	lines.push("");
	lines.push("What evidence would strengthen these claims?");

	return lines.join("\n");
}

/**
 * Format score-based nudge
 */
function formatScoreNudge(analysis: JudgeAnalysis): string {
	const lines = ["## Response Quality Check"];

	if (analysis.summary) {
		lines.push(`**Summary:** ${analysis.summary}`);
	}

	const lowScores: string[] = [];
	if (analysis.scores.contradiction < 70) lowScores.push(`Contradiction: ${analysis.scores.contradiction}/100`);
	if (analysis.scores.hallucination < 70) lowScores.push(`Groundedness: ${analysis.scores.hallucination}/100`);
	if (analysis.scores.selfInterference < 70)
		lowScores.push(`Self-consistency: ${analysis.scores.selfInterference}/100`);
	if (analysis.scores.overconfidence < 70) lowScores.push(`Verification: ${analysis.scores.overconfidence}/100`);

	if (lowScores.length > 0) {
		lines.push("");
		lines.push("**Low scores:**");
		for (const s of lowScores) {
			lines.push(`- ${s}`);
		}
	}

	return lines.join("\n");
}

/**
 * Main judge analysis function
 */
export async function analyzeWithJudge(
	ctx: ExtensionContext,
	currentMessage: string,
	conversationHistory: string[],
	options: {
		timeoutMs?: number;
		maxTokens?: number;
	} = {},
): Promise<{ analysis: JudgeAnalysis | null; action: JudgeAction }> {
	const prompt = buildAnalysisPrompt(currentMessage, conversationHistory);
	const result = await callLlm(ctx, JUDGE_SYSTEM_PROMPT, prompt, options);

	if ("error" in result) {
		return {
			analysis: null,
			action: { type: "none", reason: `Judge error: ${result.error}`, priority: "low" },
		};
	}

	const analysis = parseJudgeOutput(result.text);
	if (!analysis) {
		return {
			analysis: null,
			action: { type: "none", reason: "Failed to parse judge output", priority: "low" },
		};
	}

	const action = determineAction(analysis, currentMessage);
	return { analysis, action };
}
