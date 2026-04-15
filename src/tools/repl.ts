/**
 * REPL Tool - Native TypeScript/JavaScript REPL
 *
 * Provides a persistent REPL environment running in the agent's own process:
 * - Execute JavaScript/TypeScript code via eval()
 * - State persists between calls (variables, functions, imports)
 * - No external processes spawned
 * - Native to pi-agent itself
 *
 * State persists in closure — shared across all repl calls within a session.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

// Shared state across all REPL calls in this session
const replState = {
	context: {} as Record<string, unknown>,
	executionCount: 0,
	lastResult: undefined as unknown,
};

const replSchema = Type.Object({
	code: Type.String({ description: "TypeScript/JavaScript code to execute. State persists between calls." }),
	timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)", default: 30000 })),
});

export function createReplTool(): AgentTool<typeof replSchema> {
	return {
		name: "repl",
		label: "REPL",
		description:
			"Execute TypeScript/JavaScript code in the agent's native context. State (variables, functions) persists between calls. Use to test hypotheses, explore data, verify logic before fixing.",
		parameters: replSchema,
		execute: async (_toolCallId: string, params: { code: string; timeout_ms?: number }) => {
			replState.executionCount++;

			try {
				// Build eval context with previous state
				const evalKeys = Object.keys(replState.context);
				const evalValues = Object.values(replState.context);

				// Create a function with the context bound
				const evalFn = new Function(
					...evalKeys,
					`"use strict";\n${params.code}`,
				);

				// Execute with timeout
				const timeout = params.timeout_ms ?? 30000;
				let result: unknown;
				let timedOut = false;

				const timeoutPromise = new Promise<never>((_, reject) => {
					setTimeout(() => {
						timedOut = true;
						reject(new Error(`Execution timed out after ${timeout}ms`));
					}, timeout);
				});

				const evalPromise = (async () => {
					result = await evalFn(...evalValues);
					return result;
				})();

				try {
					await Promise.race([evalPromise, timeoutPromise]);
				} catch (e) {
					if (timedOut) throw e;
					// Eval errors are thrown, catch them below
					throw e;
				}

				// Extract new variables from the code and update context
				// Handles: let x = ..., const y = ..., var z = ..., function foo() {}
				const varPattern = /^(?:let|const|var)\s+(\w+)\s*=|^function\s+(\w+)\s*\(/gm;
				let match;
				while ((match = varPattern.exec(params.code)) !== null) {
					const name = match[1] || match[2];
					try {
						replState.context[name] = (replState.context as any)[name];
					} catch {
						// Skip if not accessible
					}
				}

				// Update lastResult
				replState.lastResult = result;

				// Format output
				let output = formatResult(result);

				return {
					content: [{ type: "text" as const, text: output }],
					details: {
						execution: replState.executionCount,
						result: formatForDetails(result),
					},
				};
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
					details: {
						error: message,
						execution: replState.executionCount,
					},
				};
			}
		},
	};
}

function formatResult(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value === "function") return `[Function: ${(value as Function).name || "anonymous"}]`;
	if (typeof value === "object") {
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

function formatForDetails(value: unknown): unknown {
	if (value === undefined || value === null) return value;
	if (typeof value === "function") return `[Function: ${(value as Function).name || "anonymous"}]`;
	if (typeof value === "object") {
		try {
			return JSON.parse(JSON.stringify(value));
		} catch {
			return String(value);
		}
	}
	return value;
}
