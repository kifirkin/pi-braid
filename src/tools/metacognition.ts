/**
 * Metacognition tools for self-assessment
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Metacognition } from "../lib/metacognition.js";

const selfAssessSchema = Type.Object({});

const requestHelpSchema = Type.Object({
	reason: Type.String(),
	context: Type.String(),
});

const errorPatternsSchema = Type.Object({});

export interface MetacognitionToolOptions {
	metacognition: Metacognition;
}

export function createMetacognitionTools(options: MetacognitionToolOptions): Record<string, AgentTool<any>> {
	const { metacognition } = options;

	const selfAssessTool: AgentTool<typeof selfAssessSchema> = {
		name: "self_assess",
		label: "Self Assess",
		description: "Assess confidence and performance metrics",
		parameters: selfAssessSchema,
		execute: async () => {
			const formatted = metacognition.formatAssessment();
			return {
				content: [{ type: "text" as const, text: formatted }],
				details: metacognition.getState(),
			};
		},
	};

	const requestHelpTool: AgentTool<typeof requestHelpSchema> = {
		name: "request_help",
		label: "Request Help",
		description: "Request human intervention when stuck",
		parameters: requestHelpSchema,
		execute: async (_toolCallId, params) => {
			return {
				content: [
					{ type: "text" as const, text: `🆘 Help requested: ${params.reason}` },
					{ type: "text" as const, text: `Context: ${params.context}` },
				],
				details: { reason: params.reason },
			};
		},
	};

	const errorPatternsTool: AgentTool<typeof errorPatternsSchema> = {
		name: "error_patterns",
		label: "Error Patterns",
		description: "Show recent error patterns",
		parameters: errorPatternsSchema,
		execute: async () => {
			const patterns = metacognition.getErrorPatterns();
			const lines = Array.from(patterns.entries()).map(([type, count]) => `${type}: ${count} occurrences`);

			return {
				content: [{ type: "text" as const, text: lines.join("\n") || "No error patterns recorded." }],
				details: Object.fromEntries(patterns),
			};
		},
	};

	return {
		self_assess: selfAssessTool,
		request_help: requestHelpTool,
		error_patterns: errorPatternsTool,
	};
}
