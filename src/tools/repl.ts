/**
 * REPL Tool - Native TypeScript/JavaScript REPL with RLM Support
 *
 * Dual-mode execution:
 * - Simple mode: Execute code directly (legacy behavior)
 * - RLM mode: Context-aware execution for Recursive Language Models
 *
 * Features:
 * - Execute JavaScript/TypeScript code via eval()
 * - State persists between calls (variables, functions)
 * - RLM helpers: ctx.chunk(), ctx.search(), ctx.filter(), ctx.map(), ctx.reduce()
 * - Recursive sub-calls via ctx.call()
 * - No external processes spawned
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
	rlmContext: undefined as unknown,
	rlmHistory: [] as Array<{ code: string; result: unknown }>,
	rlmDepth: 0,
	rlmMaxCalls: 10,
};

// Schema for dual-mode REPL
const replSchema = Type.Object({
	code: Type.String({ description: "JavaScript code to execute. In RLM mode, use 'ctx' to access context data." }),
	context: Type.Optional(Type.Any({ description: "Context data for RLM mode (documents, conversation, etc.). Automatically stored as 'ctx' in the REPL." })),
	mode: Type.Optional(
		Type.Union([Type.Literal("simple"), Type.Literal("rlm"), Type.Literal("auto")], {
			description: "Execution mode: 'simple' = direct eval, 'rlm' = context-aware with helpers, 'auto' = auto-detect based on context parameter (default: auto)",
			default: "auto",
		}),
	),
	max_depth: Type.Optional(Type.Number({ description: "Maximum recursion depth for RLM sub-calls (default: 3)", default: 3 })),
	max_calls: Type.Optional(Type.Number({ description: "Maximum number of recursive sub-calls per RLM invocation (default: 10)", default: 10 })),
	timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)", default: 30000 })),
});

type ReplParams = {
	code: string;
	context?: unknown;
	mode?: "simple" | "rlm" | "auto";
	max_depth?: number;
	max_calls?: number;
	timeout_ms?: number;
};

/**
 * Create an RLM context object that provides helpers for working with context data.
 */
function createRlmContext(data: unknown, depth: number, maxCalls: number) {
	// Track if we're processing an array-like object
	const items: unknown[] = Array.isArray(data) ? data : [];

	// Helper to safely access nested properties
	const safeAccess = (obj: unknown, path: string): unknown => {
		try {
			const parts = path.split(".");
			let current: unknown = obj;
			for (const part of parts) {
				if (current === null || current === undefined) return undefined;
				current = (current as Record<string, unknown>)[part];
			}
			return current;
		} catch {
			return undefined;
		}
	};

	// Helper to search in text content
	const searchText = (query: string, threshold = 0.3): unknown[] => {
		const queryLower = query.toLowerCase();
		const results: Array<{ item: unknown; score: number; matched: string }> = [];

		const searchIn = (item: unknown, path = ""): void => {
			if (item === null || item === undefined) return;
			if (typeof item === "string") {
				const lower = item.toLowerCase();
				const idx = lower.indexOf(queryLower);
				if (idx >= 0) {
					results.push({
						item,
						score: queryLower.length / lower.length,
						matched: item.slice(Math.max(0, idx - 20), idx + queryLower.length + 20),
					});
				}
			} else if (typeof item === "object") {
				const obj = item as Record<string, unknown>;
				for (const [key, value] of Object.entries(obj)) {
					searchIn(value, path ? `${path}.${key}` : key);
				}
			}
		};

		searchIn(data);
		return results.sort((a, b) => b.score - a.score);
	};

	return {
		/** The raw context data */
		data,

		/** Number of items in array-like context, or 1 for object context */
		get length(): number {
			return items.length || (data !== null && data !== undefined ? 1 : 0);
		},

		/** Check if context has data */
		get isEmpty(): boolean {
			return this.length === 0;
		},

		/** Get all items as array */
		get items(): unknown[] {
			return items.length > 0 ? items : [data];
		},

		/** Get item at index */
		get(n: number): unknown {
			const arr = this.items;
			return arr[n] ?? null;
		},

		/** Get first N items */
		first(n = 1): unknown[] {
			return this.items.slice(0, n);
		},

		/** Get last N items */
		last(n = 1): unknown[] {
			return this.items.slice(-n);
		},

		/** Split context into chunks of given size */
		chunk(size: number): unknown[][] {
			const arr = this.items;
			const chunks: unknown[][] = [];
			for (let i = 0; i < arr.length; i += size) {
				chunks.push(arr.slice(i, i + size));
			}
			return chunks;
		},

		/** Search for text in context (returns matches with context) */
		search(query: string): Array<{ item: unknown; score: number; matched: string }> {
			return searchText(query) as Array<{ item: unknown; score: number; matched: string }>;
		},

		/** Filter items using a predicate function (as string for eval) */
		filter(predicate: string | ((item: unknown) => boolean)): unknown[] {
			const arr = this.items;
			if (typeof predicate === "function") {
				return arr.filter(predicate as (item: unknown) => boolean);
			}
			// If predicate is a string, try to evaluate it with `item` variable
			try {
				const fn = new Function("item", `return ${predicate}`) as (item: unknown) => boolean;
				return arr.filter(fn);
			} catch {
				return arr; // Return all on error
			}
		},

		/** Map/transform items */
		map(transform: string | ((item: unknown) => unknown)): unknown[] {
			const arr = this.items;
			if (typeof transform === "function") {
				return arr.map(transform as (item: unknown) => unknown);
			}
			try {
				const fn = new Function("item", `return ${transform}`) as (item: unknown) => unknown;
				return arr.map(fn);
			} catch {
				return arr;
			}
		},

		/** Reduce/aggregate items to single value */
		reduce(reducer: string | ((acc: unknown, item: unknown) => unknown), initial?: unknown): unknown {
			const arr = this.items;
			if (typeof reducer === "function") {
				return initial !== undefined
					? arr.reduce(reducer as (acc: unknown, item: unknown) => unknown, initial)
					: arr.reduce(reducer as (acc: unknown, item: unknown) => unknown);
			}
			try {
				const fn = new Function("acc", "item", `return ${reducer}`) as (acc: unknown, item: unknown) => unknown;
				return initial !== undefined ? arr.reduce(fn, initial) : arr.reduce(fn);
			} catch {
				return initial;
			}
		},

		/** Access nested property by path (e.g., "results.0.name") */
		access(path: string): unknown {
			return safeAccess(data, path);
		},

		/** Create a summary of the context structure */
		summary(): { type: string; length: number; keys?: string[]; sample?: unknown } {
			if (Array.isArray(data)) {
				return {
					type: "array",
					length: data.length,
					sample: data[0],
				};
			}
			if (data !== null && typeof data === "object") {
				const obj = data as Record<string, unknown>;
				return {
					type: "object",
					length: Object.keys(obj).length,
					keys: Object.keys(obj),
					sample: obj[Object.keys(obj)[0]],
				};
			}
			return {
				type: typeof data,
				length: 1,
			};
		},

		/** Current recursion depth */
		depth,

		/** Maximum allowed calls */
		maxCalls,

		/** History of previous RLM operations */
		history: replState.rlmHistory,

		/** Execute a sub-call (for recursive processing) */
		subCall(code: string): unknown {
			if (replState.rlmDepth >= maxCalls) {
				throw new Error(`Max recursion depth (${maxCalls}) exceeded`);
			}
			replState.rlmDepth++;
			try {
				// Create a new context with current result as data
				const subCtx = createRlmContext(replState.lastResult, replState.rlmDepth, maxCalls);
				const fn = new Function("ctx", `"use strict";\nreturn ${code}`);
				return fn(subCtx);
			} finally {
				replState.rlmDepth--;
			}
		},
	};
}

export function createReplTool(): AgentTool<typeof replSchema> {
	return {
		name: "repl",
		label: "REPL",
		description:
			"Execute JavaScript code in the agent's native context. Supports dual-mode: Simple mode (direct eval) or RLM mode (context-aware with ctx helpers for recursive processing). Use 'ctx' object in RLM mode to access context.chunk(), ctx.search(), ctx.filter(), ctx.map(), ctx.reduce().",
		parameters: replSchema,
		execute: async (_toolCallId: string, params: ReplParams) => {
			replState.executionCount++;

			// Determine mode
			const mode = params.mode === "auto" ? (params.context !== undefined ? "rlm" : "simple") : params.mode ?? "simple";
			const maxCalls = params.max_calls ?? 10;
			const timeout = params.timeout_ms ?? 30000;

			// Set RLM state if in RLM mode
			if (mode === "rlm") {
				replState.rlmContext = params.context;
				replState.rlmDepth = 0;
				replState.rlmMaxCalls = maxCalls;
			}

			try {
				// Build eval context with previous state
				const evalKeys = Object.keys(replState.context);
				const evalValues = Object.values(replState.context);

				// Create the ctx object for RLM mode
				let ctxObj: ReturnType<typeof createRlmContext> | undefined;
				if (mode === "rlm") {
					ctxObj = createRlmContext(params.context, 0, maxCalls);
					evalKeys.push("ctx");
					evalValues.push(ctxObj);
				}

				// Prepare code - wrap in return if needed
				// Only preserve 'return' prefix; bare expressions always need wrapping
				const trimmed = params.code.trim();
				const needsWrap = !trimmed.startsWith("return ");
				const code = needsWrap ? `return ${params.code}` : params.code;

				// Auto-wrap bare objects/arrays in parentheses to avoid ambiguity with blocks
				// e.g., `return ({ name: "x" })` instead of `return { name: "x" }`
				const wrappedCode = needsWrap && (trimmed.startsWith("{") || trimmed.startsWith("["))
					? code.replace(/^return /, "return (").replace(/\}$/, ")}")
					: code;

				const evalFn = new Function(...evalKeys, `"use strict";\n${wrappedCode}`);

				// Execute with timeout
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

				await Promise.race([evalPromise, timeoutPromise]);

				// Record in RLM history if applicable
				if (mode === "rlm") {
					replState.rlmHistory.push({ code: params.code, result });
					// Keep history bounded
					if (replState.rlmHistory.length > 100) {
						replState.rlmHistory = replState.rlmHistory.slice(-100);
					}
				}

				// Extract new variables from the code
				const varPattern = /^(?:let|const|var)\s+(\w+)\s*=|^function\s+(\w+)\s*\(/gm;
				let match;
				while ((match = varPattern.exec(params.code)) !== null) {
					const name = match[1] || match[2];
					try {
						replState.context[name] = (replState.context as Record<string, unknown>)[name];
					} catch {
						// Skip if not accessible
					}
				}

				// Update lastResult
				replState.lastResult = result;

				// Format output
				const output = formatResult(result);

				return {
					content: [{ type: "text" as const, text: output }],
					details: {
						execution: replState.executionCount,
						mode,
						result: formatForDetails(result),
						...(ctxObj ? { contextSummary: ctxObj.summary() } : {}),
					},
				};
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
					details: {
						error: message,
						execution: replState.executionCount,
						mode,
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
