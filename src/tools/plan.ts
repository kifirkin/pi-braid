/**
 * Debug Plan Tool
 *
 * MUST be called before editing code to fix a bug.
 * Forces: multiple hypotheses, test-first debugging, verification.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

const debugPlanSchema = Type.Object({
	expected: Type.String({
		description: "What is the EXPECTED behavior (quote from issue/docs)",
	}),
	actual: Type.String({
		description: "What is the ACTUAL behavior (observed in code/run)",
	}),
	difference: Type.String({
		description: "What is the DIFFERENCE between expected and actual",
	}),
	hypothesis_1: Type.String({
		description: "FIRST possible root cause: 'The bug might be X because Y'",
	}),
	hypothesis_1_location: Type.String({
		description: "File and line number for hypothesis 1",
	}),
	hypothesis_2: Type.String({
		description: "SECOND possible root cause in a DIFFERENT file/module: 'OR the bug might be A because B'",
	}),
	hypothesis_2_location: Type.String({
		description: "File and line number for hypothesis 2 - MUST be different file from hypothesis 1",
	}),
	test_case: Type.String({
		description: "Test case that reproduces the bug (code or command)",
	}),
	verification: Type.String({
		description: "How to verify which hypothesis is correct (what to check/run)",
	}),
	chosen_hypothesis: Type.String({
		description: "Which hypothesis is correct after verification: 1 or 2",
	}),
	fix_plan: Type.String({
		description: "Proposed fix based on verified hypothesis",
	}),
});

type DebugPlanInput = {
	expected: string;
	actual: string;
	difference: string;
	hypothesis_1: string;
	hypothesis_1_location: string;
	hypothesis_2: string;
	hypothesis_2_location: string;
	test_case: string;
	verification: string;
	chosen_hypothesis: string;
	fix_plan: string;
};

const debugPlanDescription = "REQUIRED before fixing bugs. MUST provide: 2+ hypotheses, test case, verification.";

export function createPlanTool(): AgentTool<typeof debugPlanSchema> {
	return {
		name: "plan",
		label: "Debug Plan",
		description: debugPlanDescription,
		parameters: debugPlanSchema,
		execute: async (_toolCallId: string, params: DebugPlanInput) => {
			const {
				expected,
				actual,
				difference,
				hypothesis_1,
				hypothesis_1_location,
				hypothesis_2,
				hypothesis_2_location,
				test_case,
				verification,
				chosen_hypothesis,
				fix_plan,
			} = params;
			return {
				content: [
					{
						type: "text" as const,
						text: `Debug plan recorded:\n\nEXPECTED: ${expected}\nACTUAL: ${actual}\nDIFFERENCE: ${difference}\n\nHYPOTHESIS 1: ${hypothesis_1}\n  Location: ${hypothesis_1_location}\n\nHYPOTHESIS 2: ${hypothesis_2}\n  Location: ${hypothesis_2_location}\n\nTEST CASE: ${test_case}\n\nVERIFICATION: ${verification}\n\nCHOSEN: Hypothesis ${chosen_hypothesis}\n\nFIX PLAN: ${fix_plan}`,
					},
				],
				details: {
					expected,
					actual,
					difference,
					hypothesis_1,
					hypothesis_1_location,
					hypothesis_2,
					hypothesis_2_location,
					test_case,
					verification,
					chosen_hypothesis,
					fix_plan,
				},
			};
		},
	};
}
