# pi-braid Self-Improvement — Task Pool
**Date**: 2026-04-21
**Meta**: Extensions were written by naked agent → they suffered from same slop as raw LLM. We built harness-level nudge/assist extensions. Now pi-braid is sophisticated enough to bootstrap itself. Acceptable irony.

**Graduation rule**: Start task 1 → if agent handles well (clean code, correct, no confusion) → escalate. If degraded → split into smaller tasks.

---

## Task 1 (SMALL — Surgical) ✅ READY

### Fix degradation-detector type guard

**File**: `src/lib/degradation-detector.ts` line ~73

**Problem**: Semantic inversion type guard:
```typescript
function isCtx(val: unknown): val is ExtensionContext {
    return typeof val === "object" && val !== null && !("turnNumber" in val);
}
```
This checks that a property IS ABSENT from ExtensionContext. But what if PerformanceMetrics (which has turnNumber) is embedded in the val object? The check should be POSITIVE — check for properties ExtensionContext HAS, not properties it hasn't.

**Fix**: Use positive property check:
```typescript
function isCtx(val: unknown): val is ExtensionContext {
    return typeof val === "object" && val !== null && "tools" in val && "settingsManager" in val;
}
```
Also check line 77 for the `else return val` branch — that's the legacy `_global` fallback. Should log a warning when falling back.

**Verification**: grep for `"turnNumber" in` — should return nothing after fix.

---

## Task 2 (SMALL — Surgical) ✅ READY

### Add setInterval cleanup to evolve extension

**File**: `src/extensions/evolve/index.ts` lines ~73-76

**Problem**: `saveTimer` (setInterval) is never cleared when extension unloads. Memory leak.

**Fix**: Add unload handler:
```typescript
pi.on("unload", () => {
    if (saveTimer) {
        clearInterval(saveTimer);
        saveTimer = null;
    }
});
```

Also verify: does evolve use `let saveTimer` at module level? If yes, note it as module-level mutable state violation (C5 from audit).

**Verification**: grep for `saveTimer` — should show both setInterval AND clearInterval + unload handler.

---

## Task 3 (SMALL — Refactor) ✅ READY

### Remove safety extension + refactor its consumers

**Files**: `src/extensions/safety/` (entire directory)

**Problem**:
1. Uses text scraping anti-pattern (regex on raw text instead of structured state)
2. Functionally redundant with `enforcement` extension
3. `ctx.scratchpadGoal` accessed via regex parsing instead of `ctx.getState()`

**Fix**:
1. Delete `src/extensions/safety/` entirely
2. Check what consumers import it — should be none (enforcement handles context-aware safety)
3. If any consumer references `safety`, update to use `enforcement` or `ctx.getState()` instead

**Verification**: `ls src/extensions/safety/` should return nothing. `grep -r "safety" src/extensions/` should return nothing.

---

## Task 4 (MEDIUM — Refactor) ✅ READY

### Consolidate globalThis duplicate pattern (DRY violation)

**Files**: 3 copies of same pattern across codebase:
1. `src/extensions/polyfill/index.ts`
2. `src/lib/model-resolver.ts`
3. `src/extensions/context-manager/handlers/rotation.ts`

**Pattern**: Bytes-for-bytes identical `getCustomModelKeys()` using `Symbol.for("pi-braid:custom-model-keys")` on globalThis.

Also: `rotation.ts` has a SECOND pattern using string key `"__cmRotationState"` instead of Symbol — more vulnerable.

**Fix**:
1. Move the shared pattern to `src/lib/global-state.ts` as a utility
2. Import and use from all three locations
3. Replace string-key pattern in rotation.ts with Symbol

**Verification**: grep for `Symbol.for.*custom-model` — should appear only in global-state.ts, not in polyfill/model-resolver/rotation.

---

## Task 5 (MEDIUM — Design) ✅ READY

### Add `pi.on("unload", ...)` to ALL extensions with setInterval/setTimeout

**Files**: Every extension that uses setInterval or setTimeout at module level must clean up on unload.

**List to check**: evolve (done in task 2), watchdog, heartbeat-scheduler, analytics, feedback, latent-activator, reasoning, rate-limiter

**Fix**: For each extension with timers:
1. Find all `setInterval` / `setTimeout` calls
2. Add `pi.on("unload", ...)` that clears them
3. Track timer IDs in module-level vars (already exists for some — verify they're used)

**Verification**: `grep -r "setInterval\|setTimeout" src/extensions/` plus `grep -r "unload" src/extensions/` should match per extension.

---

## Task 6 (MEDIUM) ✅ READY

### Standardize tool error contract

**Problem**: Tools return inconsistent error formats — some `isError: true`, some `success: false`, some empty content with no error indicator.

**Impact**: Agent misinterprets silent failures as success.

**Fix**: For all tools that can fail, enforce:
```typescript
// On failure: MUST return isError: true with descriptive message
{
    isError: true,
    content: [{ type: "text", text: "ERROR: <reason> + suggested action" }]
}

// NEVER: { isError: false } with empty content
// NEVER: { content: [] } with no error flag
```

**Files to audit**: web-fetch, browser, docs (read_document, read_pdf_screenshot), bash (already has `isError`), analyze_image

**Verification**: Send a failing tool call and verify error format is consistent.

---

## Task 7 (LARGE — Refactor) 🔒 WAIT FOR TASKS 1-4

### Replace module-level mutable state → ctx.getState() pattern

**Files**: All 8+ extensions with module-level singletons:
- polyfill: `let _sessionManager`, `let _lastUserMessage`, `let saveTimer`
- degradation-detector: `let _global`
- cognitive-memory: `let _singletonInstance`
- browser: `let cdp`, `let connectedTabId`, module Map
- feedback: `let pendingWhisper`
- rate-limiter: `let isShuttingDown`, `const state = new Map()`
- watchdog: `const sessions = new Map()`
- reasoning: `let state: ExtensionState`

**Fix**: For each extension, move module-level state into a `ctx.getState()` pattern.

**Note**: This is a large refactor — do AFTER smaller tasks to calibrate agent performance.

**Verification**: `grep -r "^const state\|^let state\|^let _\|const sessions\|^let isShutting" src/extensions/` should return nothing after refactor.

---

## Task 8 (LARGE — Architecture) 🔒 WAIT FOR TASKS 1-6

### Remove monkey-patching from polyfill extension

**File**: `src/extensions/polyfill/index.ts` lines ~300-327

**Problem**: Directly mutates ExtensionAPI prototype at runtime:
```typescript
const originalGetBranch = api.getBranch.bind(api);
api.getBranch = function(...args) {
    const result = originalGetBranch(...args);
    if (result && typeof result === "string") {
        return result + " [pi-braid]";
    }
    return result;
};
```

**Fix**: Move branch name tagging to a wrapper that doesn't mutate the prototype. Either:
1. Store the original, wrap, and call original (recommended)
2. Or remove the feature entirely if it's not essential

**Verification**: grep for `prototype\|bind\(api\)` — should return nothing in polyfill.

---

## Task 9 (X-LARGE — Research) 🔒 SEPARATE SESSION

### Skill loading deep research

**Topics**:
- How pi resolves skill directories vs skill files
- When are SKILL.md files loaded vs when are just directories
- Can skills be conditional-loaded based on context (e.g., only load software-engineer when coding task detected)
- Can skills be layered (base skill + extension skill)
- How do skills interact with extensions (can extensions register skills?)
- Skill loading performance: how does it affect startup time?
- Can we optimize skill loading for large skill directories?
- The role of `.pi/` settings vs project `.pi/` vs global `~/.pi/`

**Deliverable**: `docs/SKILL-LOADING-RESEARCH.md` with findings + recommendations for improvement.

---

## Task Queue Status

| # | Task | Size | Status |
|---|------|------|--------|
| 1 | Fix degradation-detector type guard | SMALL | READY |
| 2 | Add setInterval cleanup to evolve | SMALL | READY |
| 3 | Remove safety extension | SMALL | READY |
| 4 | Consolidate globalThis duplicate | MEDIUM | READY |
| 5 | Add unload handlers to all extensions | MEDIUM | READY |
| 6 | Standardize tool error contract | MEDIUM | READY |
| 7 | Module-level mutable state refactor | LARGE | 🔒 After 1-6 |
| 8 | Remove polyfill monkey-patching | LARGE | 🔒 After 1-7 |
| 9 | Skill loading research | X-LARGE | 🔒 Separate session |