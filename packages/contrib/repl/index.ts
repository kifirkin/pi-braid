/**
 * REPL Extension — persistent JavaScript execution for the agent.
 *
 * Provides a `repl` tool that runs JavaScript and returns the value of the
 * last expression. State (`lastResult`, `rlmHistory`, `rlmContext`) persists
 * across calls in the same session.
 *
 * Auto-return: a top-level ExpressionStatement at the end of `code` is
 * wrapped in `return (...)` so the value flows back to the model. Existing
 * `return`/declaration/control-flow statements are left untouched.
 *
 *   const a = 1; const b = 2; a + b   →  returns 3
 *   Math.sqrt(16)                     →  returns 4
 *   const x = 5                       →  returns undefined (declaration, no value)
 *   if (cond) { ... }                 →  returns undefined
 *
 * Errors: thrown on parse/eval failure. The framework surfaces them to the
 * model. We do NOT encode errors in `content` — see AgentToolResult docs.
 *
 * `import`/`export` are not supported; use `require()` for Node builtins.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { createRequire } from "node:module";
import { parse as acornParse, type Program } from "acorn";

import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createLogger } from "../logger.js";
import { readToggleVerdict } from "../module-toggle.js";

const log = createLogger("repl");

/** The dynamic-function shape `new Function` produces in this module. */
type ReplCallable = (...args: unknown[]) => unknown;

// StringEnum polyfill (avoid depending on pi-ai internal helpers)

function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}

// Create require function for use inside Function() constructor in ESM context
const _require = createRequire(import.meta.url);

// Max files to load from a glob pattern
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

/**
 * Auto-return: if the top-level body ends in an ExpressionStatement, wrap
 * that expression in `return (...)`. This is what makes `const a = 1; a + 1`
 * return 2 instead of undefined, matching REPL conventions. Acorn skips
 * comments in the AST, so trailing `// comment` blocks remain in `prefix`.
 *
 * If parsing fails, we return the original code so `new Function` reports
 * the syntax error with its usual message.
 */
function autoReturn(code: string): string {
  let ast: Program;
  try {
    ast = acornParse(code, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return code;
  }
  if (!ast.body || ast.body.length === 0) return code;
  const last = ast.body[ast.body.length - 1];
  if (last.type !== "ExpressionStatement") return code;
  // Acorn's `end` for `x + 1;` includes the trailing semicolon. Strip
  // trailing whitespace/semicolons so we don't emit `return (x + 1;)`.
  let exprEnd = last.end;
  while (exprEnd > last.start && /[\s;]/.test(code[exprEnd - 1])) exprEnd--;
  const exprText = code.slice(last.start, exprEnd);
  const prefix = code.slice(0, last.start);
  return `${prefix}return (${exprText});`;
}

const replSchema = Type.Object({
  code: Type.String({
    description:
      "JavaScript code to execute. The value of the last expression statement " +
      "is auto-returned — no need to write `return` for simple cases. Statements " +
      "(const, if, for) work as-is. For explicit returns, use `return expr`. " +
      "Note: `await` is not supported — use `.then()` chains for async work. " +
      "In RLM mode, use 'ctx' to access context data. Use `lastResult` to access " +
      "the previous call's result. Note: `import` and `export` statements are " +
      "not supported — use `require()` for Node builtins or load data via the " +
      "`context` parameter.",
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
  cwd: Type.Optional(
    Type.String({ description: "Working directory for relative file paths" }),
  ),
  baseDir: Type.Optional(
    Type.String({ description: "Base directory for glob patterns" }),
  ),
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
    Type.Number({
      description: "Timeout in milliseconds (default: 30000)",
      default: 30000,
    }),
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

async function loadDataFromFile(
  filePath: string,
  baseDir?: string,
): Promise<unknown> {
  const resolvedPath = baseDir ? resolve(baseDir, filePath) : filePath;
  if (!existsSync(resolvedPath))
    throw new Error(`File not found: ${resolvedPath}`);
  return parseContent(await readFile(resolvedPath, "utf-8"));
}

// Local glob — keeps the tool dependency-free. Walks the tree and matches
// basenames. Not a full glob implementation; sufficient for typical use.
function globSync(
  pattern: string,
  opts: { cwd?: string; absolute?: boolean } = {},
): string[] {
  const dir = opts.cwd || ".";
  const results: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (e.includes(pattern.replace("*", "")) || pattern === "**/*")
        results.push(full);
    }
  };
  walk(dir);
  return results;
}

async function loadDataFromGlob(
  pattern: string,
  baseDir?: string,
): Promise<unknown> {
  const base = baseDir || ".";
  const files = globSync(pattern, { cwd: base, absolute: true });
  if (files.length === 0)
    throw new Error(`No files matching pattern: ${pattern} (in ${base})`);
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

async function resolveContext(
  context: unknown,
  cwd?: string,
  baseDir?: string,
): Promise<unknown> {
  if (context === undefined || context === null) return undefined;
  if (
    typeof context === "object" &&
    !Array.isArray(context) &&
    context !== null
  ) {
    const ctx = context as Record<string, unknown>;
    if (typeof ctx.pattern === "string")
      return loadDataFromGlob(
        ctx.pattern as string,
        (ctx.baseDir as string) || baseDir,
      );
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
      for (let i = 0; i < this.items.length; i += size)
        chunks.push(this.items.slice(i, i + size));
      return chunks;
    },
    search(query: string) {
      const queryLower = query.toLowerCase();
      const results: Array<{ item: unknown; score: number; matched: string }> =
        [];
      const searchIn = (item: unknown): void => {
        if (item === null || item === undefined) return;
        if (typeof item === "string") {
          const idx = item.toLowerCase().indexOf(queryLower);
          if (idx >= 0)
            results.push({
              item,
              score: queryLower.length / item.length,
              matched: item.slice(
                Math.max(0, idx - 20),
                idx + queryLower.length + 20,
              ),
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
        const fn = new Function("item", `return ${predicate}`) as (
          item: unknown,
        ) => boolean;
        return this.items.filter(fn);
      } catch {
        return this.items;
      }
    },
    map(transform: string | ((item: unknown) => unknown)): unknown[] {
      if (typeof transform === "function")
        return this.items.map(transform as (item: unknown) => unknown);
      try {
        const fn = new Function("item", `return ${transform}`) as (
          item: unknown,
        ) => unknown;
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
          ? this.items.reduce(
              reducer as (acc: unknown, item: unknown) => unknown,
              initial,
            )
          : this.items.reduce(
              reducer as (acc: unknown, item: unknown) => unknown,
            );
      try {
        const fn = new Function("acc", "item", `return ${reducer}`) as (
          acc: unknown,
          item: unknown,
        ) => unknown;
        return initial !== undefined
          ? this.items.reduce(fn, initial)
          : this.items.reduce(fn);
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
      if (Array.isArray(data))
        return { type: "array", length: data.length, sample: data[0] };
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
        const subCtx = createRlmContext(
          replState.lastResult,
          replState.rlmDepth,
          maxCalls,
        );
        let fn: ReplCallable;
        try {
          fn = new Function("ctx", "require", code) as unknown as ReplCallable;
        } catch (err: unknown) {
          if (err instanceof SyntaxError && /import|export/.test(err.message)) {
            throw new Error(
              "subCall does not support `import` or `export` statements. " +
                "Use require() or access data via ctx.",
              { cause: err },
            );
          }
          throw new Error(
            `Failed to parse subCall code: ${(err as Error).message}`,
            { cause: err },
          );
        }
        return fn(subCtx, _require);
      } finally {
        replState.rlmDepth--;
      }
    },
  };
}

function formatResult(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "function")
    return `[Function: ${(value as { name?: string }).name || "anonymous"}]`;
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
  if (typeof value === "function")
    return `[Function: ${(value as { name?: string }).name || "anonymous"}]`;
  if (typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }
  return value;
}

// Detect if code ends with a non-expression statement (declaration, if, for, etc.)
// so we can hint when the result is undefined.
function _lastStatementIsNonExpression(code: string): boolean {
  try {
    const ast = acornParse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
    });
    if (!ast.body || ast.body.length === 0) return false;
    const last = ast.body[ast.body.length - 1];
    return last.type !== "ExpressionStatement";
  } catch {
    return false;
  }
}

// Verbose result for content (user-visible output) — shows code executed + result
function formatVerbose(
  result: unknown,
  count: number,
  code: string,
  _mode: string,
): string {
  const prefix = `[repl #${count}]`;
  const codePreview = code.length > 60 ? code.slice(0, 60) + "..." : code;
  if (result === undefined) {
    let msg = `${prefix} ${codePreview} => undefined`;
    if (_lastStatementIsNonExpression(code)) {
      msg +=
        "\n(Tip: result is undefined because the code ends with a declaration or control-flow statement. " +
        "Add an expression at the end — e.g. `const x = 5; x` — to return a value.)";
    }
    return msg;
  }
  if (result === null) return `${prefix} ${codePreview} => null`;
  if (typeof result === "function")
    return `${prefix} ${codePreview} => [Function: ${(result as { name?: string }).name || "anonymous"}]`;
  if (typeof result === "object") {
    try {
      return `${prefix} ${codePreview} =>
${JSON.stringify(result, null, 2)}`;
    } catch {
      return `${prefix} ${codePreview} => ${String(result)}`;
    }
  }
  return `${prefix} ${codePreview} => ${String(result)}`;
}

function createReplTool() {
  const tool: ToolDefinition<any, any, any> = {
    name: "repl",
    exposure: "deferred",
    label: "REPL",
    promptSnippet:
      "Execute JS; auto-returns last expression. Add trailing expr for value (const x=5; x returns 5)",
    description:
      "Execute JavaScript code. The value of the last expression statement is auto-returned " +
      "(so `const a = 1; a + 1` returns 2). Use `return expr` for explicit early returns. " +
      "RLM mode provides ctx helpers (chunk, search, filter, map, reduce). " +
      "Context: inline data, file path (auto-detects JSON/JSONL/text), or { pattern, baseDir } for glob. " +
      "Note: `await`/`import`/`export` not supported — use `.then()` for async, " +
      "require() for Node builtins, or load data via context. " +
      "IMPORTANT: if the last statement is NOT an expression (e.g. a const/let/var declaration or " +
      "if/for/while block), the result is undefined. Add a trailing expression to return a value.",
    parameters: replSchema,
    execute: async (_toolCallId: string, params: any) => {
      if (typeof params.code !== "string" || params.code.trim() === "") {
        throw new Error(
          "repl: `code` parameter is required and must be a non-empty string",
        );
      }
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

      const resolvedData = await resolveContext(
        params.context,
        params.cwd,
        params.baseDir,
      );
      if (mode === "rlm") replState.rlmContext = resolvedData;

      const evalKeys = [
        ...Object.keys(replState.context),
        "lastResult",
        "require",
      ];
      const evalValues = [
        ...Object.values(replState.context),
        replState.lastResult,
        _require,
      ];
      let ctxObj: ReturnType<typeof createRlmContext> | undefined;
      if (mode === "rlm" && resolvedData !== undefined) {
        ctxObj = createRlmContext(resolvedData, 0, maxCalls);
        evalKeys.push("ctx");
        evalValues.push(ctxObj);
      }

      // Auto-return: wrap the last expression statement in `return (...)`
      // so `const a = 1; a + 1` returns 2 instead of undefined. This is the
      // single most common "the REPL ate my result" footgun.
      const code = autoReturn(params.code);

      // Note: `await` is NOT supported because `new Function` produces a
      // non-async function. Wrapping in an async IIFE would support `await`
      // but leaks the event loop if the user code never resolves (e.g. an
      // infinite async loop). Stick with sync semantics; users can chain
      // `.then()` if they need async.
      let evalFn: ReplCallable;
      try {
        evalFn = new Function(...evalKeys, code) as unknown as ReplCallable;
      } catch (err: unknown) {
        if (err instanceof SyntaxError && /import|export/.test(err.message)) {
          throw new Error(
            "The REPL tool does not support `import` or `export` statements. " +
              "Use `require()` (CommonJS) for Node.js builtin modules, or load data via the `context` parameter. " +
              "Node.js builtins (fs, path, os) are always available via require(). " +
              "Third-party modules are not available in the REPL — load their output via context instead.",
            { cause: err },
          );
        }
        throw new Error(`Failed to parse code: ${(err as Error).message}`, {
          cause: err,
        });
      }

      const codePreview =
        params.code.length > 40
          ? params.code.slice(0, 40) + "..."
          : params.code;
      log.info(
        `#${replState.executionCount} ${mode}: ${codePreview.replace(/\s+/g, " ")}`,
      );

      let result: unknown;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Execution timed out after ${timeout}ms`)),
          timeout,
        );
      });
      const evalPromise = (async () => {
        try {
          result = await evalFn(...evalValues);
          return result;
        } catch (err: unknown) {
          if (
            err &&
            typeof err === "object" &&
            (err as { code?: string }).code ===
              "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING"
          ) {
            throw new Error(
              "Dynamic import() is not supported in the REPL tool. " +
                "Use require() for Node.js builtin modules or load data via the context parameter.",
              { cause: err },
            );
          }
          throw err;
        }
      })();
      try {
        await Promise.race([evalPromise, timeoutPromise]);
      } finally {
        // Clear the timer so we don't keep the event loop alive for a
        // no-op reject after the eval has already completed.
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }

      if (mode === "rlm") {
        replState.rlmHistory.push({ code: params.code, result });
        if (replState.rlmHistory.length > 500)
          replState.rlmHistory = replState.rlmHistory.slice(-500);
      }
      replState.lastResult = result;

      return {
        content: [
          {
            type: "text" as const,
            text: formatVerbose(
              result,
              replState.executionCount,
              params.code,
              mode,
            ),
          },
        ],
        details: {
          execution: replState.executionCount,
          mode,
          code: params.code,
          result: formatForDetails(result),
          resultPreview: formatResult(result),
          ...(ctxObj ? { contextSummary: ctxObj.summary() } : {}),
        },
      };
    },
  };
  return tool;
}

export default function replExtension(pi: ExtensionAPI): void {
  const toggle = readToggleVerdict(["repl"]);
  if (toggle.disabled) {
    log.info(
      `[repl] disabled via settings (braid.contrib.${toggle.key}: false).`,
    );
    return;
  }

  const replTool = createReplTool();
  pi.registerTool(replTool);
  log.info("REPL extension registered.");
}
