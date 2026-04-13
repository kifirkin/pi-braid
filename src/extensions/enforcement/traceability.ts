/**
 * Traceability & Final Validation System
 *
 * Validates completed goals and plans against the original user request.
 * Runs during finalize() to prevent premature loop termination when work
 * is incomplete or misaligned.
 *
 * Architecture (3 layers):
 * 1. Request Parsing — extracts structured requirements from user input
 * 2. Goal-Requirement Mapping — tracks which goals address which requirements
 * 3. Finalize Gate — coverage scoring on finalize()
 *
 * Inspired by fractals' patterns:
 * - Lineage tracking for traceability back to root
 * - Structured decomposition for requirement extraction
 * - Two-phase flow (plan → execute → validate)
 */

// ========================================================================
// Types
// ========================================================================

export interface ParsedRequirement {
	id: string;
	text: string;
	priority: "must" | "should" | "could";
	type: "feature" | "constraint" | "non-functional";
}

export interface ParsedRequest {
	requirements: ParsedRequirement[];
	acceptanceCriteria: string[];
	originalText: string;
}

export interface GoalAlignmentData {
	id: string;
	description: string;
	status: string;
	parentId?: string;
	mapsToRequirements: string[];
	successCriteria: string[];
	evidenceCollected: string[];
	subgoals: string[];
}

export interface PlanAlignmentData {
	id: string;
	description: string;
	status: string;
	steps: {
		description: string;
		status: string;
		expectedOutcome: string;
		actualOutcome?: string;
	}[];
}

export interface CoverageResult {
	score: number;
	totalRequirements: number;
	coveredRequirements: {
		id: string;
		text: string;
		priority: "must" | "should" | "could";
		evidence: string[];
	}[];
	missingRequirements: {
		id: string;
		text: string;
		priority: "must" | "should" | "could";
	}[];
	unsupportedGoals: {
		goalId: string;
		description: string;
	}[];
	evidenceGaps: {
		goalId: string;
		description: string;
		missingEvidence: string[];
	}[];
	incompleteSteps: {
		description: string;
		expected: string;
	}[];
	allowFinalize: boolean;
	blockReason: string | null;
	suggestions: string[];
}

// ========================================================================
// Layer 1: Request Parsing (heuristic-based, deterministic)
// ========================================================================

export function parseUserRequest(request: string): ParsedRequest {
	const requirements: ParsedRequirement[] = [];
	const acceptanceCriteria: string[] = [];
	let idCounter = 0;

	const lines = request
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 3);
	let inAcceptanceSection = false;

	const priorityKeywords = new Map<string, "must" | "should" | "could">([
		["must", "must"],
		["required", "must"],
		["need", "must"],
		["require", "must"],
		["have to", "must"],
		["should", "should"],
		["would be nice", "could"],
		["nice to have", "could"],
		["could", "could"],
		["optionally", "could"],
		["optional", "could"],
	]);

	for (const line of lines) {
		const lower = line.toLowerCase();

		// Section detection
		if (lower.includes("acceptance") || lower.includes("definition of done") || lower === "verify:") {
			inAcceptanceSection = true;
			continue;
		}

		const cleanLine = line
			.replace(/^[#\-*•\d.)]\s*/, "")
			.replace(/^(requirement|task):\s*/i, "")
			.trim();

		if (cleanLine.length === 0) continue;

		if (inAcceptanceSection) {
			acceptanceCriteria.push(cleanLine);
			continue;
		}

		let priority: "must" | "should" | "could" = "should";
		for (const [keyword, p] of priorityKeywords.entries()) {
			if (lower.startsWith(keyword)) {
				priority = p;
				break;
			}
		}

		const reqType: ParsedRequirement["type"] =
			lower.includes("constraint") || lower.includes("no ") || lower.includes("don't ") || lower.includes("not ")
				? "constraint"
				: lower.includes("perform") ||
						lower.includes("fast") ||
						lower.includes("quality") ||
						lower.includes("secure")
					? "non-functional"
					: "feature";

		requirements.push({
			id: `req-${++idCounter}`,
			text: cleanLine,
			priority,
			type: reqType,
		});
	}

	// Fallback: treat entire request as one must-have if parsing found nothing
	if (requirements.length === 0) {
		requirements.push({
			id: "req-1",
			text: request.trim(),
			priority: "must",
			type: "feature",
		});
	}

	return {
		requirements: requirements.slice(0, 20),
		acceptanceCriteria,
		originalText: request,
	};
}

// ========================================================================
// Layer 3: Coverage Computation (rule-based alignment check)
// ========================================================================

export function computeCoverage(args: {
	parsedRequest: ParsedRequest | null;
	goals: GoalAlignmentData[];
	plan?: PlanAlignmentData | null;
	minScore: number;
}): CoverageResult {
	const { parsedRequest, goals, plan, minScore } = args;
	const missingRequirements: CoverageResult["missingRequirements"] = [];
	const coveredRequirements: CoverageResult["coveredRequirements"] = [];
	const unsupportedGoals: CoverageResult["unsupportedGoals"] = [];
	const evidenceGaps: CoverageResult["evidenceGaps"] = [];
	const incompleteSteps: CoverageResult["incompleteSteps"] = [];
	const suggestions: string[] = [];

	if (!parsedRequest || parsedRequest.requirements.length === 0) {
		return {
			score: 0.5,
			totalRequirements: 0,
			coveredRequirements: [],
			missingRequirements: [
				{ id: "meta", text: "No parsed request — cannot validate alignment", priority: "should" },
			],
			unsupportedGoals,
			evidenceGaps,
			incompleteSteps,
			allowFinalize: true,
			blockReason: null,
			suggestions: ["No structured requirements. Validate manually before finalizing."],
		};
	}

	// Build map: requirement ID -> goals covering it
	const reqIdToGoals = new Map<string, GoalAlignmentData[]>();
	for (const goal of goals) {
		for (const reqId of goal.mapsToRequirements) {
			if (!reqIdToGoals.has(reqId)) reqIdToGoals.set(reqId, []);
			reqIdToGoals.get(reqId)!.push(goal);
		}
	}

	// Check each requirement
	for (const req of parsedRequest.requirements) {
		const coveringGoals = reqIdToGoals.get(req.id) || [];
		const completed = coveringGoals.filter((g) => g.status === "completed");

		if (completed.length > 0) {
			const evidence = completed.flatMap((g) => g.evidenceCollected);
			coveredRequirements.push({ id: req.id, text: req.text, priority: req.priority, evidence });

			if (req.priority === "must" && evidence.length === 0) {
				evidenceGaps.push({
					goalId: completed[0]?.description || req.id,
					description: `Must-have "${req.text}" completed but no evidence`,
					missingEvidence: generateVerificationHints(req.text),
				});
			}
		} else if (req.priority !== "could") {
			missingRequirements.push({ id: req.id, text: req.text, priority: req.priority });
		}
	}

	// Scope creep detection
	for (const goal of goals) {
		if (goal.status === "completed" && goal.mapsToRequirements.length === 0) {
			unsupportedGoals.push({ goalId: goal.id, description: goal.description });
		}
	}

	// Plan steps
	if (plan?.steps.length) {
		for (const step of plan.steps) {
			if (step.status !== "completed") {
				incompleteSteps.push({ description: step.description, expected: step.expectedOutcome });
			}
		}
	}

	// Weighted scoring
	const musts = parsedRequest.requirements.filter((r) => r.priority === "must");
	const shoulds = parsedRequest.requirements.filter((r) => r.priority === "should");
	const coulds = parsedRequest.requirements.filter((r) => r.priority === "could");

	const mustScore =
		musts.length > 0 ? coveredRequirements.filter((c) => musts.find((r) => r.id === c.id)).length / musts.length : 1;
	const shouldScore =
		shoulds.length > 0
			? coveredRequirements.filter((c) => shoulds.find((r) => r.id === c.id)).length / shoulds.length
			: 1;
	const couldScore =
		coulds.length > 0
			? coveredRequirements.filter((c) => coulds.find((r) => r.id === c.id)).length / coulds.length
			: 1;

	let weightedScore = 0.6 * mustScore + 0.3 * shouldScore + 0.1 * couldScore;

	const planRate = plan?.steps.length
		? plan.steps.filter((s) => s.status === "completed").length / plan.steps.length
		: 1;
	weightedScore = weightedScore * 0.7 + planRate * 0.3;

	const evidenceGapPenalty = Math.min(evidenceGaps.length * 0.1, 0.3);
	const incompleteStepsPenalty = Math.min(incompleteSteps.length * 0.05, 0.2);
	const score = Math.max(0, Math.min(1, weightedScore - evidenceGapPenalty - incompleteStepsPenalty));

	const mustMiss = missingRequirements.filter((r) => r.priority === "must");
	const shouldMiss = missingRequirements.filter((r) => r.priority === "should");
	const allowFinalize = score >= minScore && mustMiss.length === 0;
	const blockReason =
		mustMiss.length > 0
			? `Missing ${mustMiss.length} must-have requirement(s)`
			: score < minScore
				? `Coverage score ${score.toFixed(2)} below threshold ${minScore}`
				: null;

	if (mustMiss.length > 0)
		suggestions.push(
			`BLOCKED: ${mustMiss.length} must-have requirement(s) not covered:\n${mustMiss.map((r) => `  - ${r.text}`).join("\n")}`,
		);
	if (shouldMiss.length > 0)
		suggestions.push(
			`WARNING: ${shouldMiss.length} should-have(s) may not be covered:\n${shouldMiss.map((r) => `  - ${r.text}`).join("\n")}`,
		);
	if (unsupportedGoals.length > 0)
		suggestions.push(
			`NOTE: ${unsupportedGoals.length} completed goal(s) unmapped (scope creep?):\n${unsupportedGoals.map((g) => `  - ${g.description}`).join("\n")}`,
		);
	if (evidenceGaps.length > 0) suggestions.push(`WARNING: ${evidenceGaps.length} completed goal(s) lack evidence`);
	if (incompleteSteps.length > 0) suggestions.push(`WARNING: ${incompleteSteps.length} plan steps incomplete`);
	if (!allowFinalize) suggestions.push("\nAddress gaps above, then retry finalize().");

	return {
		score,
		totalRequirements: parsedRequest.requirements.length,
		coveredRequirements,
		missingRequirements,
		unsupportedGoals,
		evidenceGaps,
		incompleteSteps,
		allowFinalize,
		blockReason,
		suggestions,
	};
}

function generateVerificationHints(reqText: string): string[] {
	const lower = reqText.toLowerCase();
	const hints: string[] = [];
	if (lower.includes("test") || lower.includes("unit")) hints.push("Run: pytest / npm test / cargo test");
	if (lower.includes("api") || lower.includes("endpoint"))
		hints.push("Verify endpoint responds to valid/invalid input");
	if (lower.includes("ui") || lower.includes("frontend")) hints.push("Verify renders and handles edge cases");
	if (lower.includes("auth") || lower.includes("login")) hints.push("Verify: happy path + unauthorized blocked");
	if (lower.includes("db") || lower.includes("migration")) hints.push("Verify: migration runs, data preserved");
	if (hints.length === 0) hints.push("Run tests to verify correctness");
	return hints;
}

// ========================================================================
// Format coverage report
// ========================================================================

export function formatCoverageReport(result: CoverageResult): string {
	const lines: string[] = [];
	const emoji = result.score >= 0.8 ? "\u{1F7E2}" : result.score >= 0.5 ? "\u{1F7E1}" : "\u{1F534}";
	lines.push(`${emoji} Finalize Validation Report`);
	lines.push("");
	lines.push(`Coverage Score: ${result.score.toFixed(2)}`);
	lines.push(`Requirements: ${result.coveredRequirements.length}/${result.totalRequirements} covered`);
	lines.push("");

	if (result.missingRequirements.length > 0) {
		lines.push(`**Missing Requirements (${result.missingRequirements.length}):**`);
		for (const req of result.missingRequirements) {
			lines.push(`- [${req.priority}] ${req.text}`);
		}
		lines.push("");
	}
	if (result.evidenceGaps.length > 0) {
		lines.push(`**Evidence Gaps:**`);
		for (const gap of result.evidenceGaps) {
			lines.push(`- ${gap.description}`);
		}
		lines.push("");
	}
	if (result.unsupportedGoals.length > 0) {
		lines.push(`**Unmapped Goals:**`);
		for (const g of result.unsupportedGoals) {
			lines.push(`- ${g.description}`);
		}
		lines.push("");
	}

	if (result.blockReason) {
		lines.push(`\n\ud83d\udeab **FINALIZE BLOCKED:** ${result.blockReason}`);
		lines.push("");
		lines.push("Suggestions:");
		for (const s of result.suggestions) lines.push(`  ${s}`);
	} else {
		lines.push("\u2705 Validation passed — finalize approved.");
	}

	return lines.join("\n");
}
