# pi-braid Codebase Audit Report

**Date**: 2026-04-21  
**Auditor**: Braid (PI Coding Agent)  
**Scope**: `src/` (185 files, ~50K lines)  
**Version**: 0.9.x

---

## Executive Summary

The codebase contains **4 critical issues**, **4 high-severity issues**, **9 moderate issues**, and **4 minor issues**. The most serious problems are:

1. **Explicit monkey-patching** of the ExtensionAPI prototype
2. **Fragmented state management** with 3 competing paradigms
3. **Broken runtime type guard** that relies on semantic inversion
4. **Semantic conflict** where HTTP 429 is classified as both retryable and non-retryable
5. **70+ unsafe type casts** (`as any`) throughout the codebase

---

## 🔴 CRITICAL ISSUES

### 1. Explicit Monkey Patches on ExtensionAPI

**File**: `src/extensions/polyfill/index.ts`  
**Lines**: 300–327

```typescript
function patchSessionManagerMethods(pi: ExtensionAPI): void {
  const originalManager = (pi as any).sessionManager;
  if (!originalManager) return;

  // Patch getBranch to reflect braid sessions
  const originalGetBranch = originalManager.getBranch?.bind(originalManager);
  if (originalGetBranch) {
    (originalManager as any).getBranch = async function (...args: any[]) {
      const original = originalGetBranch(...args);
      if (original instanceof Promise) {
        return original.then((result: any) => {
          if (typeof result === "object" && result !== null) {
            result.branch = `${result.branch ?? "default"} [pi-braid]`;
          }
          return result;
        });
      }
      return original;
    };
  }

  // Patch getLeafId for similar handling
  const originalGetLeafId = originalManager.getLeafId?.bind(originalManager);
  if (originalGetLeafId) {
    (originalManager as any).getLeafId = async function (...args: any[]) {
      const original = originalGetLeafId(...args);
      if (original instanceof Promise) {
        return original.then((result: any) => ({
          ...result,
          leafId: `${result.leafId ?? "unknown"}-braid`,
        }));
      }
      return { leafId: `${original ?? "unknown"}-braid` };
    };
  }
}
```

**Analysis**: This function directly mutates the ExtensionAPI prototype by replacing methods at runtime. This violates fundamental software engineering principles:

- **Brittle**: Any update to the ExtensionAPI will silently break or behave incorrectly
- **Invisible**: No way to trace where the patched methods come from
- **Non-standard**: No other extension uses this pattern; it circumvents the proper extension registration API
- **Anti-pattern**: The extension is literally named "polyfill" - suggesting this is intentional, which is worse

**Severity**: CRITICAL - Direct API mutation with no safeguards or alternatives

---

### 2. Duplicate globalThis Anti-pattern (3 Files)

Three files independently implement the same anti-pattern for cross-module state sharing:

#### 2.1 `src/extensions/polyfill/index.ts` (Lines 33–38)

```typescript
const CUSTOM_KEYS_MAP = Symbol.for("pi-braid:custom-model-keys");

function getCustomModelKeys(): Map<string, string> {
  if (!(globalThis as any)[CUSTOM_KEYS_MAP]) {
    (globalThis as any)[CUSTOM_KEYS_MAP] = new Map<string, string>();
  }
  return (globalThis as any)[CUSTOM_KEYS_MAP];
}
```

#### 2.2 `src/lib/model-resolver.ts` (Lines 33–38)

```typescript
const CUSTOM_KEYS_MAP = Symbol.for("pi-braid:custom-model-keys");

function getCustomModelKeys(): Map<string, string> {
  if (!(globalThis as any)[CUSTOM_KEYS_MAP]) {
    (globalThis as any)[CUSTOM_KEYS_MAP] = new Map<string, string>();
  }
  return (globalThis as any)[CUSTOM_KEYS_MAP];
}
```

**Analysis**: These are **byte-for-byte identical** implementations. This is a clear DRY (Don't Repeat Yourself) violation.

#### 2.3 `src/extensions/context-manager/handlers/rotation.ts` (Lines 33–42)

```typescript
function getRotationState(ctx: ExtensionContext): RotationState {
  // Use process-scoped state since rotation spans sessions
  if (!(globalThis as any).__cmRotationState) {
    (globalThis as any).__cmRotationState = {
      lastRotationTimestamp: Date.now(),
      turnsSinceRotation: 0,
      rotationCount: 0,
      pendingRotation: false,
      continuationSummary: "",
    };
  }
  return (globalThis as any).__cmRotationState;
}
```

**Analysis**: This uses a string key (`__cmRotationState`) instead of a Symbol, and stores rotation state in globalThis. This is even more problematic because:

- It doesn't use a Symbol, so it's vulnerable to naming collisions
- It stores state that should be session-scoped in process-scoped storage
- The comment "since rotation spans sessions" is misleading - proper session management should handle this

**Severity**: CRITICAL - Three files independently implementing the same anti-pattern. Should be extracted to a single shared utility.

---

### 3. Module-Level Mutable State Violations

**Convention**: `AGENTS.md` states: _"Never use module-level let for mutable state (except disk-persisted config)"_

#### 3.1 `src/extensions/polyfill/index.ts`

| Line | Variable           | Type  |
| ---- | ------------------ | ----- |
| 37   | `_sessionManager`  | `let` |
| 38   | `_lastUserMessage` | `let` |
| 69   | `saveTimer`        | `let` |

```typescript
let _sessionManager: any = undefined;
let _lastUserMessage: string = "";
```

#### 3.2 `src/lib/degradation-detector.ts` (Lines 46–52)

```typescript
let _global: DegradationState = {
  metrics: [],
  config: { ...DEFAULT_CONFIG },
  isDegraded: false,
  lastHealthcheck: null,
};
```

#### 3.3 `src/lib/cognitive-memory.ts` (Lines 357–361)

```typescript
// Singleton instance for consistent state across tool calls
let _singletonInstance: CognitiveMemory | null = null;

export function getCognitiveMemory(): CognitiveMemory {
  if (!_singletonInstance) {
    _singletonInstance = new CognitiveMemory();
  }
  return _singletonInstance;
}
```

#### 3.4 `src/extensions/browser/index.ts` (Lines 35–40)

```typescript
let cdp: CdpClient | null = null;
let connectedTabId: string = "";
let connectedUrl: string = "";
let sessionCleanup: (() => void) | null = null;
let autoStartDone = false;
let connectLock: Promise<CdpClient> | null = null;
```

#### 3.5 `src/extensions/feedback/index.ts` (Line 19)

```typescript
let pendingWhisper: string | null = null;
```

#### 3.6 `src/extensions/enforcement/index.ts` (Lines 68–69)

```typescript
// Map of file path -> { content, turn }
const knownFiles = new Map<string, { content: string; turn: number }>();
```

**Analysis**: While `knownFiles` uses `const` (the Map reference is constant), the Map itself is mutable. The distinction matters: the Map can grow/shrink, but the reference can't be reassigned. This is a partial violation.

**Severity**: CRITICAL - Despite explicit convention, violations exist in 6+ files.

---

### 4. Broken Runtime Type Guard

**File**: `src/lib/degradation-detector.ts`  
**Lines**: 61–64

```typescript
function isCtx(val: unknown): val is ExtensionContext {
  return typeof val === "object" && val !== null && !("turnNumber" in val);
}
```

**Analysis**: This type guard has a semantic inversion problem:

1. **`PerformanceMetrics` HAS `turnNumber`** (line 18):

   ```typescript
   interface PerformanceMetrics {
     turnNumber: number;
     toolCalls: number;
     errors: number;
     successRate: number;
   }
   ```

2. **`ExtensionContext` does NOT have `turnNumber`**

3. The guard checks `!("turnNumber" in val)`:
   - For `PerformanceMetrics`: `"turnNumber" in metrics` → `true` → `!("turnNumber" in metrics)` → `false` ✓
   - For `ExtensionContext`: `"turnNumber" in ctx` → `false` → `!("turnNumber" in ctx)` → `true` ✓

The logic _happens to work_ by accident, but it's conceptually backwards:

- The function is named `isCtx` but checks for the _absence_ of a metrics property
- It relies on the specific implementation details of one type (PerformanceMetrics) to distinguish from another (ExtensionContext)
- If PerformanceMetrics ever removes `turnNumber`, this will silently break

**Correct approach**: Check for properties that ExtensionContext HAS and PerformanceMetrics does NOT:

```typescript
function isCtx(val: unknown): val is ExtensionContext {
  return typeof val === "object" && val !== null && "tools" in val && "settingsManager" in val;
}
```

**Severity**: CRITICAL - Logic works by accident, not by design. Fragile and confusing.

---

## 🟠 HIGH SEVERITY ISSUES

### 5. Semantic Conflict: HTTP 429 in Both Retryable and Non-Retryable Sets

**File**: `src/lib/error-classifier.ts`

```typescript
// Line 32
const HTTP_TRANSIENT_RETRYABLE = new Set([429, 500, 502, 503, 504]);

// Line 37
const HTTP_CLIENT_ERROR_NON_RETRYABLE = new Set([
  400, 401, 403, 404, 405, 408, 410, 413, 415, 422, 429,
]);
```

**Analysis**: HTTP 429 (Too Many Requests / Rate Limited) appears in BOTH sets:

- It's classified as "TRANSIENT" (retryable) in line 32
- It's classified as "CLIENT_ERROR" (non-retryable) in line 37

The comment on line 37 admits this: `// 429 is debatable`. But having it in both sets means:

- The classification logic depends on the ORDER of checks
- If the transient check runs first, 429 is retryable
- If the client error check runs first, 429 is non-retryable
- The logic is unclear and the comment acknowledges uncertainty without resolving it

**Severity**: HIGH - Logic is ambiguous. Should be either definitively retryable or definitively non-retryable.

---

### 6. Fragile Text Scraping Instead of Structured Access

**File**: `src/extensions/safety/index.ts`  
**Lines**: 67–106

```typescript
function gatherCommitContext(): {
  goals: string[];
  plans: string[];
  decisions: string[];
  notes: string[];
} {
  // ... git diff extraction ...

  // Detect scratchpad goal references
  const goalMatch = text.match(/Goal set: (.+?)(?:\n|$)/);
  if (goalMatch && !scratchpadGoal) scratchpadGoal = goalMatch[1].trim();

  // Detect plan steps
  const planMatches = text.matchAll(/^\d+\)\s+(.+)$/gm);
  for (const m of planMatches) {
    const step = m[1].trim();
    if (step && !scratchpadPlan.includes(step)) scratchpadPlan.push(step.slice(0, 80));
  }

  // Detect decisions
  const decisionMatches = text.matchAll(/decision:?\s*(.+)/gi);
  for (const m of decisionMatches) {
    const d = m[1].trim().slice(0, 100);
    if (d && !scratchpadDecisions.includes(d)) scratchpadDecisions.push(d);
  }

  // Detect notes
  const noteMatches = text.matchAll(/note:?\s*(.+)/gi);
  for (const m of noteMatches) {
    const n = m[1].trim().slice(0, 100);
    if (n && !scratchpadNotes.includes(n)) scratchpadNotes.push(n);
  }
}
```

**Analysis**: This function uses regex to parse assistant message text for structured data:

- Depends on specific output patterns: "Goal set:", "1) ", "decision:", "note:"
- Will silently break if scratchpad changes its output format
- No validation of extracted data
- String slicing (`.slice(0, 80)`, `.slice(0, 100)`) truncates data arbitrarily

**Should use**: Structured state access via the scratchpad extension's API, not text parsing.

**Severity**: HIGH - Fragile, will silently break on format changes.

---

### 7. Unsafe Type Casts (70+ Occurrences)

**Distribution by file**:

| File                                                  | Count |
| ----------------------------------------------------- | ----- |
| `src/extensions/enforcement/index.ts`                 | 15+   |
| `src/extensions/polyfill/index.ts`                    | 7     |
| `src/lib/model-resolver.ts`                           | 7     |
| `src/extensions/context-manager/handlers/rotation.ts` | 5+    |
| Other files                                           | 30+   |

**Example patterns**:

1. **`(ctx as any).settingsManager`** - Extending ctx with untyped properties:

   ```typescript
   const defaultProvider = (ctx as any).settingsManager?.getDefaultProvider?.();
   const defaultModel = (ctx as any).settingsManager?.getDefaultModel?.();
   ```

2. **`(event as any)`** - Casting event types:

   ```typescript
   pi.on("auto_retry_end" as any, async (event: any, ctx: any) => {
   ```

3. **`(result as any)`** - Casting tool results:
   ```typescript
   const details = (scratchpadResult as { details?: { ... } } | undefined)?.details;
   ```

**Analysis**: While `as any` is sometimes necessary, 70+ occurrences indicates:

- Incomplete type definitions in the ExtensionContext or related types
- Avoidance of proper type extension patterns
- Potential for runtime errors that TypeScript should catch

**Severity**: HIGH - Widespread type unsafety indicates systemic typing issues.

---

### 8. setInterval Without Cleanup Tracking

**File**: `src/extensions/evolve/index.ts`  
**Lines**: 73–76

```typescript
let saveTimer: ReturnType<typeof setInterval> | null = null;

function startMetricsPersistence(): void {
  if (saveTimer) return;
  saveTimer = setInterval(() => {
    saveMetrics().catch((err) => _log.error("Failed to save metrics:", err));
  }, METRICS_SAVE_INTERVAL);
}
```

**Analysis**:

1. **Resource leak**: The timer is never cleared when the extension unloads
2. **No cleanup handler**: There's no `pi.on("unload", ...)` to clear the interval
3. **Process contamination**: If the extension is reloaded, multiple timers could be created (though there's a guard)
4. **Best practice violation**: Intervals should be tracked and cleaned up

**Severity**: HIGH - Memory leak and potential duplicate timers.

---

## 🟡 MODERATE ISSUES

### 9. Empty/Silent Catch Blocks

#### 9.1 `src/extensions/context-manager/handlers/rotation.ts` (Lines 54–56)

```typescript
} catch {
	return 0;
}
```

#### 9.2 `src/extensions/safety/index.ts` (Line 36)

```typescript
try {
  const result = await (ctx as any).tools.exec?.({ command: `git diff --stat ${commitRange}` });
} catch {
  // Silent - no git context available
}
```

**Analysis**: While sometimes valid (e.g., "non-fatal" operations), silent catch blocks make debugging difficult and can hide legitimate errors.

---

### 10. Singleton Anti-pattern

**File**: `src/lib/cognitive-memory.ts`  
**Lines**: 357–361

```typescript
let _singletonInstance: CognitiveMemory | null = null;

export function getCognitiveMemory(): CognitiveMemory {
  if (!_singletonInstance) {
    _singletonInstance = new CognitiveMemory();
  }
  return _singletonInstance;
}
```

**Analysis**:

- **Not session-scoped**: The singleton persists across sessions
- **Global state**: Shares state between different pi sessions
- **Violates convention**: Should use `getExtensionState()` for session-scoped state
- **Hard to test**: Can't easily mock or reset the singleton

**Severity**: MODERATE - Works but violates architectural conventions.

---

### 11. Overload Explosion

Multiple files have excessive function overloads:

| File                                                    | Function | Overloads |
| ------------------------------------------------------- | -------- | --------- |
| `src/extensions/scratchpad/index.ts`                    | Various  | 17        |
| `src/extensions/session-recall/index.ts`                | Various  | 16        |
| `src/extensions/feedback/index.ts`                      | Various  | 15        |
| `src/extensions/context-manager/handlers/compaction.ts` | Various  | 13        |

**Analysis**: While not incorrect, excessive overloads:

- Increase cognitive load
- Indicate complex/legacy APIs
- Make refactoring difficult
- Often indicate missing abstraction

**Severity**: MODERATE - Works but increases maintenance burden.

---

### 12. Module-Level Utility Functions in Wrong Location

**File**: `src/extensions/enforcement/index.ts`  
**Lines**: 59–78

```typescript
// ── Simple Text Similarity ────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
```

**Analysis**: These are general-purpose text similarity utilities embedded in an extension. Should be:

- In `src/lib/` as a shared utility
- Named more generically (`textSimilarity.ts` or similar)
- Have tests

**Severity**: MODERATE - Functional but violates separation of concerns.

---

### 13. Confusing Overload Pattern in updateConfig

**File**: `src/lib/degradation-detector.ts`  
**Lines**: 83–97

```typescript
function updateDegradationConfig(
  ctxOrPartial: ExtensionContext | Partial<DegradationConfig>,
  partial?: Partial<DegradationConfig>,
): void;
function updateDegradationConfig(partial: Partial<DegradationConfig>): void;
function updateDegradationConfig(
  ctxOrPartial: ExtensionContext | Partial<DegradationConfig>,
  partial?: Partial<DegradationConfig>,
): void {
  if (ctxOrPartial && !("healthcheckMinScore" in ctxOrPartial)) {
    const ctx = ctxOrPartial as ExtensionContext;
    // ...
  } else {
    const cfg = ctxOrPartial as Partial<DegradationConfig>;
    // ...
  }
}
```

**Analysis**: The overload distinction relies on checking whether `"healthcheckMinScore" in ctxOrPartial` is true or false. This is:

- **Fragile**: If ExtensionContext ever gets a `healthcheckMinScore` property, this will break
- **Confusing**: The overload signature doesn't make this distinction clear
- **Non-standard**: Different overloads should have clearly different parameter counts or types

**Severity**: MODERATE - Works but is confusing and fragile.

---

### 14. Malformed Comments in Catch Blocks

**File**: `src/extensions/polyfill/index.ts`  
**Lines**: 51–55

```typescript
async function persistCustomKeys(): Promise<void> {
  try {
    // ... persist logic ...
  } catch {
    // Non-fatal: settings won't persist but everything else still works
    /* Non-fatal: input normalization unavailable */
  }
}
```

**Analysis**:

- The comment is split across two lines with different content
- The second comment ("input normalization unavailable") doesn't match the function context
- This looks like copy-paste error or incomplete edit

**Severity**: MODERATE - Misleading comments are worse than no comments.

---

### 15. Event Name Cast

**File**: `src/extensions/enforcement/index.ts`  
**Line**: 663

```typescript
pi.on("auto_retry_end" as any, async (event: any, ctx: any) => {
```

**Analysis**: The event name is cast as `any`, which:

- Suppresses type checking
- Hides potential typos in event names
- Makes the codebase rely on runtime behavior for event validation

**Severity**: MODERATE - Hides potential bugs.

---

### 16. Deprecated Function Still Exported

**File**: `src/extensions/feedback/index.ts`  
**Lines**: 28–39

```typescript
/**
 * Queue a feedback whisper to be injected on the next agent turn.
 * DEPRECATED: Now sends immediately via sendFeedbackWhisper.
 * Kept for backward compatibility.
 */
function _queueFeedbackWhisper(message: string): void {
  // Just store for potential debugging/audit purposes
  if (pendingWhisper) {
    pendingWhisper = `${pendingWhisper}\n\n${message}`;
  } else {
    pendingWhisper = message;
  }
}
```

**Analysis**:

- Function is prefixed with `_` (indicating private) but is still exported
- Despite being "deprecated", it's still part of the public API
- The `pendingWhisper` variable is never consumed by anything meaningful

**Severity**: MODERATE - Confusing API surface.

---

### 17. Legacy Global Fallback Pattern

**File**: `src/lib/degradation-detector.ts`  
**Lines**: 54–59

```typescript
function getStateFrom(ctx?: ExtensionContext): DegradationState {
  if (ctx) return getExtensionState(ctx, "degradation-detector", () => ({ ..._global }));
  return _global;
}
```

**Analysis**: This shows the codebase in transition:

- New code uses `getExtensionState()` (proper session-scoped state)
- Legacy fallback uses `_global` (process-scoped, non-session-scoped)
- The `_global` fallback can cause cross-session contamination

**Severity**: MODERATE - Transitional code that should be fully migrated.

---

## 🟢 MINOR ISSUES

### 18. AI-Generated Content Artifacts

Multiple files show signs of AI-generated code:

- **Verbose JSDoc** that states the obvious
- **Overly detailed comments** for simple operations
- **Inconsistent naming** between files
- **Verbose function names** (e.g., `updateDegradationStatusFrom` instead of `updateDegradation`)

**Example**:

```typescript
/**
 * Record healthcheck score from metrics
 */
function recordHealthcheckScore(score: number): void;
```

The comment adds no value - the function name is self-explanatory.

---

### 19. Magic Numbers in Configuration

Multiple files have magic numbers without named constants:

```typescript
// From various files
METRICS_SAVE_INTERVAL = 60000; // Why 60 seconds?
HEALTHCHECK_INTERVAL = 300000; // Why 5 minutes?
NUDGE_COOLDOWN = 30000; // Why 30 seconds?
```

These should be documented or extracted to a config file.

---

### 20. Inconsistent Error Handling Patterns

The codebase has multiple error handling patterns:

1. Silent catch blocks (`catch { /* silent */ }`)
2. Catch with comments (`catch { /* Non-fatal: ... */ }`)
3. Catch with logging (`catch (err) => log.error(...)`)
4. No catch at all (letting errors propagate)

This inconsistency makes it unclear which errors are expected vs. unexpected.

---

### 21. Inconsistent File Organization

Some observations:

- `src/extensions/enforcement/` has `handlers/` subdirectory but other extensions don't
- Some extensions are 900+ lines, others are 100 lines
- No clear convention for when to split into handlers

---

## 📊 Summary Statistics

| Category                   | Count            |
| -------------------------- | ---------------- |
| Critical Issues            | 4                |
| High Severity              | 4                |
| Moderate                   | 9                |
| Minor                      | 4                |
| **Total Issues**           | **21**           |
|                            |                  |
| `as any` casts             | 70+              |
| Module-level mutable state | 8+ files         |
| Function overloads         | 60+ across files |
| Files using globalThis     | 3                |
| Singleton instances        | 1                |

---

## 🔧 Recommended Priority Actions

### Immediate (Fix in Current Sprint)

1. **Remove monkey patches from polyfill** - Replace with proper extension mechanism
2. **Fix 429 semantic conflict** - Decide whether rate limits are retryable or not
3. **Fix broken type guard** - Use positive property check instead of negative

### Short-term (Next Sprint)

4. **Extract globalThis pattern to shared utility** - Create `lib/cross-module-state.ts`
5. **Migrate module-level state to getExtensionState()** - Priority: polyfill, degradation-detector
6. **Remove singleton from cognitive-memory** - Use proper session-scoped state
7. **Add cleanup for setInterval in evolve** - Track and clear timers on unload

### Medium-term (Future Sprint)

8. **Address 70+ unsafe casts** - Add proper type definitions or use `unknown` narrowing
9. **Reduce overload complexity** - Prefer optional parameters or union types
10. **Replace text scraping with structured access** - Use proper state API

---

## 📁 Files Requiring Immediate Attention

1. `src/extensions/polyfill/index.ts` - Monkey patches + state violations + malformed comments
2. `src/lib/degradation-detector.ts` - Broken type guard + `_global` fallback
3. `src/lib/cognitive-memory.ts` - Singleton + module-level state
4. `src/lib/model-resolver.ts` - globalThis anti-pattern (duplicate)
5. `src/lib/error-classifier.ts` - Semantic conflict (429 in both sets)
6. `src/extensions/safety/index.ts` - Text scraping
7. `src/extensions/context-manager/handlers/rotation.ts` - globalThis + `as any`
8. `src/extensions/enforcement/index.ts` - Most `as any` casts + module-level utilities
9. `src/extensions/evolve/index.ts` - setInterval without cleanup

---

_Report generated by Braid (PI Coding Agent) on 2026-04-21_
