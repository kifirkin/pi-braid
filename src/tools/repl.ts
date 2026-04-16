/**
 * REPL Tool - Native TypeScript/JavaScript REPL with RLM Support
 *
 * Dual-mode execution:
 * - Simple mode: Execute code directly
 * - RLM mode: Context-aware execution for Recursive Language Models
 *
 * Context sources (everything is a file):
 * - Inline data (array or object)
 * - File path (string) - auto-detects JSON/JSONL/text
 * - Glob pattern: { pattern, baseDir } for loading multiple files
 *
 * Usage patterns:
 *   repl(code: "return ctx.length", context: "/path/to/data.json")
 *   repl(code: "ctx.search('error')", context: "/path/to/log.jsonl")
 *   repl(code: "ctx.chunk(10)", context: { pattern: "md-files", baseDir: "." })
 *   repl(code: "return [1,2,3].filter(x => x > 1)", context: [...inlineData])
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { readFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { globSync } from "glob";

// Maximum files to load from a glob pattern
const MAX_GLOB_FILES = 1000;

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

/** Reset all REPL state to initial values */
function resetReplState(): void {
	replState.context = {};
	replState.executionCount = 0;
	replState.lastResult = undefined;
	replState.rlmContext = undefined;
	replState.rlmHistory = [];
	replState.rlmDepth = 0;
	replState.rlmMaxCalls = 10;
}

// Schema for dual-mode REPL
const replSchema = Type.Object({
	code: Type.String({
		description:
			"JavaScript code to execute. For expressions that return values, use `return expr`. Statements (const, if, for) work as-is. In RLM mode, use 'ctx' to access context data. Use `lastResult` to access the previous call's result.",
	}),
	reset: Type.Optional(Type.Boolean({ description: "Reset all REPL state (lastResult, rlmHistory) before executing. Default: false.", default: false })),
	context: Type.Optional(
		Type.Any({
			description:
				"Context data for RLM mode. Can be: inline data (array/object), file path (string - auto-detects JSON/JSONL/text), or { pattern, baseDir } for glob patterns.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for relative file paths" })),
	baseDir: Type.Optional(Type.String({ description: "Base directory for glob patterns" })),
	mode: Type.Optional(
		Type.Union([Type.Literal("simple"), Type.Literal("rlm"), Type.Literal("auto")], {
			description: "Execution mode: 'simple' = direct eval, 'rlm' = context-aware, 'auto' = auto-detect (default: auto)",
			default: "auto",
		}),
	),
	max_calls: Type.Optional(Type.Number({ description: "Max recursive sub-calls per RLM invocation (default: 10)", default: 10 })),
	timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)", default: 30000 })),
});

type ReplParams = {
	code: string;
	reset?: boolean;
	context?: unknown;
	cwd?: string;
	baseDir?: string;
	mode?: "simple" | "rlm" | "auto";
	max_calls?: number;
	timeout_ms?: number;
};

/**
 * Parse content, auto-detecting format:
 * - JSONL (lines starting with { or [) → split into array
 * - JSON → parse as object/array
 * - Plain text → split by newlines into array
 */
function parseContent(content: string): unknown {
	const trimmed = content.trim();

	// Detect JSONL: multiple lines, each parseable as JSON
	if (trimmed.includes("\n{") || trimmed.includes("\n[")) {
		const lines = trimmed.split("\n").filter((l) => l.trim());
		if (lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } })) {
			return lines.map((l) => JSON.parse(l));
		}
	}

	// Try JSON
	try {
		return JSON.parse(trimmed);
	} catch {
		// Plain text - split by newlines
		const lines = trimmed.split("\n").filter((l) => l.trim());
		return lines.length > 1 ? lines : trimmed;
	}
}

/**
 * Load data from a file path, auto-detecting format.
 */
function loadDataFromFile(filePath: string, baseDir?: string): unknown {
	const resolvedPath = baseDir ? resolve(baseDir, filePath) : filePath;

	if (!existsSync(resolvedPath)) {
		throw new Error(`File not found: ${resolvedPath}`);
	}

	const content = readFileSync(resolvedPath, "utf-8");
	return parseContent(content);
}

/**
 * Load data from a glob pattern.
 */
function loadDataFromGlob(pattern: string, baseDir?: string): unknown {
	const base = baseDir || ".";
	const files = globSync(pattern, { cwd: base, absolute: true });

	if (files.length === 0) {
		throw new Error(`No files matching pattern: ${pattern} (in ${base})`);
	}

	if (files.length > MAX_GLOB_FILES) {
		throw new Error(`Too many files (${files.length}) matching pattern: ${pattern}. Limit: ${MAX_GLOB_FILES}`);
	}

	const contents = files.map((file) => {
		const content = readFileSync(file, "utf-8");
		return { path: relative(base, file), content: parseContent(content) };
	});

	return contents;
}

/**
 * Resolve context to actual data.
 * - String → file path (load & parse)
 * - Object with `pattern` → glob load
 * - Otherwise → use as-is (inline data)
 */
function resolveContext(context: unknown, cwd?: string, baseDir?: string): unknown {
	if (context === undefined || context === null) {
		return undefined;
	}

	// Object with pattern (glob mode)
	if (typeof context === "object" && !Array.isArray(context) && context !== null) {
		const ctx = context as Record<string, unknown>;
		if (typeof ctx.pattern === "string") {
			return loadDataFromGlob(ctx.pattern as string, (ctx.baseDir as string) || baseDir);
		}
		return context;
	}

	// File path (string)
	if (typeof context === "string") {
		return loadDataFromFile(context, cwd);
	}

	// Already data - return as-is
	return context;
}

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
				// User must write `return expr` for sub-call values too
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
			"Execute JavaScript code. Use `return expr` for values. RLM mode provides ctx helpers (chunk, search, filter, map, reduce). Context: inline data, file path (auto-detects JSON/JSONL/text), or { pattern, baseDir } for glob.",
		parameters: replSchema,
		execute: async (_toolCallId: string, params: ReplParams) => {
			// Reset state if requested
			if (params.reset) {
				resetReplState();
			}

			replState.executionCount++;

			const mode = params.mode === "auto" ? (params.context !== undefined ? "rlm" : "simple") : params.mode ?? "simple";
			const maxCalls = params.max_calls ?? 10;
			const timeout = params.timeout_ms ?? 30000;

			if (mode === "rlm") {
				replState.rlmDepth = 0;
				replState.rlmMaxCalls = maxCalls;
			}

			try {
				// Resolve context data (file path, glob, or inline)
				const resolvedData = resolveContext(params.context, params.cwd, params.baseDir);

				if (mode === "rlm") {
					replState.rlmContext = resolvedData;
				}

				const evalKeys = Object.keys(replState.context);
				const evalValues = Object.values(replState.context);

				// Always expose lastResult so agents can chain calls
				evalKeys.push("lastResult");
				evalValues.push(replState.lastResult);

				let ctxObj: ReturnType<typeof createRlmContext> | undefined;
				if (mode === "rlm" && resolvedData !== undefined) {
					ctxObj = createRlmContext(resolvedData, 0, maxCalls);
					evalKeys.push("ctx");
					evalValues.push(ctxObj);
				}

				// Eval the code as-is. User writes `return expr` for values.
				const evalFn = new Function(...evalKeys, params.code);

				let result: unknown;

				const timeoutPromise = new Promise<never>((_, reject) => {
					setTimeout(() => {
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

				// Note: variable persistence across calls is limited since new Function()
				// creates isolated scope. Variables declared with const/let won't persist.
				// For stateful operations, store results in replState.lastResult or
				// use RLM history.

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