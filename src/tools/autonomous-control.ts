/**
 * Autonomous Control Tools
 *
 * Tools for controlling autonomous mode:
 * - signal_complete: Signal that work is complete and verified
 * - signal_stuck: Signal that agent is stuck and needs help
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

export interface AutonomousControlOptions {
	onComplete?: () => void;
	onStuck?: (reason: string) => void;
}

const signalCompleteSchema = Type.Object({
	verification: Type.String({
		description: "What was verified to confirm work is complete",
	}),
});

const signalStuckSchema = Type.Object({
	reason: Type.String({
		description: "Why you are stuck and what you tried",
	}),
});

/**
 * Create autonomous control tools.
 */
export function createAutonomousControlTools(options: AutonomousControlOptions): Record<string, AgentTool<any>> {
	const signalComplete: AgentTool<typeof signalCompleteSchema> = {
		name: "signal_complete",
		label: "Signal Complete",
		description: `Signal that ALL work is complete and verified.
Use this ONLY when:
1. All tasks are done
2. Tests pass
3. Build succeeds
4. You have verified end-to-end

Do NOT use this if you are uncertain or if there are open issues.`,
		parameters: signalCompleteSchema,
		execute: async (_toolCallId: string, params: { verification: string }) => {
			options.onComplete?.();
			return {
				content: [
					{
						type: "text" as const,
						text: `Work marked as complete.\nVerification: ${params.verification}\n\nAwaiting user input for next task.`,
					},
				],
				details: { complete: true, verification: params.verification },
			};
		},
	};

	const signalStuck: AgentTool<typeof signalStuckSchema> = {
		name: "signal_stuck",
		label: "Signal Stuck",
		description: `Signal that you are stuck and need help.
Use this when:
1. You've tried multiple approaches and none work
2. You need clarification on requirements
3. You've hit a fundamental blocker

Provide a clear reason and what you tried.`,
		parameters: signalStuckSchema,
		execute: async (_toolCallId: string, params: { reason: string }) => {
			options.onStuck?.(params.reason);
			return {
				content: [
					{
						type: "text" as const,
						text: `Stuck signal sent.\nReason: ${params.reason}\n\nAwaiting user assistance.`,
					},
				],
				details: { stuck: true, reason: params.reason },
			};
		},
	};

	return {
		signal_complete: signalComplete,
		signal_stuck: signalStuck,
	};
}
