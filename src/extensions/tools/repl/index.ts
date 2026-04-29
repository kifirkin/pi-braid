import { createLogger } from "../../../lib/logger.js";

const log = createLogger("repl");
/**
 * REPL Extension - Native TypeScript/JavaScript code execution
 *
 * Provides a `repl` tool for running TypeScript/JavaScript code with
 * persistent state between calls within a session. Native to pi-agent.
 *
 * Code inlined from ../../tools/repl.ts
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { globSync } from "glob";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

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

function resetReplState(): void {
  replState.context = {};
  replState.executionCount = 0;
  replState.lastResult = undefined;
  replState.rlmContext = undefined;
  replState.rlmHistory = [];
  replState.rlmDepth = 0;
  replState.rlmMaxCalls = 10;
}

const replSchema = Type.Object({
  code: Type.String({
    description:
      "JavaScript code to execute. For expressions that return values, use `return expr`. Statements (const, if, for) work as-is. In RLM mode, use 'ctx' to access context data. Use `lastResult` to access the previous call's result.",
  }),
  reset: Type.Optional(
    Type.Boolean({
      description:
        "Reset all REPL state (lastResult, rlmHistory) before executing. Default: false.",
      default: false,
    }),
  ),
  context: Type.Optional(
    Type.Any({
      description:
        "Context data for RLM mode. Can be: inline data (array/object), file path (string - auto-detects JSON/JSONL/text), or { pattern, baseDir } for glob patterns.",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for relative file paths" })),
  baseDir: Type.Optional(Type.String({ description: "Base directory for glob patterns" })),
  mode: Type.Optional(
    StringEnum(["simple", "rlm", "auto"], {
      description:
        "Execution mode: 'simple' = direct eval, 'rlm' = context-aware, 'auto' = auto-detect (default: auto)",
      default: "auto",
    }),
  ),
  max_calls: Type.Optional(
    Type.Number({
      description: "Max recursive sub-calls per RLM invocation (default: 10)",
      default: 10,
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Number({ description: "Timeout in milliseconds (default: 30000)", default: 30000 }),
  ),
});

function parseContent(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.includes("\n{") || trimmed.includes("\n[")) {
    const lines = trimmed.split("\n").filter((l) => l.trim());
    if (
      lines.every((l) => {
        try {
          JSON.parse(l);
          return true;
        } catch {
          return false;
        }
      })
    ) {
      return lines.map((l) => JSON.parse(l));
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split("\n").filter((l) => l.trim());
    return lines.length > 1 ? lines : trimmed;
  }
}

async function loadDataFromFile(filePath: string, baseDir?: string): Promise<unknown> {
  const resolvedPath = baseDir ? resolve(baseDir, filePath) : filePath;
  if (!existsSync(resolvedPath)) throw new Error(`File not found: ${resolvedPath}`);
  return parseContent(await readFile(resolvedPath, "utf-8"));
}

async function loadDataFromGlob(pattern: string, baseDir?: string): Promise<unknown> {
  const base = baseDir || ".";
  const files = globSync(pattern, { cwd: base, absolute: true });
  if (files.length === 0) throw new Error(`No files matching pattern: ${pattern} (in ${base})`);
  if (files.length > MAX_GLOB_FILES)
    throw new Error(
      `Too many files (${files.length}) matching pattern: ${pattern}. Limit: ${MAX_GLOB_FILES}`,
    );
  return await Promise.all(
    files.map(async (file) => ({
      path: relative(base, file),
      content: parseContent(await readFile(file, "utf-8")),
    })),
  );
}

async function resolveContext(context: unknown, cwd?: string, baseDir?: string): Promise<unknown> {
  if (context === undefined || context === null) return undefined;
  if (typeof context === "object" && !Array.isArray(context) && context !== null) {
    const ctx = context as Record<string, unknown>;
    if (typeof ctx.pattern === "string")
      return loadDataFromGlob(ctx.pattern as string, (ctx.baseDir as string) || baseDir);
    return context;
  }
  if (typeof context === "string") return loadDataFromFile(context, cwd);
  return context;
}

function createRlmContext(data: unknown, depth: number, maxCalls: number) {
  const items: unknown[] = Array.isArray(data) ? data : [];
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
      for (let i = 0; i < this.items.length; i += size) chunks.push(this.items.slice(i, i + size));
      return chunks;
    },
    search(query: string) {
      const queryLower = query.toLowerCase();
      const results: Array<{ item: unknown; score: number; matched: string }> = [];
      const searchIn = (item: unknown): void => {
        if (item === null || item === undefined) return;
        if (typeof item === "string") {
          const idx = item.toLowerCase().indexOf(queryLower);
          if (idx >= 0)
            results.push({
              item,
              score: queryLower.length / item.length,
              matched: item.slice(Math.max(0, idx - 20), idx + queryLower.length + 20),
            });
        } else if (typeof item === "object")
          Object.values(item as Record<string, unknown>).forEach(searchIn);
      };
      searchIn(data);
      return results.sort((a, b) => b.score - a.score);
    },
    filter(predicate: string | ((item: unknown) => boolean)): unknown[] {
      if (typeof predicate === "function")
        return this.items.filter(predicate as (item: unknown) => boolean);
      try {
        const fn = new Function("item", `return ${predicate}`) as (item: unknown) => boolean;
        return this.items.filter(fn);
      } catch {
        return this.items;
      }
    },
    map(transform: string | ((item: unknown) => unknown)): unknown[] {
      if (typeof transform === "function")
        return this.items.map(transform as (item: unknown) => unknown);
      try {
        const fn = new Function("item", `return ${transform}`) as (item: unknown) => unknown;
        return this.items.map(fn);
      } catch {
        return this.items;
      }
    },
    reduce(
      reducer: string | ((acc: unknown, item: unknown) => unknown),
      initial?: unknown,
    ): unknown {
      if (typeof reducer === "function")
        return initial !== undefined
          ? this.items.reduce(reducer as (acc: unknown, item: unknown) => unknown, initial)
          : this.items.reduce(reducer as (acc: unknown, item: unknown) => unknown);
      try {
        const fn = new Function("acc", "item", `return ${reducer}`) as (
          acc: unknown,
          item: unknown,
        ) => unknown;
        return initial !== undefined ? this.items.reduce(fn, initial) : this.items.reduce(fn);
      } catch {
        return initial;
      }
    },
    access(path: string): unknown {
      try {
        let current: unknown = data;
        for (const part of path.split(".")) {
          if (current === null || current === undefined) return undefined;
          current = (current as Record<string, unknown>)[part];
        }
        return current;
      } catch {
        return undefined;
      }
    },
    summary() {
      if (Array.isArray(data)) return { type: "array", length: data.length, sample: data[0] };
      if (data !== null && typeof data === "object")
        return {
          type: "object",
          length: Object.keys(data as Record<string, unknown>).length,
          keys: Object.keys(data as Record<string, unknown>),
        };
      return { type: typeof data, length: 1 };
    },
    depth,
    maxCalls,
    history: replState.rlmHistory,
    subCall(code: string): unknown {
      if (replState.rlmDepth >= maxCalls)
        throw new Error(`Max recursion depth (${maxCalls}) exceeded`);
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

function createReplTool(): AgentTool<typeof replSchema> {
  return {
    name: "repl",
    label: "REPL",
    description:
      "Execute JavaScript code. Use `return expr` for values. RLM mode provides ctx helpers (chunk, search, filter, map, reduce). Context: inline data, file path (auto-detects JSON/JSONL/text), or { pattern, baseDir } for glob.",
    parameters: replSchema,
    execute: async (_toolCallId: string, params: any) => {
      if (params.reset) resetReplState();
      replState.executionCount++;
      const mode =
        params.mode === "auto"
          ? params.context !== undefined
            ? "rlm"
            : "simple"
          : (params.mode ?? "simple");
      const maxCalls = params.max_calls ?? 10;
      const timeout = params.timeout_ms ?? 30000;
      if (mode === "rlm") {
        replState.rlmDepth = 0;
        replState.rlmMaxCalls = maxCalls;
      }

      const resolvedData = await resolveContext(params.context, params.cwd, params.baseDir);
      if (mode === "rlm") replState.rlmContext = resolvedData;

      const evalKeys = [...Object.keys(replState.context), "lastResult"];
      const evalValues = [...Object.values(replState.context), replState.lastResult];
      let ctxObj: ReturnType<typeof createRlmContext> | undefined;
      if (mode === "rlm" && resolvedData !== undefined) {
        ctxObj = createRlmContext(resolvedData, 0, maxCalls);
        evalKeys.push("ctx");
        evalValues.push(ctxObj);
      }

      const evalFn = new Function(...evalKeys, params.code);
      let result: unknown;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Execution timed out after ${timeout}ms`)), timeout),
      );
      const evalPromise = (async () => {
        try {
          result = await evalFn(...evalValues);
          return result;
        } catch (err: any) {
          if (err?.code === "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING") {
            throw new Error(
              "Dynamic import() is not supported in the REPL tool. " +
                "Use static imports at the top of your code or access values via the context parameter.",
            );
          }
          throw err;
        }
      })();
      await Promise.race([evalPromise, timeoutPromise]);

      if (mode === "rlm") {
        replState.rlmHistory.push({ code: params.code, result });
        if (replState.rlmHistory.length > 100)
          replState.rlmHistory = replState.rlmHistory.slice(-100);
      }
      replState.lastResult = result;

      return {
        content: [{ type: "text" as const, text: formatResult(result) }],
        details: {
          execution: replState.executionCount,
          mode,
          result: formatForDetails(result),
          ...(ctxObj ? { contextSummary: ctxObj.summary() } : {}),
        },
      };
    },
  };
}

export default function replExtension(pi: any) {
  const replTool = createReplTool();
  pi.registerTool({
    name: replTool.name,
    label: replTool.label,
    description: replTool.description,
    parameters: replTool.parameters,
    execute: replTool.execute,
  });
}
