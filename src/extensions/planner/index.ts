/**
 * Planner Extension
 *
 * Unified planning system: tasks, goals, plans, execution control, and coordination tools.
 * Merges what was previously spread across cognitive-systems, standalone tools, and the old
 * enforcement-style plan tool.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { GoalManager } from "../../lib/goal-manager.js";
import { Planner } from "../../lib/planner.js";


import { createGoalTool } from "../../tools/goals.js";
import { createPlanTool } from "../../tools/planning.js";

// Shared state
const state = {
	goalManager: new GoalManager(),
	planner: new Planner(),
};

export default function plannerExtension(pi: ExtensionAPI) {
	// Goal tool (consolidated from 6 tools to 1)
	const goalTool = createGoalTool({ manager: state.goalManager });
	pi.registerTool({
		name: goalTool.name,
		label: goalTool.label,
		description: goalTool.description,
		parameters: goalTool.parameters,
		execute: async (toolCallId, params) => goalTool.execute(toolCallId, params, {} as any),
	});

	// Plan tool (consolidated from 7 tools to 1)
	const planTool = createPlanTool({ planner: state.planner });
	pi.registerTool({
		name: planTool.name,
		label: planTool.label,
		description: planTool.description,
		parameters: planTool.parameters,
		execute: async (toolCallId, params) => planTool.execute(toolCallId, params, {} as any),
	});

	// Retry command - abort and trigger new turn
	pi.registerCommand("retry", {
		description: "Retry the last agent turn (abort and retry)",
		handler: async (_args, ctx) => {
			ctx.abort();
			// Trigger a new turn after abort
			pi.sendMessage(
				{
					customType: "retry",
					content: [{ type: "text" as const, text: "" }],
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});
}
