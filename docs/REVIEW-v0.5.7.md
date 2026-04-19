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

### P5: Multilingual Anti-Slop Input Transform ✅
- [x] Rewrote `anti-slop-input/index.ts` from TODO stub to full implementation
- [x] Script-based detection: Arabic, Chinese, Japanese, Korean, Devanagari, Cyrillic, Greek, Hebrew, Thai, Tamil
- [x] Pattern-based Latin detection: German, French, Spanish, Portuguese, Italian, Polish, Dutch, Vietnamese
- [x] Forces reply in same language as query via `[Language: NAME (CODE)]` suffix
- [x] Applies to ALL texts including one-word non-English inputs
- [x] Code request detection (4 patterns)
- [x] Fixed enforcement crash: `session?.messages` null check

### Metrics: 35 → 27 extensions, 0 type errors, 21,882 lines

---

## Pending Proposals

See `docs/PROPOSAL_*.md` for full details.

| File | Status |
|------|--------|
| `docs/PROPOSAL_TOPIC_DRIFT_DETECTOR.md` | **IMPLEMENTED** ✅ |
| `docs/TOOL_IMPROVEMENTS_PROPOSAL.md` | Reviewed — think v2, hypothesis, confidence scoring deferred |
| `docs/TOOLS_ISSUES_REPORT.md` | Mostly fixed |

## Deferred (Low Frequency / Large Effort)
- Session-scoped state refactor (needs ExtensionContext pattern)
- MARS reflection (low frequency)
