# pi-braid Self-Bootstrapping — Subagent Task 1

## Your Role

You are a surgical code improvement agent. You work on a single, small, well-defined task at a time. You are methodical, precise, and verify your changes.

## Target File

`/Users/kifir/projects/agents/pi-braid/src/lib/degradation-detector.ts`

## Problem

The `isCtx()` type guard at line ~73 uses **semantic inversion** — it checks for a property that SHOULD be absent, not one that should be present:

```typescript
function isCtx(val: unknown): val is ExtensionContext {
  return typeof val === "object" && val !== null && !("turnNumber" in val);
}
```

This checks: "val is NOT a PerformanceMetrics object (which has turnNumber)". But:

1. The logic is backwards — we should check what ExtensionContext IS, not what it isn't
2. If PerformanceMetrics ever embeds differently, the check silently breaks
3. The "turnNumber" check is a negative assertion about a DIFFERENT type, not a positive assertion about ExtensionContext

Also check line ~77 — the `else return val` branch falls back to `_global` without warning. That fallback should log: `console.warn("[degradation-detector] No ExtensionContext available, using global state")`

## Your Task

1. Read the full file `/Users/kifir/projects/agents/pi-braid/src/lib/degradation-detector.ts`
2. Fix the `isCtx()` type guard to use **positive property checks** for properties ExtensionContext actually has (like "tools" and "settingsManager")
3. Add a warning log for the `_global` fallback
4. Show me the exact before/after for the `isCtx` function
5. Run these verification commands and report results:
   - `grep -n '"turnNumber" in' /Users/kifir/projects/agents/pi-braid/src/lib/degradation-detector.ts`
   - `grep -n '"tools" in val' /Users/kifir/projects/agents/pi-braid/src/lib/degradation-detector.ts`
   - `grep -n 'console.warn.*degradation' /Users/kifir/projects/agents/pi-braid/src/lib/degradation-detector.ts`

## Rules

- Make the MINIMAL surgical fix — don't refactor unrelated code
- Don't change indentation style
- Don't rename variables unless necessary for the fix
- Verify the TypeScript compiles if possible
- Report back with exact diff of changes

## Success Criteria

- `isCtx()` uses positive property checks (properties ExtensionContext HAS)
- No more `!("turnNumber" in val)` pattern
- `_global` fallback logs a warning
- File still compiles

Start now.
