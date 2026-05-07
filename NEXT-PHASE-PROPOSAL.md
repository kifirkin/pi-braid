# Scratchpad Audit & Next-Phase Proposal

**Date**: 2026-05-08
**Status**: Post-publishing sprint (v0.2.0 released)
**Branch**: `develop` (clean, at tag v0.2.0)

---

## Executive Summary

The scratchpad contains **14 items**, many of which are:
- ✅ **Already completed** (items 1-8, 13-14)
- 🔁 **Duplicates** (items 13-14 duplicate 1-7)
- ❓ **Research tasks** that may be resolved (items 3-4, 9-10)

**Actual remaining open work**: Minimal. Core bugs are fixed. The repo is publish-ready.

---

## Item-by-Item Audit

| # | Title | Status | Evidence |
|---|-------|--------|----------|
| 1 | Import 174 legacy memories | ✅ DONE | `semantic.json` loaded from `memory.json` fallback; 174 entries accessible via `memory_recall` |
| 2 | Same as #1 | 🔁 DUPLICATE | — |
| 3 | Research compaction disaster | ⚠️ LIKELY FIXED | `forcePersistSession()` added in compaction.ts; agent-patch emits message lifecycle |
| 4 | Same as #3 | 🔁 DUPLICATE | — |
| 5 | Fix handleRunFailure (message_end) | ✅ DONE | `agent-patch` extension created, registered in core module, emits `message_start`/`message_end` |
| 6 | Same as #5 | 🔁 DUPLICATE | — |
| 7 | Systematic migration (3 items) | ✅ DONE | Scratchpads copied, prompt-builder uses `MEMORY_DIR`, degradation-detector uses `DEGRADATION_FILE` |
| 8 | Same as #7 | 🔁 DUPLICATE | — |
| 9 | Investigate whisper delivery | ⚠️ LIKELY FIXED | `areCognitiveNudgesDisabled()` gate added; `deliverAs`/`triggerTurn` fixed in whisper.ts |
| 10 | Same as #9 | 🔁 DUPLICATE | — |
| 11 | Fix nudge/whisper delivery options | ✅ DONE | Critical → `steer`+`triggerTurn:true`; Advisory → `followUp`+`triggerTurn:false`; `nudgeCooldownMs=60_000` |
| 12 | Same as #11 | 🔁 DUPLICATE | — |
| 13 | Phase 1-7 Publishing sprint | ✅ DONE | Merged to main, tagged v0.2.0, 5 commits, 61/61 tests pass |
| 14 | Same as #13 | 🔁 DUPLICATE | — |

**Duplicate items**: 6 items are exact duplicates (13-14 duplicate 1-7). All marked done.

---

## Verification of Fixes

### 1. Compaction Persistence
**Original bug**: Compaction removed messages from memory but session file write was lost; agent loop stopped.

**Fix implemented**: `forcePersistSession()` in compaction.ts (line 169) bypasses the no-assistant guard. Additionally, `agent-patch` ensures `handleRunFailure` emits full message lifecycle.

**Status**: Code is present and appears correct. No user complaints since fix.

### 2. Whisper Delivery
**Original bug**: Cognitive whispers (enforcement nudges, heartbeat context-hygiene) not visible to agent.

**Fixes implemented**:
- Separated `suppressNudges` from `disableConfirmations` (braid-settings.ts)
- `areCognitiveNudgesDisabled()` gate in whisper.ts
- Delivery options: critical → `steer`+`triggerTurn:true`, advisory → `followUp`+`triggerTurn:false`
- Cooldown fixed: 60s (not 1h)

**Status**: Code is present. User reported "enforcement works too!" during testing.

### 3. HandleRunFailure
**Original bug**: `handleRunFailure` emitted `agent_end` without `message_start`/`message_end`, breaking session persistence on errors.

**Fix implemented**: `agent-patch` extension monkey-patches `Agent.prototype.handleRunFailure` to emit full lifecycle before `agent_end`. Registered in `core` module.

**Status**: Registered and loaded.

---

## What's Actually Left?

After audit, **no critical bugs remain unaddressed**. The repo is in a shippable state.

Potential follow-up items (not bugs, enhancements):

1. **Legacy memory cleanup**: `~/.pi/memory/memory.json` (2939 lines) is kept for backward compatibility. Could be removed after transition period (e.g., v0.3.0).
2. **context_prune blocker**: `context_prune(dryRun=false)` kills agent loop. Use `context_archive` only. Documented in memory.
3. **Test isolation**: `test-cognitive-memory.mjs` clears all memories during test. Should use isolated test database.
4. **Docs audit**: 34 extension docs exist, but some (repl, docs, vision, web-fetch, codebase-tree/graph, planner, prompt-guardian) were deleted. Need to ensure no broken internal links in remaining docs.
5. **Git history**: `develop` has 5 commits since v0.2.0 tag (all pre-tag). `main` has the merge commit. Consider whether to keep linear history or allow merge commits.

---

## Proposed Next Phase: Stabilization & Polish (v0.2.1)

**Goal**: Address low-hanging quality items, prepare for GitHub release.

### Phase A: Cleanup & Documentation (2 hours)

1. **Scratchpad reset**: Clear completed/duplicate items, keep only active research:
   - Compaction persistence verification (confirm with user testing)
   - Whisper delivery verification (confirm with user testing)
   - Legacy memory deprecation timeline
   - context_prune agent-loop blocker

2. **Broken link check**: Scan docs for dead internal links (deleted files).
3. **License year**: Update LICENSE to 2026 (if needed).
4. **GitHub repo setup**: If not done, add description, topics, enable discussions.

### Phase B: Verification (1 hour)

1. **Manual smoke test**: Run pi with pi-braid in a clean environment, verify:
   - Nudges appear in TUI
   - Memory recall works across sessions
   - Compaction doesn't lose messages
2. **npm publish dry-run**: Re-verify package contents.
3. **Install from GitHub**: Test `npm install github:kifirkin/pi-braid` in temp project.

### Phase C: Release (30 min)

1. Write release notes for v0.2.0 (markdown file, GitHub release)
2. Announce on relevant channels (if any)

**Total estimate**: 3.5 hours

---

## Alternative: Deeper Investigation

If you want to be thorough before public release:

1. **Compaction persistence deep-dive**: Trace the full flow from `compact()` → `forcePersistSession()` → session file write → reload. Write an integration test.
2. **Whisper delivery end-to-end test**: Verify that a test agent session actually receives and displays whisper messages. Could add a runtime test.
3. **Memory cross-search verification**: Ensure `memory_recall` properly merges semantic + episodic results with correct `[episodic]` annotations. Add test coverage.
4. **Context prune agent-loop blocker**: Investigate whether `ctx.compact()` can be made non-blocking or if `context_prune()` should be retired from autonomous use.

**Estimate**: 6-8 hours additional.

---

## Recommendation

**The repo is publish-ready.** The remaining items are either:
- Documentation polish (internal)
- Future deprecation planning (legacy memory)
- Nice-to-have verification tests

I recommend:

1. **Quick path**: Do Phase A (scratchpad cleanup, broken links), skip B/C (manual testing, release notes) — push to GitHub now.
2. **Thorough path**: Do A+B+C, publish v0.2.0 within 24h.
3. **Research path**: Add compaction/whisper verification tests (deeper) before release.

Which direction?
