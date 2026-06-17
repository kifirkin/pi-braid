> **⚠️ ARCHIVED — 2026-06-17**
>
> This document is preserved for historical reference. Its actionable
> content has been folded into [`docs/ROADMAP.md`](../ROADMAP.md). The
> recommendations here are either shipped, deferred, or superseded by
> items in the new roadmap. See the linked roadmap section for the
> current status of each item.

# Cast Audit — `as unknown as` Remnants

**Date:** 2026-06-17
**Audit method:** Subagent scan of `src/` for `as unknown as` patterns, filtered to exclude comments.
**Result:** 4 real casts remain (the subagent said 5; one was a comment reference).

## The 4 real casts

### 1. `src/extensions/cognitive/metacognition/handlers/claim-verification.ts:277`

```ts
} as unknown as ToolDefinition<any, any, any>);
```

**Type gap:** The `execute` function returns `Promise<Record<string, unknown>>` with a simpler `onUpdate` callback. pi's `ToolDefinition` wants `Promise<AgentToolResult<TDetails>>` + `AgentToolUpdateCallback`. A single `as` cast fails with "neither type sufficiently overlaps".

**What it bridges:** The tool's actual return shape (a simple `Record<string, unknown>`) vs pi's nominal `AgentToolResult` type with its full TDetails generic. The function is correct; the type system can't infer the equivalence.

**Fix path:** Wrap the return value in `{ content: [{ type: "text", text }], details: ... }` explicitly and return `Promise<AgentToolResult<...>>`. This is a type-system workaround, not a code change.

### 2. `src/extensions/memory/scratchpad/index.ts:896`

```ts
} as unknown as ToolDefinition<any, any, any>);
```

**Type gap:** Same as #1. The scratchpad's `execute` returns a simple object; pi's `ToolDefinition` wants the full AgentToolResult wrapper. Comment around it mentions the same issue.

**Fix path:** Same as #1. Refactor `scratchpadExecute` to return a fully-typed `Promise<AgentToolResult<unknown>>` (it already does at line ~640 — just need to remove the cast at the registration point).

### 3. `src/extensions/memory/scratchpad/persistence.ts:190`

```ts
return data as unknown as TaskScratchpad;
```

**Type gap:** `migrateScratchpad` receives `Record<string, unknown>` from `JSON.parse` and mutates it through 6 different field migrations before returning. The final object structurally matches `TaskScratchpad` but TypeScript can't verify that after the array spreads.

**Fix path:** Build a fresh `TaskScratchpad` object explicitly inside `migrateScratchpad` instead of mutating the input. This is straightforward but a refactor.

### 4. `src/lib/utils/extension-utils.ts:37`

```ts
const fn = (ctx as unknown as { getExtensionState?(key: string): unknown })?.getExtensionState;
```

**Type gap:** `getExtensionState` is a private method of the pi core's `ExtensionContext` that isn't in pi's published `.d.ts` files. We need to call it for internal helpers; pi's public type doesn't expose it.

**Fix path:** Add a thin typed wrapper in `lib/state/extension-state.ts` that does the cast internally once, then expose a clean public API. This is the canonical pattern: hide ugly casts in one place, expose clean types.

## Summary

All 4 casts are **genuine type-system gaps**, not bugs in the code. Three are pi's nominal type strictness (AgentToolResult wrapper); one is a private API. The right fix is to wrap each in a typed adapter:

| File | Cast | Wrappable? |
|---|---|---|
| `claim-verification.ts:277` | ToolDefinition nominal | Yes, ~10 lines |
| `scratchpad/index.ts:896` | ToolDefinition nominal | Yes, ~10 lines |
| `scratchpad/persistence.ts:190` | Migration return type | Yes, ~30 lines (build fresh object) |
| `extension-utils.ts:37` | Private pi API | Yes, ~5 lines (single wrapper) |

**Total fix size:** ~55 lines. Each can ship independently.
**Out of scope for this round** (the code works; the casts are documented). Pick up as a future cleanup if/when type errors force it.

## See also

- `src/AGENTS.md` — 4-way split rationale
- `docs/CODE-QUALITY-REMEDIATION-PLAN.md` — original cast-cleanup scope
