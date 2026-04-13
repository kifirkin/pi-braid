/**
 * Resource management tools for budget tracking
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ResourceManager } from "../lib/resource-manager.js";

const setBudgetSchema = Type.Object({
	maxTokens: Type.Optional(Type.Number()),
	maxCost: Type.Optional(Type.Number()),
	maxTime: Type.Optional(Type.Number()),
});

const checkResourcesSchema = Type.Object({});

const recordUsageSchema = Type.Object({
	tokens: Type.Number(),
	cost: Type.Number(),
});

export interface ResourceToolOptions {
	resourceManager: ResourceManager;
}

export function createResourceTools(options: ResourceToolOptions): Record<string, AgentTool<any>> {
	const { resourceManager } = options;

	const setBudgetTool: AgentTool<typeof setBudgetSchema> = {
		name: "set_budget",
		label: "Set Budget",
		description: "Set resource budget for operation",
		parameters: setBudgetSchema,
		execute: async (_toolCallId, params) => {
			const budget = resourceManager.setBudget(params);
			return {
				content: [
					{ type: "text" as const, text: `Budget set:` },
					{ type: "text" as const, text: `- Tokens: ${budget.maxTokens.toLocaleString()}` },
					{ type: "text" as const, text: `- Cost: $${budget.maxCost.toFixed(2)}` },
					{ type: "text" as const, text: `- Time: ${Math.floor(budget.maxTime / 60000)} minutes` },
				],
				details: budget,
			};
		},
	};

	const checkResourcesTool: AgentTool<typeof checkResourcesSchema> = {
		name: "check_resources",
		label: "Check Resources",
		description: "Check current resource usage",
		parameters: checkResourcesSchema,
		execute: async () => {
			const formatted = resourceManager.formatStatus();
			const status = resourceManager.checkStatus();
			return {
				content: [{ type: "text" as const, text: formatted }],
				details: {
					canContinue: resourceManager.canContinue(),
					isWarning: status.isWarning,
					isExhausted: status.isExhausted,
				},
			};
		},
	};

	const recordUsageTool: AgentTool<typeof recordUsageSchema> = {
		name: "record_usage",
		label: "Record Usage",
		description: "Record token/cost usage manually",
		parameters: recordUsageSchema,
		execute: async (_toolCallId, params) => {
			resourceManager.recordUsage(params.tokens, params.cost);
			const status = resourceManager.checkStatus();
			return {
				content: [{ type: "text" as const, text: `Recorded: ${params.tokens} tokens, $${params.cost.toFixed(4)}` }],
				details: {
					tokenRatio: status.tokenRatio,
					costRatio: status.costRatio,
				},
			};
		},
	};

	return {
		set_budget: setBudgetTool,
		check_resources: checkResourcesTool,
		record_usage: recordUsageTool,
	};
}
