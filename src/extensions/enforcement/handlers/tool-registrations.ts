/**
 * Tool registrations - enforcement_status, enforcement_reset
 */
import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getEscalationLevel } from "../escalation.js";
import { resetState, state } from "../state.js";

const enforcementStatusSchema = Type.Object({});

const enforcementResetSchema = Type.Object({});

/** Register enforcement tools on the extension API */
export function registerEnforcementTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "enforcement_status",
		label: "Enforcement Status",
		description:
			"Get current enforcement state and validation results. Shows turn history, validation failures, and tool sequence patterns.",
		parameters: enforcementStatusSchema,
		execute: async (): Promise<AgentToolResult<Record<string, unknown>>> => {
			const lines: string[] = ["## Enforcement Status"];
			lines.push("");
			lines.push(`**Current Turn:** ${state.currentTurn}`);
			lines.push(`**Enforcement Active:** ${state.enforcementActive}`);
			lines.push(`**Validation Failures:** ${state.validationFailures}`);
			lines.push(`**Silent Turns:** ${state.silentTurns}`);
			lines.push(`**Turns Since Memory:** ${state.turnsSinceMemory}`);
			lines.push("");

			// Agentic Loop Metrics
			lines.push("### Agentic Loop Metrics");
			lines.push(`**Claim/Verification Ratio:** ${state.claimsWithoutVerification}:${state.verificationsDone}`);
			lines.push(`**Has Recalled on Start:** ${state.hasRecalledOnStart}`);
			lines.push(`**Total Tool Calls:** ${state.totalToolCalls}`);
			lines.push(`**Bash Calls (verifications):** ${state.bashCalls}`);
			lines.push(
				`**Memory Analysis Count:** ${state.memoryAnalysisCount} (ratio: ${(state.toolAnalysisRatio * 100).toFixed(0)}%)`,
			);
			lines.push(`**Last Analysis Turn:** ${state.currentTurn - state.lastAnalysisTurn} turns ago`);
			lines.push("");
			lines.push("### Escalation Counts");
			const escalations = Object.entries(state.escalationCounts).filter(([, v]) => v > 0);
			if (escalations.length > 0) {
				for (const [type, count] of escalations) {
					const level = getEscalationLevel(count);
					lines.push(`- ${type}: ${count} (${level})`);
				}
			} else {
				lines.push("- No escalations yet");
			}
			lines.push("");

			lines.push("### Configuration");
			lines.push(`- Require Reasoning: ${state.config.requireReasoning}`);
			lines.push(`- Require Plan: ${state.config.requirePlan}`);
			lines.push(`- Enforce Scratchpad: ${state.config.enforceScratchpad}`);
			lines.push(`- Enforce Memory: ${state.config.enforceMemory}`);
			lines.push(`- Enforce Memory Nudge (force exec): ${state.config.enforceMemoryNudge}`);
			lines.push(`- Memory Nudge Threshold: ${state.config.memoryNudgeThreshold} turns`);
			lines.push(`- Enforce Verification Before Finalize: ${state.config.enforceVerificationBeforeFinalize}`);
			lines.push(`- Enforce Memory Recall on Start: ${state.config.enforceMemoryRecallOnStart}`);
			lines.push(`- Track Claims/Verifications: ${state.config.trackClaimsVsVerifications}`);
			lines.push(`- Max Claims Before Warning: ${state.config.maxClaimsBeforeVerification}`);
			lines.push(`- Max Silent Turns: ${state.config.maxSilentTurns}`);
			lines.push("");
			lines.push("### Recent Tool Sequences");
			for (const seq of state.recentToolSequences.slice(-5)) {
				lines.push(`- ${seq.join(" → ")}`);
			}
			lines.push("");

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					currentTurn: state.currentTurn,
					validationFailures: state.validationFailures,
					silentTurns: state.silentTurns,
					turnsSinceMemory: state.turnsSinceMemory,
					totalToolCalls: state.totalToolCalls,
					finalizeBlocked: state.finalizeBlocked,
					claimsWithoutVerification: state.claimsWithoutVerification,
					verificationsDone: state.verificationsDone,
					hasRecalledOnStart: state.hasRecalledOnStart,
					config: state.config,
					recentSequences: state.recentToolSequences.slice(-10),
				},
			};
		},
	});

	// enforcement_config moved to /enforcement-config command (admin only)

	pi.registerTool({
		name: "enforcement_reset",
		label: "Reset Enforcement State",
		description: "Reset all enforcement state including turn history, sequence patterns, and failure counts.",
		parameters: enforcementResetSchema,
		execute: async (): Promise<AgentToolResult<{ reset: boolean }>> => {
			resetState();
			return {
				content: [{ type: "text" as const, text: "Enforcement state reset." }],
				details: { reset: true },
			};
		},
	});
}
