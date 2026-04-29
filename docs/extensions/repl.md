# Extension: repl

**Status**: ✅ Working
**Tests**: None
**Version**: v0.7.x

## Purpose

Interactive JavaScript evaluation — the `repl` tool evaluates JS code with optional RLM (Read-Loop-Modify) context mode. Supports file context loading, glob patterns, lastResult chaining, and timeout control.

## Architecture

Dual-mode execution:

- **Simple mode** — direct `eval()` of JS expressions. Auto-wraps bare expressions in `return`.
- **RLM mode** — context-aware execution with `ctx` helpers: `chunk()`, `search()`, `filter()`, `map()`, `reduce()`, `access()`, `summary()`.

Context auto-detection: JSONL → split+parse, JSON → parse, text → split by newlines.

## Events Handled

None — the tool is called directly by the agent.

## Tools

| Tool   | Description                                                                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repl` | Execute JavaScript. Params: `code`, `reset` (clear state), `context` (file/glob/inline data), `mode` (simple/rlm/auto), `max_calls`, `timeout_ms`. Returns evaluation result as string. |

## Key Patterns

- **Bare expression wrapping**: `42` → `return 42` automatically (unless code already starts with `return`).
- **LastResult chaining**: Previous `repl` result available as `lastResult`. Reset via `reset:true`.
- **Context loading**: File path → auto-detect JSON/JSONL/text. Glob pattern → load multiple files. Inline data → use directly.
- **Timeout protection**: Configurable timeout (default 30s) prevents infinite loops.
