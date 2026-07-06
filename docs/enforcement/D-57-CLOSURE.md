# D-57: Enforcement Whistle Audit — Closure Report

<!-- status: closed -->
<!-- Generated: 2026-07-06 -->
<!-- Commits: 7a9ff662 (phase 2), 86bbdaa3 (tool-loop fix), 29f24543 (per-turn sets) -->

> **What**: Systematic audit of the L2 enforcement whisper system, determining
> which signals require runtime detection and which are redundant with static
> instructions (tool descriptions + system prompt).
>
> **Result**: All 8 remaining whispers are genuinely runtime-dependent. No
> further removals justified. D-57 is fully closed.

---

## Phase 1: Enrich Tool Descriptions (✅ Done)

**Commit**: `7a9ff662` (included in the phase 2 commit)

Enriched 7 tool descriptions with static instruction guidance that previously
lived as L2 whispers:

| Tool | Description Addition |
|------|---------------------|
| `think` | "Required before editing, writing files, or making high-stakes changes" |
| `finalize` | "Must call at the end of every task or significant subtask — never finish work without finalizing" |
| `verify` | "Call after every edit or write to check changes before moving on" |
| `scratchpad` | "Before starting work, use set_goal to define the objective and add_plan to break into steps" |
| `memory_store` | "Call this after discovering a reusable pattern, fixing a subtle bug, learning a project convention, or identifying a root cause" |
| `context_compress` | Full pipeline guidance: tag → archive → compact last resort |
| `context_navigate` | Pipeline guidance: tag before archival |

**Rationale**: Tool descriptions are read by the agent on every tool call.
They are the highest-validity location for usage instructions — higher than
runtime whispers which the agent may ignore or miss.

---

## Phase 2: Remove Redundant Whispers (✅ Done)

**Commit**: `7a9ff662`

Removed 7 `sessionSignals.push()` calls and their corresponding
`sendEnforcementWhisper` calls. State tracking fields preserved for
analytics and contrast-mode detection.

| Removed Whisper | Replaced By |
|----------------|-------------|
| Memory | `memory_store` tool description + `MEMORY_AWARENESS` system prompt |
| Scratchpad | `scratchpad` tool description + `COMPACTION_SURVIVAL` + `DEFINITION_OF_DONE` |
| Think (session) | `think` tool description |
| Think (per-turn) | `think` tool description |
| Finalize | `finalize` tool description + `DEFINITION_OF_DONE` |
| Verify | `verify` tool description + `DEFINITION_OF_DONE` |
| Startup | `IDENTITY_INTRO` + `INTERACTION_STYLE` system prompt |

---

## Phase 3: Audit Remaining Whispers (✅ Done — This Session)

### Audit Methodology

Each remaining whisper was evaluated against two criteria:
1. **Runtime dependency**: Does the signal require runtime state that cannot
   be known statically?
2. **Static coverage**: Is there a tool description or system prompt directive
   that already covers the behavior?

A whisper is justified only if (1) is true and (2) is false (or the runtime
signal is a safety net for a static instruction that may be forgotten).

### Audit Results

| # | Whisper | Location | Runtime Dep | Static Coverage | Verdict |
|---|---------|----------|-------------|-----------------|---------|
| 1 | **Error burst** | turn-end-handler.ts:91 | Yes — consecutive error tracking across turns | None needed (errors are exceptional) | ✅ **KEEP** |
| 2 | **Tool loop** | turn-end-handler.ts:107 | Yes — ordered tail-run detection | None (emergent pattern) | ✅ **KEEP** |
| 3 | **Context tokens** | sessionSignals bundle | Yes — live token/percent metrics | Pipeline guidance in tool descriptions | ✅ **KEEP** |
| 4 | **Context percent** | sessionSignals bundle | Yes — live usage percentage | Pipeline guidance in tool descriptions | ✅ **KEEP** |
| 5 | **Localization risk** | sessionSignals bundle | Yes — single-shot edit detector | None (heuristic result) | ✅ **KEEP** |
| 6 | **Orphan chains** | turn-end-handler.ts:168 | Yes — chain tracking across turns | None (chain structure is emergent) | ✅ **KEEP** |
| 7 | **Redundancy** | turn-end-handler.ts:147 | Yes — file-content similarity | None (content-dependent) | ✅ **KEEP** |
| 8 | **Critical signals (L3)** | turn-end-handler.ts:155 | Yes — multi-signal composition | None (validation result) | ✅ **KEEP** |
| 9 | **Missing verification** | turn-end-handler.ts:119 | Partial — detect code-change without verify | verify tool description + DEFINITION_OF_DONE | ✅ **KEEP** as safety net |

### Detailed Analysis

#### 1. Error Burst
- **What**: `consecutiveErrorTurns >= ERROR_BURST_THRESHOLD (3)`
- **Why runtime**: Error counts are session-level state, updated per turn.
  The agent cannot self-detect "I've had 3 error turns in a row."
- **Why not static**: Error patterns are unpredictable. No static instruction
  can substitute for real-time detection.
- **Verdict**: KEEP. Critical signal.

#### 2. Tool Loop
- **What**: `detectToolLoop()` — ordered tail-run history check
- **Why runtime**: The detector tracks ordered tool-call history across turns.
  The agent cannot self-detect "I've called the same tool 8 times in a row."
- **Why not static**: Loop patterns are emergent. The tool-description
  instruction already says "use think() before edit" which is the corrective
  action — but the detection itself must be runtime.
- **Verdict**: KEEP. Confirmed working (fired during this session's audit).

#### 3-4. Context Tokens / Percent
- **What**: Token-count and percentage-based context usage warnings
- **Why runtime**: Context usage metrics come from `event.message` and are
  only available at turn-end. The agent cannot know its own context usage.
- **Static coverage**: Tool descriptions (`context_compress`, `context_navigate`)
  already carry the full pipeline guidance (tag → archive → compact). The
  runtime whisper provides the *trigger* (usage threshold) and reinforces
  the pipeline instruction.
- **Verdict**: KEEP. The trigger is runtime; the instruction reinforcement
  is a valid safety net even though the instruction itself is in the tools.

#### 5. Localization Risk
- **What**: Single-shot edit pattern detected by edit-detector heuristic
- **Why runtime**: The signal fires only when the heuristic finds a pattern
  (single file edit that might need corresponding changes elsewhere).
- **Why not static**: The heuristic result is computed per turn.
- **Verdict**: KEEP. Runtime-only signal.

#### 6. Orphan Thought Chains
- **What**: `detectOrphanChains()` — thought chain tracking
- **Why runtime**: Chain structure is tracked across turns via
  `thoughtChainState`. The agent cannot self-detect orphan chains.
- **Why not static**: Chain structures are emergent.
- **Verdict**: KEEP. Runtime-only signal.

#### 7. Redundancy Detection
- **What**: `detectRedundancySignal()` — file-content similarity check
- **Why runtime**: Requires loading file content and comparing with recent
  changes. The agent cannot self-detect "I'm rewriting the same content."
- **Why not static**: Content-dependent.
- **Verdict**: KEEP. Runtime-only signal.

#### 8. Critical Signals (L3)
- **What**: `handleCriticalSignals()` — multi-signal composition with
  `validateTurn()` validation
- **Why runtime**: Combines multiple runtime signals (error burst, tool loop,
  context overflow, etc.) with turn-level validation.
- **Why not static**: Validation is a function of runtime state.
- **Verdict**: KEEP. Critical signal composition.

#### 9. Missing Verification
- **What**: `detectMissingVerification()` — checks if code was changed
  without verify in the same turn
- **Why runtime**: Detects specific turn-level pattern (edit/write without
  verify). The static instruction exists in `verify` tool description
  ("Call after every edit or write") and `DEFINITION_OF_DONE` system prompt.
- **Why KEEP as safety net**: The static instruction is the primary mechanism.
  The runtime check is a safety net that catches cases where the agent
  forgets. This is the same pattern as the context usage signals — static
  instruction in tool descriptions, runtime trigger as backup.
- **Verdict**: KEEP as safety net. Low frequency (only fires when agent
  actually forgets).

---

## Final Tally

| Category | Count |
|----------|-------|
| Whispers moved to static instructions (Phase 2) | 7 |
| Whispers remaining as runtime detection | 8 |
| Whispers identified as redundant | 0 (Phase 3) |
| **Total** | **15 original signals** → **all accounted for** |

---

## D-57: Key Learnings

1. **Tool descriptions are the right surface for usage instructions.** The
   agent reads them on every tool call. Runtime whispers add noise when the
   same instruction lives in a tool description.

2. **Runtime detection is only justified for emergent patterns.** Error
   bursts, tool loops, context usage, orphan chains — these cannot be
   predicted or self-detected by the agent. Everything else should be a
   static instruction.

3. **Safety nets are valid.** The missing-verification and context-usage
   signals are safety nets for static instructions. They fire infrequently
   (only when the agent forgets) and reinforce the instruction at the moment
   of need. This is a different pattern from the removed whispers which
   fired predictably.

4. **State tracking should be preserved even when whispers are removed.**
   The cooldown counters, `startupPlanShown`, and nudge-analytics fields
   remain active. They feed `determineContrastMode()` and MARS analysis
   even when the whisper itself is suppressed.

---

## Files Touched

| File | Change |
|------|--------|
| `src/extensions/enforcement/handlers/turn-end-handler.ts` | Added D-57 suppression comments, removed 7 whisper calls |
| `src/extensions/cognitive/metacognition/handlers/think.ts` | Enriched description (D-57 phase 1) |
| `src/extensions/cognitive/metacognition/handlers/finalize.ts` | Enriched description (D-57 phase 1) |
| `src/extensions/cognitive/metacognition/handlers/verify.ts` | Enriched description (D-57 phase 1) |
| `src/extensions/memory/scratchpad/index.ts` | Enriched description (D-57 phase 1) |
| `src/extensions/memory/memory-agent-bridge/memory-store-tool.ts` | Enriched description (D-57 phase 1) |
| `src/extensions/memory/context-manager/handlers/tools/context-compress.ts` | Enriched description (D-57 phase 2) |
| `src/extensions/memory/context-manager/handlers/tools/context-navigate.ts` | Enriched description (D-57 phase 2) |
| `src/lib/detection/tool-loop-detector.ts` | Bugfix: ordered history, per-turn entries (86bbdaa3) |
| `docs/enforcement/D-57-CLOSURE.md` | This document |

---

## D-57: CLOSED

No further enforcement-whisper work justified. All 15 original signals are
accounted for: 7 moved to static instructions, 8 kept as runtime detection.
The system is leaner (fewer whispers per turn) while maintaining the same
safety net coverage.