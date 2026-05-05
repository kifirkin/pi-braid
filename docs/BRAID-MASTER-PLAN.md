# pi-braid Master Plan — Consolidated Tracking

**Last updated**: 2026-05-05
**Total tracks**: 9 (5 done, 3 partial, 4 not started)
**Purpose**: Single source of truth. Any session can restore context and continue work.

---

## How to Restore in Any Session

```bash
# Quick status
memory_recall(query="pi-braid master plan")

# Full plan
cat docs/BRAID-MASTER-PLAN.md

# Recent work
git log --oneline -15

# Verify nothing broken
npm run build && npm test
```

---

## Quick Status Table

| # | Track | Status | Priority | Est. Effort | Dependencies |
|---|-------|--------|----------|-------------|--------------|
| 1 | Self-Evolution + Consolidation | 🔴 Not started | P0 | 3-4 weeks | None |
| 2 | Hierarchical Memory Compression | 🟡 Partial | P1 | 1-2 weeks | Track 1 (SOP storage) |
| 3 | Bidirectional Verifier | 🟡 Phase 1 done | P3 | 3-5 days | None |
| 4 | Agent Timer / Pomodoro | 🟡 Core done | P1 | 2-3 days | None |
| 5 | SAE Steering | 🔴 Research only | P2 | 2-4 weeks | Open model provider |
| 6 | Benchmark Improvements + VAR-MATH | 🟡 SDK harnesses done | P1 | 1 week | None |
| 7 | Test Coverage (critical libs) | 🟡 Partial | P1 | 3-5 days | None |
| 8 | Event Bus Gaps | ✅ Complete | P2 | — | Track 9 |
| 9 | Docs Catch-Up | 🟡 In Progress | P3 | In progress | All tracks |

---

## Track Details

### Track 1: Self-Evolution Loop + Consolidation Channel ⭐ P0

**Merges**: `SELF-EVOLUTION-META-COGNITION-PROPOSAL.md` + `CONSOLIDATION-CHANNEL-PHASE3-PROPOSAL.md`
**Status**: 🔴 Not started

**What exists**:
- ✅ `mars-reflector.ts` — MARS single-cycle reflection module
- ✅ `belief-policy-engine.ts` — D0 belief store for principles
- ✅ `three-memory-stores` — episodic memory for SOPs
- ✅ Tool call tracking (enforcement/tool-tracker)
- ✅ `agent-events.ts` — signal taxonomy

**What's missing** (three phases):

Phase 1 — Trajectory Verification & SOP Extraction (Week 1):
```
Task:
  1. Add outcome tracking to heartbeat/analytics (track task success/failure)
  2. Implement SOP extraction from successful trajectories
  3. Store SOPs in procedural memory (three-memory-stores)
  4. Implement principle extraction from failures → belief store

Files to create/modify:
  - src/extensions/heartbeat/analytics/ → add outcome tracking
  - src/lib/cognitive-memory/ → SOP storage format
  - src/extensions/evolve/ → trajectory verification handler
```

Phase 2 — Retrieval & Suggestion (Week 2):
```
Task:
  5. On new task, query procedural memory for similar SOPs
  6. Surface relevant SOP to agent before execution
  7. Monitor principle violation during execution
  8. Metrics: retrieval rate, adherence rate, task improvement
```

Phase 3 — Consolidation Channel (Weeks 3-4):
```
Task:
  9. Implement consolidation channel (episodic → semantic transfer)
  10. Lightweight weight update mechanism (LoRA or fine-tuning trigger)
  11. Full self-evolution loop integration
  12. Benchmark validation
```

**Key papers**: MARS (2601.11974), ACE (2510.04618), GenericAgent (2604.17091), Contextual Agentic Memory (2604.27707)

---

### Track 2: Hierarchical Memory Compression 🟡 P1

**Based on**: `HIERARCHICAL-MEMORY-COMPRESSION-PROPOSAL.md`
**Status**: 🟡 Partial

**What exists**:
- ✅ Compaction v0.23+ (dedup guard, LLM summarization, clear on complete/abort)
- ✅ `filter-safe-to-remove` — injection-stripping
- ✅ `injection-tracker` — tracks all injected messages

**What's missing**:
```
Task:
  1. Implement semantic unit classification (short/medium/long message classification)
  2. Add adaptive compression ratio based on information density
  3. Wire compression level to context-full detection
  4. Store compression metadata for retrieval quality scoring
```

**Key papers**: GenericAgent (2604.17091), Experience Compression Spectrum (2604.15877), SimpleMem (2601.02553)

---

### Track 3: Bidirectional Verifier 🟡 P3

**Based on**: `BIDIRECTIONAL-VERIFIER-PROPOSAL.md`
**Status**: 🟡 Phase 1 done

**What exists**:
- ✅ `verify` tool — 3 depth modes, heuristic + LLM verification
- ✅ Wired into `finalize` pre-flight check

**What's missing**:
```
Task:
  1. Add backward verification: after root-cause fix, check derived files for consistency
  2. Track file dependency graph between edits
  3. Inject derived-file check into enforcement/verification nudge
  4. Add to benchmark scoring
```

---

### Track 4: Agent Timer / Pomodoro 🟡 P1

**Based on**: `AGENT-TIMER-POMODORO.md`
**Status**: 🟡 Core tools done

**What exists**:
- ✅ `timer_set` tool — non-blocking timer
- ✅ `timer_list` — active timers
- ✅ `timer_cancel` — cancel before fire
- ✅ Heartbeat scheduler integration
- ✅ Enforcement whisper delivery on timer fire

**What's missing**:
```
Task:
  1. Add Pomodoro-style agent pacing (auto-set focus timers)
  2. Add break reminders after N consecutive turns
  3. Add session planning integration (estimate time per task)
  4. Add timer analytics (task time estimation accuracy)
```

---

### Track 5: SAE Steering 🔴 P2

**Based on**: `SAE-STEERING-PROPOSAL.md`
**Status**: 🔴 Research only

**Blocked on**: API providers (stepfun/minimax) don't expose model internals.
Need open model (Llama 3 via Ollama, Qwen via local) for activation extraction.

**What's missing**:
```
Task:
  1. Feasibility: test logprob access on current providers
  2. If blocked: switch to open model for research worktree
  3. Implement TransformerLens activation extraction
  4. Apply open-source SAEs for steering vectors
  5. Test: sycophancy suppression, epistemic stability enhancement
```

---

### Track 6: Benchmark Improvements + VAR-MATH 🟡 P1

**Merges**: `BENCHMARK-IMPROVEMENTS-PROPOSAL.md` + `VAR-MATH-VARIANTS.md`
**Status**: 🟡 SDK harnesses done

**What exists**:
- ✅ BM1/evaluation/bm1-sdk.mjs — multi-turn debugging (5 tasks)
- ✅ BM2/evaluation/bm2-sdk.mjs — code quality (3 tasks)
- ✅ BM3/evaluation/bm3-sdk.mjs — real-world tasks (5 tasks)
- ✅ BR1/evaluation/br1-sdk.mjs — self-reflection (5 trap tasks)
- ✅ BR4/evaluation/br4-sdk.mjs — latent activator comparison
- ✅ PB4/evaluation/pb4-sdk.mjs — compliance measurement

**What's missing**:
```
Task:
  1. Add contamination resistance (shuffle task order, inject distractor tasks)
  2. Implement VAR-MATH variant generation (problem variants per skill)
  3. Improve scoring: check actual tool call sequences, not text mentions
  4. Add retry logic for API timeouts
  5. Add cross-benchmark comparison reports
```

---

### Track 7: Test Coverage (Critical Libs) 🟡 P1

**Status**: 🟡 Partial (55 tests pass, core libs untested)

**Untested libraries (from SELF-REFLECTION.md audit)**:
```
Priority order:
  1. src/lib/cognitive-memory/storage.ts (58L) — memory persistence
  2. src/lib/cognitive-memory/index.ts (602L) — core memory system
  3. src/lib/degradation-detector.ts (328L) — drives degrade decisions
  4. src/lib/state-checkpoint.ts (306L) — rollback infrastructure
  5. src/lib/filter-safe-to-remove.ts (251L) — injection filtering
  6. src/lib/belief-store.ts (252L) — policy engine state
```

**Each needs**: unit tests covering normal paths + error cases + edge cases.

---

### Track 8: Event Bus Gaps ✅ P2 — Complete 2026-05-05

**Status**: ✅ Complete

**Gap 1 (memory_evict handler)**: Was already wired — `MemoryEvictEvent` defined in `event-bus.ts`, emitted from `compaction.ts:241`, handler `onMemoryEvict` in `event-consumers.ts`, registered in `registerEventConsumers()`, and wired into `observatory.ts`.

**Gap 2 (proactive context_full detection)**: Implemented. `context-hygiene.ts` now tracks a sliding window of token-usage snapshots, computes tokens-per-turn growth rate, and projects when context will hit 85% usage. When ≤10 turns remain, emits a `context_full` event with projected usage and sends a whisper to the agent.

**Gap 3 (analytics_alert event)**: Created `AnalyticsAlertEvent` type in `event-bus.ts`, handler `onAnalyticsAlert` in `event-consumers.ts` (tracks count + recent alerts), wired 3 emission sites in `analytics/index.ts` (tool addiction pattern → `"addiction"`, degradation detected → `"degradation"`, recovery → `"recovery"`), and wired into `observatory.ts` for 3D visualization.

**Gap 4 (session_start lazy-loading)**: Was already done — `session-start-queue.ts` fully implemented with 3-tier phases (CoreInit/MemoryState/Background). All 14+ extensions migrated; zero raw `pi.on("session_start")` calls remaining in `src/`.

---

### Track 9: Docs Catch-Up 🟡 P3

**Status**: 🟡 In Progress

**What's been done (2026-05-05)**:
- ✅ **proposals/README.md** rewritten with per-proposal status (✅ implemented / ❌ abandoned / 🔴 not started / 🟡 partial), priorities, and file references
- ✅ **BRAID-MASTER-PLAN.md** (this doc) updated — Track 8 marked complete, P2 commit cb0c6c50
- 🟡 **SELF-REFLECTION.md** still needs stale-claim fixes (claims `file_diff`, `system_monitor`, `tool_error` are missing — they all exist)

**What still needs updating**:
```
Task:
  1. Update SELF-REFLECTION.md (stale missing-tool claims — file_diff, system_monitor, tool_error all exist)
  2. Mark IMPLEMENTATION.md as superseded by this master plan (or remove)
```

---

## Commit Log (Last 30, for context)

```
6dff09d4 fix: error handling + L1 turn count persistence
0d5a41a2 docs: update pi-reference skill
59faf02d refactor: pi-native tool listing, preview, active-mode
dd572b95 refactor: tone-quality directive-density
397965f7 restore: SYCOPHANCY_RESISTANCE + STAKES_AWARENESS
aec53043 refactor: strip dead sections, fix appendSystemPrompt
a7f85b18 fix: tool descriptions, empty proxy calls
933d6a2d refactor: remove scratchpad, rewrite preview
```

---

## Memory Recall (for cross-session restoration)

```bash
memory_recall(query="pi-braid master plan")
# → Returns this plan's key content
# → Use git log, cat docs/BRAID-MASTER-PLAN.md for full details
```

*End of Master Plan*
