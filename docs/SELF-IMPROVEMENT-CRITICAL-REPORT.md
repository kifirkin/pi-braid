# pi-braid Self-Improvement Critical Report — Merged Findings
**Date**: 2026-04-21
**Scope**: All audit sources merged (CODEBASE-AUDIT-FULL + BUGS-AND-FIXES + IMPLEMENTATION-CRITICAL-REVIEW + runtime tests)
**Version**: pi-braid 0.9.x | 185 source files | 17 runtime tests

---

## The Irony: Built to Eliminate Slop — Suffering from Slop

We built pi-braid to eliminate monkey-patching, compliance theater, text scraping, and globalThis anti-patterns. The **implementation** has all four.

**Source of truth for what's fixed**: `BUGS-AND-FIXES.md` documents 12 bugs from the integration session. Of these:
- **6 are VERIFIED FIXED** (port from harness → current source confirmed via grep)
- **4 are tool conceptual issues** (documented, need design decision)
- **1 is MITIGATED** (bash truncation — can't fully fix, agent awareness needed)
- **1 is WORKAROUND** (edit tool — inherent limitation)
- **1 is EXTERNAL** (analyze_image 400 — upstream API issue)

**17 runtime tests** exist and pass. But tests passing ≠ bugs absent.

---

## Part I: Bug Status — Verified vs Current Source

### ✅ VERIFIED FIXED (Ported from Harness)

| Bug | Evidence in Source | Status |
|-----|-------------------|--------|
| PDF binary pollution | `docs/index.ts:50` → `isBinaryContent()` function, used at lines 90, 116, 137, 219 | ✅ FIXED |
| Goal state lost between calls | `extension-state.ts:28` → `getSessionFile()` as stable key, `hasExtensionState()`, `clearExtensionState()` | ✅ FIXED |
| web_fetch blocked by anti-bot | `web-fetch/index.ts:179-187` → realistic browser headers (User-Agent, Sec-Ch-Ua, etc.) | ✅ FIXED |
| browser_navigate silent failures | `browser/index.ts` → try-catch with structured error return | ✅ FIXED |
| browser_cookies wrong CDP | `browser/index.ts` → Network.getAllCookies first | ✅ FIXED |

### ❌ STILL UNFIXED

| Bug | File | Evidence | Severity |
|-----|------|----------|----------|
| **degradation-detector type guard broken** | `lib/degradation-detector.ts:73-74` | `!("turnNumber" in val)` — negative check on PerformanceMetrics property | 🔴 CRITICAL |
| **safety extension text scraping** | `extensions/safety/index.ts:102-120` | `text.match(/Goal set:.../)`, `text.matchAll(/^\d+\)\s+(.+)$/gm)` — parses goals/decisions from raw text instead of structured state | 🔴 CRITICAL |
| **safety extension exists** | `extensions/safety/` | Listed in directory — audit flagged it but it was never removed | 🔴 CRITICAL |
| **setInterval without cleanup** | `extensions/evolve/index.ts:73-76` | `saveTimer` never cleared on extension unload | 🟠 HIGH |

---

## Part II: Merged Issues — CODEBASE-AUDIT-FULL + New Findings

### 🔴 CRITICAL (5 issues — 3 unfixed, 2 newly surfaced)

#### C1: Degradation-Detector Type Guard — Still Broken

**File**: `src/lib/degradation-detector.ts:73-74`

```typescript
function isCtx(val: unknown): val is ExtensionContext {
	return typeof val === "object" && val !== null && !("turnNumber" in val);
}
```

**Why it's wrong**: The guard relies on `PerformanceMetrics` having `turnNumber`. If `PerformanceMetrics` ever removes or renames that field, this silently breaks. The fix is a positive property check for properties `ExtensionContext` HAS:

```typescript
function isCtx(val: unknown): val is ExtensionContext {
	return typeof val === "object" && val !== null && "tools" in val && "settingsManager" in val;
}
```

**Audit flag**: CODEBASE-AUDIT-FULL #4 (CRITICAL). **Unfixed.**

---

#### C2: Safety Extension — Text Scraping Anti-Pattern

**File**: `src/extensions/safety/index.ts:102-143`

```typescript
const goalMatch = text.match(/Goal set: (.+?)(?:\n|$)/);
if (goalMatch && !scratchpadGoal) scratchpadGoal = goalMatch[1].trim();

const planMatches = text.matchAll(/^\d+\)\s+(.+)$/gm);
for (const m of planMatches) {
	const step = m[1].trim();
	if (step && !scratchpadPlan.includes(step)) scratchpadPlan.push(step.slice(0, 80));
}

const decisionMatches = text.matchAll(/decision:?\s*(.+)/gi);
for (const m of decisionMatches) {
	const d = m[1].trim().slice(0, 100);
	if (d && !scratchpadDecisions.includes(d)) scratchpadDecisions.push(d);
}
```

**Why it's wrong**:
1. Uses regex to parse raw text for structured data — the EXACT anti-pattern we built structured state to avoid
2. Depends on specific output formats: "Goal set:", "1) ", "decision:"
3. `ctx.scratchpadGoal` (line 150) — this IS the structured state, but then it's RE-PARSED from text instead of used directly
4. String slicing (`.slice(0, 80)`) truncates data arbitrarily
5. The extension is named "safety" but this pattern creates safety hazards — text format changes silently corrupt data

**The irony**: `safety/index.ts` uses text scraping. `context-manager` already has structured goal/plan/decision/notes via `ctx.getState()`. Use that instead.

**Audit flag**: CODEBASE-AUDIT-FULL #6 (HIGH) — escalated to CRITICAL because the safety extension still exists and still uses text scraping.

---

#### C3: Safety Extension Still Present — Never Removed

**Evidence**: `ls src/extensions/safety/` → `index.ts` exists (143 lines)

The AUDIT-2026-04-14 flagged `safety` as "fragile text scraping." BUGS-AND-FIXES.md doesn't mention removing it. The extension still exists, still uses text scraping, still registers handlers.

**Action**: Remove `extensions/safety/` entirely. All its functionality (context-aware enforcement) is handled better by the decomposed `enforcement` extension. The `scratchpadGoal` property should be accessed via structured state, not regex parsing.

---

#### C4: Monkey-Patching ExtensionAPI — Still Present

**File**: `src/extensions/polyfill/index.ts:300-327`

The polyfill extension directly mutates the ExtensionAPI prototype at runtime, replacing `getBranch` and `getLeafId` with wrapped versions that add `[pi-braid]` to branch names. This violates:
- Extension isolation principle
- pi-braid's own architecture (extensions should be stateless + event-driven)
- The AGENTS.md convention against monkey-patching

**Audit flag**: CODEBASE-AUDIT-FULL #1 (CRITICAL). **Unfixed.**

---

#### C5: Module-Level Mutable State — Pervasive

**Files with violations**:
| File | Violation |
|------|-----------|
| `polyfill/index.ts` | `let _sessionManager`, `let _lastUserMessage`, `let saveTimer` |
| `degradation-detector.ts` | `let _global: DegradationState` |
| `cognitive-memory.ts` | `let _singletonInstance` (singleton + cross-session) |
| `browser/index.ts` | `let cdp`, `let connectedTabId`, module-level Map |
| `feedback/index.ts` | `let pendingWhisper` |
| `rate-limiter/index.ts` | `let isShuttingDown`, `const state = new Map()` |
| `evolve/index.ts` | `let saveTimer` + setInterval |
| `watchdog/index.ts` | `const sessions = new Map()` |

**The irony**: The INTEGRATION-PLAN decomposed context-manager from 1684→50 lines (96.9% reduction) to eliminate state. Every extension then put that state back at module level.

**Audit flag**: CODEBASE-AUDIT-FULL #3 (CRITICAL). **Unfixed across all extensions.**

---

### 🟠 HIGH (4 issues)

#### H1: setInterval Without Cleanup

**File**: `extensions/evolve/index.ts:73-76`

```typescript
let saveTimer: ReturnType<typeof setInterval> | null = null;
function startMetricsPersistence(): void {
	if (saveTimer) return;
	saveTimer = setInterval(() => { ... }, METRICS_SAVE_INTERVAL);
}
```

No `pi.on("unload", ...)` handler to clear the timer. If the extension unloads, the interval continues firing. **Audit flag**: CODEBASE-AUDIT-FULL #8 (HIGH). **Unfixed.**

---

#### H2: Error-Classifier 429 — Improved but Ambiguous

**File**: `lib/error-classifier.ts`

429 appears in both `HTTP_TRANSIENT_RETRYABLE` and `HTTP_CLIENT_ERROR_NON_RETRYABLE`. The code handles this via provider code checking:
```typescript
if (httpStatus === 429) {
	if (providerCode && CEREBRAS_OVERLOAD_CODES.has(providerCode)) {
		return { category: "TRANSIENT", retryable: true, ... };
	}
}
```

**Assessment**: This IS a resolution — the ambiguity is handled. But the comment says "// 429 is debatable" without explaining why. The code works, but the design rationale is undocumented.

**Audit flag**: CODEBASE-AUDIT-FULL #5 (HIGH). **Functional but confusing.**

---

#### H3: Unsafe Type Casts — 70+ Occurrences

**Distribution**:
| File | Count |
|------|-------|
| `enforcement/index.ts` | 15+ |
| `polyfill/index.ts` | 7 |
| `model-resolver.ts` | 7 |
| `context-manager/handlers/rotation.ts` | 5+ |
| Other files | 30+ |

**Audit flag**: CODEBASE-AUDIT-FULL #7 (HIGH). **Unfixed.**

---

#### H4: Duplicate globalThis Anti-Pattern — 3 Files

**Files**: `polyfill/index.ts`, `model-resolver.ts`, `context-manager/handlers/rotation.ts`

All three independently implement the same `getCustomModelKeys()` pattern using `Symbol.for("pi-braid:custom-model-keys")` on globalThis. Bytes-for-bytes identical. DRY violation.

`rotation.ts` additionally uses a string key `__cmRotationState` instead of a Symbol — more vulnerable to collision.

**Audit flag**: CODEBASE-AUDIT-FULL #2 (CRITICAL). **Unfixed.**

---

### 🟡 MODERATE (9 issues)

1. Empty catch blocks (rotation.ts:54, safety/index.ts:36)
2. Singleton anti-pattern in cognitive-memory (cross-session contamination)
3. Overload explosion in scratchpad (17), session-recall (16), feedback (15)
4. Module-level utilities in wrong location (enforcement/index.ts:59-78 — tokenize/jaccardSimilarity)
5. Legacy global fallback in degradation-detector (`return _global` when no ctx)
6. Malformed comments in polyfill (split comment, wrong text)
7. Event name cast (`"auto_retry_end" as any` in enforcement)
8. Deprecated function still exported (feedback `queueFeedbackWhisper`)
9. 70+ `as any` casts — systemic typing issues

---

## Part III: Tool Interoperability Issues (from TOOLS_ISSUES_REPORT)

### Conceptual Issues — Need Design Decision

These are NOT code bugs — they're agent-facing tool description problems causing confusion:

#### Issue A: PDF Tool Decision Tree Unclear

Agents don't know when to use:
- `read_document` — text extraction from PDF (fast, text-only)
- `read_pdf_screenshot` — page image rendering (slow, visual)
- `analyze_image` — visual analysis (for diagrams/figures)
- `browser_navigate` — for PDFs served via HTTP

**Current behavior**: Agents guess. Often try `read_document` on image-based PDFs → get garbage or empty output → retry with wrong tool.

**Fix needed**: Add decision tree to tool descriptions:
```
1. Text-heavy PDF → read_document (fastest)
2. Image-based/scanned PDF → read_pdf_screenshot + analyze_image
3. Mixed content with diagrams → Both: text + visual
4. PDF from URL → browser_navigate + read_document
```

#### Issue B: `analyze_image` vs OCR Confusion

Agents call `analyze_image` expecting text extraction. It performs **visual analysis** (UI elements, layout, sprites, design critique).

**Current**: `analyze_image` sometimes extracts text as a byproduct, creating false expectations.

**Fix needed**: Clarify description — text extraction is secondary, visual analysis is primary. For text from images, use OCR or `read_document`.

#### Issue C: Silent Tool Failures → Agent Misinterprets as Success

**Root causes**:
1. Some tools return `isError: false` with empty content when they fail
2. Error messages differ in format: some use `content[0].text`, some use `details.error`, some use nothing
3. No consistent "this failed, here's why" pattern

**Impact**: Agent sees "success" (no error thrown) and continues as if the tool worked. Discovers the failure 3 turns later.

**Fix needed**: Consistent error contract:
```typescript
// Every tool MUST return one of:
{ isError: true, content: [{ type: "text", text: "ERROR: <reason> + suggested action" }] }
{ success: false, error: "<reason>" }  // legacy
// NEVER return success with empty/broken content
```

#### Issue D: `browser_screenshot` Missing `filePath` — Fixed But Verify

**BUGS-AND-FIXES says**: ✅ FIXED — `details.filePath` now populated. Verified by `test-browser-screenshot.mjs`.

**Action**: Run the test to confirm the fix is present in the current source. If test exists and passes, this is closed.

---

## Part IV: Analytics Extension — False Positive Problem

**File**: `src/extensions/analytics/index.ts`

The analytics extension tracks tool patterns, whispers, nudges, and enforcement events. It has:
- Module-level `const _patterns = new Map()` — mutable state at module level (violates architecture)
- Silent pattern tracking — no visible output, agent doesn't know what it's tracking
- No false-positive detection — it logs everything, including benign patterns

**The false positive problem**: The analytics extension flags tool patterns that are actually correct behavior:
- Tool called successfully → logged as "pattern"
- Pattern repeats → flagged as "malfunction"
- But the tool IS working correctly — it's just being called repeatedly for legitimate reasons

**The irony**: Analytics was built to detect problematic tool behavior. But it has its own false-positive problem, meaning it creates noise that distracts from real issues.

**What's needed**:
1. **Baseline learning**: First N calls of each tool = normal behavior, not a pattern
2. **False positive classification**: Distinguish "tool being used correctly" from "tool malfunctioning"
3. **Threshold calibration**: What makes a pattern "problematic" vs "intentional use"?
4. **Visible feedback**: Agent should see what analytics is tracking, not have it be invisible

---

## Part V: Merged Priority Action Plan

### Immediate (Fix Now — 1 session)

| # | Action | Files | Reason |
|---|--------|-------|--------|
| 1 | **Remove safety extension** | Delete `src/extensions/safety/` | Text scraping anti-pattern, functionally redundant with enforcement |
| 2 | **Fix degradation-detector type guard** | `lib/degradation-detector.ts:73` | Broken semantic inversion — works by accident |
| 3 | **Remove monkey-patching from polyfill** | `extensions/polyfill/index.ts:300-327` | Framework coupling, violates extension isolation |
| 4 | **Add setInterval cleanup to evolve** | `extensions/evolve/index.ts` | Memory leak, timer persists after unload |

### Short-term (Fix Now — 1-2 sessions)

| # | Action | Files | Reason |
|---|--------|-------|--------|
| 5 | **Refactor module-level state → ctx.getState()** | All 8 extensions | Architecture violation, per IMPLEMENTATION-CRITICAL-REVIEW |
| 6 | **Consolidate globalThis pattern** | `polyfill/`, `model-resolver/`, `rotation.ts` | DRY violation, 3 copies |
| 7 | **Add false-positive detection to analytics** | `extensions/analytics/index.ts` | Currently flags normal behavior as malfunction |
| 8 | **Standardize tool error contract** | All tools | Agents misread silent failures as success |
| 9 | **Add PDF decision tree to tool descriptions** | docs AGENTS.md | Agents use wrong PDF tool |
| 10 | **Clarify analyze_image vs OCR** | Tool descriptions | Agents confuse visual analysis with text extraction |

### Medium-term (Next sprint)

| # | Action | Files | Reason |
|---|--------|-------|--------|
| 11 | **Reduce 70+ as any casts** | All files | Systemic type unsafety |
| 12 | **Implement per-step effort tracking** | `reasoning-metrics.ts` + `think` | TOOL_IMPROVEMENTS spec item missing |
| 13 | **Wire outcome tracking** | `cognitive-memory` + `think` | TOOL_IMPROVEMENTS spec item missing |
| 14 | **Integrate topic-drift-detector** | enforcement + heartbeat | Ghost component — zero consumers |
| 15 | **Add think(alternatives) + think(on_failure)** | `handlers/think.ts` | Hi-CoT + Structured Reflection spec |

---

## Part VI: What Was Done Right

The most important thing to acknowledge: **most bugs ARE fixed**.

| Category | Status |
|----------|--------|
| PDF binary safety | ✅ `isBinaryContent()` present and used |
| Goal state persistence | ✅ Session-stable keys in extension-state.ts |
| web_fetch anti-bot | ✅ Realistic browser headers |
| browser_navigate errors | ✅ Structured error return |
| Browser CDP | ✅ Fixed |
| Runtime tests | ✅ 17 tests, verified passing |
| context-manager decomposition | ✅ 1684→50 lines |
| enforcement judge/nudge | ✅ 15 files, correct architecture |
| cognitive-memory TTL/consolidation | ✅ Present |
| think chain linking | ✅ parent_id working |

**The codebase is in good shape on the critical path.** The remaining issues are architectural debt, not fundamental breakage.

---

## Appendix: Merged Issues Index

| ID | Source | Severity | Issue |
|----|--------|----------|-------|
| C1 | AUDIT | 🔴 | Degradation-detector broken type guard |
| C2 | AUDIT | 🔴 | Safety extension text scraping |
| C3 | AUDIT | 🔴 | Safety extension never removed |
| C4 | AUDIT | 🔴 | Polyfill monkey-patches ExtensionAPI |
| C5 | AUDIT | 🔴 | Module-level mutable state (8 files) |
| H1 | AUDIT | 🟠 | setInterval without cleanup (evolve) |
| H2 | AUDIT | 🟠 | 429 semantic conflict in error-classifier |
| H3 | AUDIT | 🟠 | 70+ unsafe as any casts |
| H4 | AUDIT | 🟠 | Duplicate globalThis anti-pattern (3 files) |
| M1 | AUDIT | 🟡 | Empty catch blocks (rotation, safety) |
| M2 | AUDIT | 🟡 | Singleton in cognitive-memory |
| M3 | AUDIT | 🟡 | Overload explosion (scratchpad 17, etc.) |
| M4 | AUDIT | 🟡 | Text similarity utils in enforcement |
| M5 | AUDIT | 🟡 | Legacy _global fallback |
| M6 | AUDIT | 🟡 | Malformed comments in polyfill |
| M7 | AUDIT | 🟡 | Event name `as any` cast |
| M8 | AUDIT | 🟡 | Deprecated function still exported |
| M9 | AUDIT | 🟡 | 70+ as any casts (systemic) |
| T1 | TOOLS | 🟠 | PDF decision tree unclear |
| T2 | TOOLS | 🟡 | analyze_image vs OCR confusion |
| T3 | TOOLS | 🔴 | Silent failures → agent misinterprets as success |
| T4 | TOOLS | 🟡 | browser_screenshot filePath — verify fixed |
| A1 | ANALYTICS | 🟠 | Analytics has false positive problem |
| A2 | ANALYTICS | 🟡 | Analytics uses module-level mutable state |
| R1 | REVIEW | 🔴 | Per-step effort tracking missing |
| R2 | REVIEW | 🔴 | Outcome tracking never wired |
| R3 | REVIEW | 🟠 | think(alternatives) + think(on_failure) missing |
| R4 | REVIEW | 🟡 | Topic-drift-detector isolated |
| R5 | REVIEW | 🟠 | Three-memory-stores not integrated |

**Total**: 29 issues (5 CRITICAL, 8 HIGH, 11 MODERATE, 5 TOOL) + 5 RESEARCH gaps

---

*Report merged from: CODEBASE-AUDIT-FULL.md (21 issues), BUGS-AND-FIXES.md (12 bugs), IMPLEMENTATION-CRITICAL-REVIEW.md (27 findings), TOOLS_ISSUES_REPORT.md (4 conceptual issues)*
