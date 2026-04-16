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
 * - Recursive sub-calls via ctx.subCall()
 * - No external processes spawned
 *
 * Note: For expressions that return values, use `return expr`.
 * Statements (const, if, for, etc.) work as-is without return.
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
	code: Type.String({ description: "JavaScript code to execute. For expressions that return values, use `return expr`. Statements (const, if, for) work as-is. In RLM mode, use 'ctx' to access context data." }),
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
	const items: unknown[] = Array.isArray(data) ? data : [];

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

	const searchText = (query: string): Array<{ item: unknown; score: number; matched: string }> => {
		const queryLower = query.toLowerCase();
		const results: Array<{ item: unknown; score: number; matched: string }> = [];

		const searchIn = (item: unknown): void => {
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
				Object.values(item as Record<string, unknown>).forEach(searchIn);
			}
		};

		searchIn(data);
		return results.sort((a, b) => b.score - a.score);
	};

	return {
		data,
		get length(): number {
			return items.length || (data !== null && data !== undefined ? 1 : 0);
		},
		get isEmpty(): boolean {
			return this.length === 0;
		},
		get items(): unknown[] {
			return items.length > 0 ? items : [data];
		},
		get(n: number): unknown {
			return this.items[n] ?? null;
		},
		first(n = 1): unknown[] {
			return this.items.slice(0, n);
		},
		last(n = 1): unknown[] {
			return this.items.slice(-n);
		},
		chunk(size: number): unknown[][] {
			const chunks: unknown[][] = [];
			for (let i = 0; i < this.items.length; i += size) {
				chunks.push(this.items.slice(i, i + size));
			}
			return chunks;
		},
		search(query: string) {
			return searchText(query);
		},
		filter(predicate: string | ((item: unknown) => boolean)): unknown[] {
			const arr = this.items;
			if (typeof predicate === "function") {
				return arr.filter(predicate as (item: unknown) => boolean);
			}
			try {
				const fn = new Function("item", `return ${predicate}`) as (item: unknown) => boolean;
				return arr.filter(fn);
			} catch {
				return arr;
			}
		},
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
		access(path: string): unknown {
			return safeAccess(data, path);
		},
		summary() {
			if (Array.isArray(data)) {
				return { type: "array", length: data.length, sample: data[0] };
			}
			if (data !== null && typeof data === "object") {
				const obj = data as Record<string, unknown>;
				return { type: "object", length: Object.keys(obj).length, keys: Object.keys(obj) };
			}
			return { type: typeof data, length: 1 };
		},
		depth,
		maxCalls,
		history: replState.rlmHistory,
		subCall(code: string): unknown {
			if (replState.rlmDepth >= maxCalls) {
				throw new Error(`Max recursion depth (${maxCalls}) exceeded`);
			}
			replState.rlmDepth++;
			try {
				const subCtx = createRlmContext(replState.lastResult, replState.rlmDepth, maxCalls);
				const fn = new Function("ctx", code);
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
			"Execute JavaScript code. Use `return expr` for expressions. Statements (const, if, for) work as-is. RLM mode provides ctx helpers: chunk(), search(), filter(), map(), reduce().",
		parameters: replSchema,
		execute: async (_toolCallId: string, params: ReplParams) => {
			replState.executionCount++;

			const mode = params.mode === "auto" ? (params.context !== undefined ? "rlm" : "simple") : params.mode ?? "simple";
			const maxCalls = params.max_calls ?? 10;
			const timeout = params.timeout_ms ?? 30000;

			if (mode === "rlm") {
				replState.rlmContext = params.context;
				replState.rlmDepth = 0;
				replState.rlmMaxCalls = maxCalls;
			}

			try {
				const evalKeys = Object.keys(replState.context);
				const evalValues = Object.values(replState.context);

				let ctxObj: ReturnType<typeof createRlmContext> | undefined;
				if (mode === "rlm") {
					ctxObj = createRlmContext(params.context, 0, maxCalls);
					evalKeys.push("ctx");
					evalValues.push(ctxObj);
				}

				// Simple approach: just eval the code as-is
				// For values, user writes `return expr`
				const evalFn = new Function(...evalKeys, params.code);

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

				if (mode === "rlm") {
					replState.rlmHistory.push({ code: params.code, result });
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

				replState.lastResult = result;

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
