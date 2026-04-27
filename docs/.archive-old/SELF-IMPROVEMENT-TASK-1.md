# TASK 1 — Fix Degradation-Detector Type Guard

## Target File

`/Users/kifir/projects/agents/pi-braid/src/lib/degradation-detector.ts`

## Problem

The `isCtx()` type guard at line ~73 uses **semantic inversion** — it checks for a property that SHOULD be absent, not one that should be present. This is fragile and confusing:

```typescript
function isCtx(val: unknown): val is ExtensionContext {
    return typeof val === "object" && val !== null && !("turnNumber" in val);
}
```

This checks: "val is NOT a PerformanceMetrics object (which has turnNumber)". But:
1. The logic is backwards — we should check what ExtensionContext IS, not what it isn't
2. If PerformanceMetrics ever embeds differently, the check silently breaks
3. The "turnNumber" check is a negative assertion about a DIFFERENT type, not a positive assertion about ExtensionContext

## Fix

Replace with **positive property checks** for properties ExtensionContext actually has:

```typescript
function isCtx(val: unknown): val is ExtensionContext {
    return typeof val === "object" && val !== null && "tools" in val && "settingsManager" in val;
}
```

Also check line ~77 — there's a `else return val` branch that falls back to the global `_global` when ctx isn't available. That fallback should log a warning: `console.warn("[degradation-detector] No ExtensionContext available, using global state")`

## Verification

After your fix:
1. `grep -n '"turnNumber" in' src/lib/degradation-detector.ts` — should return nothing
2. `grep -n '"tools" in val' src/lib/degradation-detector.ts` — should show the new check
3. Verify the TypeScript type guard still compiles: `npx tsc --noEmit src/lib/degradation-detector.ts` (if tsconfig exists)

## Instructions

1. Read the full file first
2. Make the minimal surgical fix — don't refactor unrelated code
3. Show me the exact changes made (diff or before/after)
4. Run the verification commands
5. Report back

This is a TINY surgical task. Do it cleanly.