# pi-braid Code Review — v0.5.7

**Reviewer**: Braid (self-review)
**Last Updated**: 2026-04-19

---

## Completion Status

### P0: Dead Code & Mergers ✅
- [x] Delete `rate-limiter` (merged into `enforcement`)
- [x] Merge `reasoning` → `enforcement`
- [x] Merge `feedback` → `enforcement`
- [x] Delete `analytics`, `visual-dashboard`, `ab-testing`, `query-optimizer`, `latent-activator`, `watchdog`

### P1: Core Quality ✅
- [x] `scratchpad` cwd fix: `process.cwd()` → `ctx.cwd`
- [x] `Type.Union` → `StringEnum` in 10 files
- [x] Sync `fs` → async `fs/promises` in 7 modules
- [x] Fix all type errors in context-manager and enforcement
- [x] Fix `session_before_compact` handler → `pi.sendMessage()`
- [x] Create `judge-utils.ts` shared infrastructure
- [x] Fix codebase-tree path resolution
- [x] Remove `console.log/warn/error` from all extensions

### P1: withFileMutationQueue ✅
- [x] Created `src/lib/file-mutation-queue.ts` — FileMutationQueue class
- [x] Applied to `scratchpad` and `cognitive-memory`

### P2: Finalize Auto-Proceed ✅
- [x] `autoProceed` param in finalize schema
- [x] `findNextWork()` scans Planner + GoalManager
- [x] Outputs "📋 Next Plan: ... (N steps remaining)" / "🎯 Next Goal: ..."

### P3: Extension Health Reporting ✅
- [x] `testExtensionHealth()` reports ext count, tool count, duplicates, event bus

### P4: Batch Context Reduction ✅
- [x] `batchCollapseRule` collapses repeated tool calls with `bcrCount/bcrKey`

### P4: Topic Drift Detector ✅
- [x] `src/lib/topic-drift-detector.ts` — Jaccard + structural drift detection
- [x] Integrated into enforcement: `session_start` init + `turn_end` check
- [x] Sends `[SUBTLE]` / `[WARN]` whispers

### P5: Simplify Anti-Slop + Restore Preprocessor ✅
- [x] Simplified `anti-slop-input/index.ts` — removes multilingual hints (was sending to LLM), keeps ONLY code-request detection
- [x] Anti-slop uses `action: "transform"` with code suffix ONLY — never sends hints to LLM
- [x] Restored original `user-message-preprocessor/index.ts` from git (utility model text cleaning, editor text update)
- [x] Preprocessor flow: update editor → user presses Enter → text goes to LLM (no hints)
- [x] Fixed enforcement crash: `session?.messages` null check

### Post-P5: Language Detection + Reply Instruction ✅
- [x] `src/lib/language-hint.ts` — script-based detection (Cyrillic, Arabic, Chinese, Japanese, Korean, Hindi, Thai, Hebrew, Greek)
- [x] Preprocessor detects language of original input → `setLanguage()`
- [x] Enforcement `input` handler injects reply instruction into system prompt via `updateSystemPrompt`
- [x] Never sends language hints in user messages — system prompt only

### Post-P5: Preprocessor Fix ✅
- [x] Removed `ctx.getUtilityModel()` (doesn't exist in current API) → replaced with `ctx.model` + non-reasoning fallback

### Post-P5: Anti-Slop Merged Into Preprocessor ✅
- [x] Deleted `src/extensions/anti-slop-input/` — merged into preprocessor
- [x] Correct execution order: preprocessor translates → anti-slop checks cleaned text → editor update
- [x] Added Russian code-request patterns (напиши/создай/реализуй + функци/класс/...)

### Post-P5: Reasoning Stability Metrics ✅
- [x] `src/lib/reasoning-metrics.ts` — measureStability() with anchor overlap, bigram entropy, contradiction detection
- [x] Integrated into enforcement `message_end` → emits `[stability]` signal

### Post-P5: Doc Archive ✅
- [x] Archived 10 obsolete docs to `docs/archive/`
- [x] Kept current: REVIEW-v0.5.7, TOOL_IMPROVEMENTS_PROPOSAL, TOOLS_ISSUES_REPORT

### Post-P5: Code Quality ✅
- [x] Fixed repetition detection FIXME (magic numbers → named constant, proper `every()` check)

### Metrics: 26 extensions, 0 type errors, ~21,700 lines

---

## Archived Proposals

Archived to `docs/archive/`:
- AUDIT-2026-04-14.md, ABLATION_STUDY.md, CONTEXT-MANAGEMENT-DESIGN.md
- CONTEXT-OVERFLOW-FIX.md, RESEARCH_SYNTHESIS_COMPLETE.md, SKEPTIC-AUDIT.md
- VALIDATION_PROTOCOL.md, GAP-ANALYSIS.md
- MEASUREMENT_GAP_SOLUTION.md (**IMPLEMENTED** → reasoning-metrics.ts)
- PROPOSAL_TOPIC_DRIFT_DETECTOR.md (**IMPLEMENTED** → topic-drift-detector.ts)

## Current Docs

| File | Status |
|------|--------|
| `docs/REVIEW-v0.5.7.md` | This file |
| `docs/TOOL_IMPROVEMENTS_PROPOSAL.md` | Think v2 — partially implemented (depth, confidence, tags) |
| `docs/TOOLS_ISSUES_REPORT.md` | Mostly fixed |

## Deferred (Low Frequency / Large Effort)
- Session-scoped state refactor (needs ExtensionContext pattern)
- MARS reflection (low frequency)
- Think v2 full implementation (thought types: plan/execution/reflection)
- Hypothesis confidence scoring
- Reasoning metrics calibration (needs real-world testing)
