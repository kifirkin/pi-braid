<!-- status: historical -->
<!-- archived: 2026-07-04. Full whisper catalog + 15 EW-7 proposals — all actionable items reproduced in ROADMAP §4. Catalog preserved for historical reference. -->

# Enforcement Whisper Content & Taxonomy Audit (Archived)

**Date:** 2026-06-17
**Scope:** The full set of agent-readable whisper messages produced by the
enforcement layer and its cross-extension collaborators. Covers message
*content* (templates, tags, prefixes), *triggers* (which events/conditions
fire each message), and *taxonomy* (the NudgeType system, dedup layering,
priority tiers). **Does not duplicate** `docs/archive/WHISPER-AND-LOGGING-AUDIT.md`
(archived 2026-06-17), which covered delivery plumbing (`sendTrackedMessage`,
flood caps, re-entry guard, bypass flags). For current actionable items
from this audit, see [`docs/ROADMAP.md`](ROADMAP.md) §4 (the 15 §7 proposals
are reproduced there).

**Companion files:**
- `docs/ROADMAP.md` — current actionable roadmap; this audit's §7 proposals are reproduced as items EW-7.1 through EW-7.15
- `docs/archive/WHISPER-AND-LOGGING-AUDIT.md` (archived) — delivery mechanism, `sendTrackedMessage`, flood cap
- `src/extensions/enforcement/AGENTS.md` — layer architecture overview
- `src/extensions/enforcement/nudge-manager.ts` — NudgeType definitions
- `src/lib/enforcement/turn-dedup.ts` — turn-scoped dedup registry

## Summary

| Dimension | Count | Notes |
|---|---|---|
| Files in `extensions/enforcement/` | 32 (.ts) | largest extension in pi-braid |
| `sendEnforcementWhisper` call sites | 18 | the wrapper, all in `enforcement/` + 2 cognitive extensions |
| `sendTrackedMessage` call sites (cross-extension, agent-facing) | 33+ | memory, heartbeat, timer, self, cognitive |
| Distinct whisper message templates | **~35** | full inventory in §3 |
| `triggerTurn: true` (hard-wake) sources | 13 | agent must respond this turn |
| NudgeType values defined | 16 | only 2 actively used — see §6.1 |
| Dedup mechanisms | 3 layered | per-type cooldown, hash, turn-category |
| Flood-cap priority tiers | 4 | critical=5, high=3, medium=2, low=1 |
| Per-source cap (per turn) | 2 | applies to all priorities including critical |
| `braid.suppressNudges` coverage | partial | only enforcement+heartbeat check it; see §6.5 |
| Re-entry depth floor | 1 | `queueMicrotask` deferral to break sync chains |
| Injection bucket size | 200/session | tracked for observability, not delivered |
| Retained L1 signal horizon | 1 turn back | `pruneSignals` — see §6.8 |
| Calibration-pair ring buffer | 50 | oldest evicted first |

**Verdict: ✅ The system is internally consistent and well-tested (5
enforcement test files, structural dep test). The wrapper-vs-trunk split is
clean. The issues are scoping and completeness, not correctness.**

## 1. Architecture

### 1.1 Two delivery APIs, one trunk

| API | Defined in | Used by | Channel |
|---|---|---|---|
| `sendEnforcementWhisper(pi, ctx, msg, critical?)` | `src/extensions/enforcement/whisper.ts:34` | the `enforcement/` extension + 2 cognitive extensions | wraps `sendTrackedMessage`; always `deliverAs: "steer"`, `customType: "enforcement"`, prefix `[enforcement] ` |
| `sendTrackedMessage(pi, params, options, meta, bypass?)` | `src/lib/utils/injection-tracker.ts:174` | every other extension | canonical path; subject to flood cap + re-entry guard + dedup |

`sendEnforcementWhisper` is a thin wrapper that:
- Short-circuits if `areCognitiveNudgesDisabled()` returns true
- Increments the A/B analytics counter (`recordNudgeSent`)
- Emits a synthetic `enforcement_violation` to `eventBus` (always non-error severity)
- Selects `triggerTurn: true` only when the caller passes `critical: true`
- Always prepends the `[enforcement] ` text prefix (in addition to `customType: "enforcement"`)

**`sendEnforcementWhisper` is called by 18 sites across 8 files. Both
`sendEnforcementWhisper` and the cross-extension `sendTrackedMessage` callers
funnel through the same `lib/utils/injection-tracker.ts` orchestrator.** See
`docs/archive/WHISPER-AND-LOGGING-AUDIT.md` (archived 2026-06-17) for the
trunk-side details.

### 1.2 The 3-layer dedup system

A single whisper is gated by three layered mechanisms. The interaction between
them is not documented anywhere in the codebase — this is the first place.

| Layer | Module | Scope | Purpose |
|---|---|---|---|
| 1. Per-type cooldown | `extensions/enforcement/nudge-manager.ts` `NudgeManager.shouldSendNudge` | per session, per `NudgeType` | rate-limit per category (e.g. `validation: 20s`, `scratchpad: 60s`) |
| 2. Hash dedup | `lib/utils/dedup.ts` `hashForDedup` (SHA-1 → 16 base64url chars) | per session, per `NudgeType` (via `NudgeManager.history`) | block identical text within a category |
| 3. Turn-category registry | `lib/enforcement/turn-dedup.ts` `tryClaim` | per turn, per category (`loop` / `advisory` / `default`) | block parallel low-priority claims; e.g. if `turn-outcome` already claimed `loop`, `dreamer` is suppressed |

Plus an **orthogonal** layer 4: the `WHISPER_CAPS` flood cap in
`tryWhisper`, which caps total whispers per priority tier per turn.

A whisper must pass all four gates to be delivered. Suppressed whispers are
still `trackInjection()`-ed (with `display: false`) so the user can see what
was filtered. The Q&A budget per turn is effectively:

| Priority | Total cap | Per-source cap | Notes |
|---|---|---|---|
| `critical` | 5 | 2 | `auto-recovery`, `turn-outcome/loop`, `timer/fire` |
| `high` | 3 | 2 | `enforcement/whisper`, `exhausted`, `compaction-retry`, `context-manager/rotation`, anything with `triggerTurn: true` |
| `medium` | 2 | 2 | `analytics`, `navigation`, `context-full`, `register-session-start` |
| `low` | 1 | 2 | hints, suggestions, dreamer, drift, mars, BPE |

The `bypassFloodCap: true` flag is reserved for user/agent-contracted events
(timer fires, post-compaction resume). Only `scheduling/timer/index.ts` uses
it. See `docs/archive/WHISPER-AND-LOGGING-AUDIT.md` (archived 2026-06-17)
§"Bug discovered: silent drop of timer fires" for the rationale.

### 1.3 Turn-scoped dedup categories

From `lib/enforcement/turn-dedup.ts:25-37`:

| Category | First claim wins | Members |
|---|---|---|
| `loop` | `tryClaim("dreamer", "loop")` and `tryClaim("turn-outcome", "loop")` | dreamer, turn-outcome (so dreamer doesn't double-fire on a confirmed loop) |
| `advisory` | `tryClaim("bpe", "advisory")` / `tryClaim("drift", "advisory")` / `tryClaim("mars", "advisory")` | bpe, mars, drift (first one wins) |
| `default` | — | everything else |
| `stability` | (reserved, no current consumer) | BPE stability-decline, MARS stability-decline |

The registry is cleared on the `input` event via `beginTurn()` (registered
from `handler-registry.ts:75-77`).

## 2. State Architecture

The composed `EnforcementState` (in `state.ts`) is an intersection of 7
sub-states. The structural test in `test/runtime/lib/test-enforcement-deps.mjs`
enforces the import contract: `state.ts` imports sub-state factories/resets;
sub-state files do **NOT** import from `state.ts`. The
`enforcement-types.ts` file exists to break the circular dep.

| Sub-state | File | Owns |
|---|---|---|
| `SessionState` | `substate/session-state.ts` | `currentTurn`, `turnHistory`, `driftDetector`, `lastCalibrationWhisperTime`, `pendingConflictIds`, `conflictDetectionTurn` |
| `ToolTrackingState` | `substate/tool-tracking-state.ts` | `totalToolCalls`, `uniqueToolsUsed`, `toolChain`, `toolSequencePatterns`, `recentlyReadFiles`, `calibrationPairs`, `lastRecommendationType`, `_localizationRisk` |
| `ErrorTrackingState` | `substate/error-tracking-state.ts` | `consecutiveErrorTurns`, `validationFailures`, `lastNudgeTime`, `nudgeCooldownMs`, `escalationCounts` |
| `MemoryHygieneState` | `substate/memory-hygiene-state.ts` | `lastMemoryCall`, `turnsSinceMemory`, `memoryNudgeSent` |
| `ScratchpadState` | `substate/context-hygiene-state.ts` | `lastScratchpadNudgeTurn`, `claimsDetectedThisTurn`, `verificationsDone` |
| `ContextHygieneState` | `substate/context-hygiene-state.ts` | `contextNudgeSent`, `lastContextCheckTurn`, `overflowRecently`, `contextCheckInterval` |
| `ThoughtChainState` | `substate/thought-chain-state.ts` | `thoughtChains`, `toolsSinceReflection`, `silentTurns` |
| `VerificationJudgeState` | `substate/verification-judge-state.ts` | (helpers only) |

The composed state is **session-scoped** via
`getExtensionState(ctx, "enforcement", createState)`. Module-level `let` is
banned for stateful data (per root AGENTS.md user preferences).

`ENFORCEMENT_PARAMS` (`enforcement-types.ts:18-30`) is the central tunable
config: `memoryNudgeThreshold: 15`, `maxSilentTurns: 6`,
`warnOnToolSequenceRepetition: 3`, `judgeCooldownMs: 20000`,
`judgeSkipTurns: 1`, `verificationJudgeInterval: 15`,
`maxClaimsBeforeVerification: 5`, `blockExploreBeforeWrite: true` (the last
is **dead — see §6.2**).

## 3. Full Whisper Inventory

I count **~35 distinct whisper message types** that braid can deliver to
the agent. Each entry shows the **trigger event**, **file:line**, **prefix
tag** (text-bracket), **priority/wake policy**, and **message template**.

### 3.1 Enforcement-extension handlers (18 `sendEnforcementWhisper` sites)

| # | Tag | File:line | Trigger | Wake | Message template |
|---|---|---|---|---|---|
| 1 | `[enforcement]` | `whisper.ts:75` | every `sendEnforcementWhisper` | depends on `critical` | `[enforcement] ${message}` (always-on wrapper prefix) |
| 2 | (no tag) | `turn-end-handler.ts:60` | `consecutiveErrorTurns == 3` | **triggerTurn: true** | `Error burst detected: ${n} consecutive errors. Consider stepping back.` |
| 3 | `[Quality]` | `turn-analysis.ts:65` | current turn's `edit`/`write` finds a >70% similar file already known | low | `[Quality] Similar code exists at \`${path}\`. Reuse or deduplicate.` |
| 4 | (validation) | `turn-analysis.ts:91-97` | `validateTurn` returns `passed: false`, gated by `NudgeManager.shouldSendNudge("validation", nudge)` | low | `## Turn Validation Failed\n\n- ${issues}` (when escalated, the wrapper prepends `**Escalated:** `) |
| 5 | (recordFailure) | `turn-analysis.ts:106-118` | `erroredTools.size > 0`, `turnsSinceError >= 3`, `!hasRecordedFailure` | low | `${toolList} failed. Record this to avoid repeating: memory_store(content="Error with ${toolList}: [what went wrong and fix]", tags=["error"])` |
| 6 | `[chains]` | `turn-end-handler.ts:189` | `detectOrphanChains` returns ≥1 chain with 3+ thoughts and no `conclusion`/`reflection` | low | `[chains] ${n} reasoning chain(s) without conclusion: ${chain0}` |
| 7 | `[Session Signals]` | `turn-end-handler.ts:362-365` | bundle of L2 signals, gated by `getNudgeManager().shouldSendNudge("scratchpad", bundled)` | low | multi-line list of memory/scratchpad/think/context/localization signals (see §5.1) |
| 8 | `[conflict]` | `register-message-end.ts:41` | new `detectConflicts()` results | low | `formatConflictMessage(conflict)` → `[conflict:${classification}] Sources disagree: "${claim}". ${forSource} (rel X) vs ${againstSource} (rel Y). Consider acknowledging: "Sources disagree on X. Based on Y, I conclude Z."` |
| 9 | `[conflict]` | `register-message-end.ts:58` | every 5 unresolved conflicts | low | `[conflict] ${n} unresolved source conflicts. Consider resolving: memory_store content with conflict_verified tag.` |
| 10 | `[conflict-qa]` | `register-message-end.ts:67` | `processConflictQAs` returns QAs | low | `[conflict-qa] ${question}` |
| 11 | `[conflict]` | `register-message-end.ts:110` | pending conflict > 5 turns old | low | `[conflict] Conflict ${id} unresolved for ${n} turns. Consider resolving explicitly.` |
| 12 | `[FAIL/WARN] VERIFICATION JUDGE` | `register-message-end.ts:203` | `runVerificationJudge` returns `verdict !== "pass"` | low | multi-line block (icon, summary, issues with severity icons, *Confidence: N%*) |
| 13 | (API error) | `register-auto-retry-end.ts:41-48` | `auto_retry_end` with `success: false` | low | `## ⚠️ ${msg}\n\nStore for reference: memory_store(content="API error: ${finalError}", tags=["error", "api"])` |
| 14 | (re-orientation) | `register-session-compact.ts:73` | `unpersisted_learnings > 0` after compaction | low | `Context compacted at turn ${N}. ${n} key learning(s) not yet persisted:\n\n${list}\n\nPersist them now.` |
| 15 | (re-orientation, always) | `register-session-compact.ts:100` | every `session_compact` event | low | `Context compacted at turn ${N}. Re-orient: read scratchpad for goal/plan/learnings, then check next pending task. These surfaces survive compaction - continue from there.` |
| 16 | `[spec]` | `handler-registry.ts:162` | edits affect specs, `checkSpecCoverage` returns violations | low | `[spec] ${n} spec requirement(s) affected by recent edits:\n  - ${strength}: ${requirement}\n  ...` |
| 17 | (verification reminder) | `detection/verification.ts:40` | `pendingCodeChanges` and `turnsSinceCodeChange >= 12` | low | `You modified code but haven't verified it works. Run tests or commands to confirm your implementation is correct.\n\nYou verify code changes before declaring the task complete.` |
| 18 | (malformed tool) | `detection/malformed.ts:24-31` | `MALFORMED_TOOL_CALL_RE` matches an assistant message | low | `Malformed tool call detected: <${tool}> as TEXT. Use proper function calling format - do NOT output XML tags as plain text.` |
| 19 | `[calibration]` | `register-tool-result.ts:73` | 10+ calibration pairs, last 10 avg error > 0.5, 120 s cooldown | low | `[calibration] High prediction error: ${err}% off on last ${tool}. Avg error last 10 tools: ${avg}%` |
| 20 | `[enforcement]` (direct `sendTrackedMessage`) | `register-session-start.ts:42` | `eventBus.on("context_full", ...)` when `usagePercent > 80` | **triggerTurn: true** | `[enforcement] Context at ${pct}%. Consider context_navigate(action="tag") → context_compress(action="archive").` |

### 3.2 Enforcement analysis pipeline (`analysis/*.ts`)

These use `sendTrackedMessage` directly (bypassing `sendEnforcementWhisper`)
with `customType: "context"` and `source: "enforcement/<name>"`. They are
turn-dedup-coordinated via `tryClaim`.

| # | Tag | File:line | Trigger | Priority | Message template |
|---|---|---|---|---|---|
| 21 | `[policy]` | `analysis/bpe-handler.ts:53` | `getNextRecommendation` returns a rec, gated by `tryClaim("bpe", "advisory")` | low | `[policy] ${bpeRec.message}` (one of 7 templates from `lib/reasoning/policy-rules.ts` — see §5.2) |
| 22 | `[dream]` | `analysis/dreamer-handler.ts:41` | `dream()` returns advice, gated by `tryClaim("dreamer", "loop")` | low | one of three templates (current-loop / Markov stuck / Markov failure) |
| 23 | `[drift]` / `[drift-detector]` | `analysis/drift-handler.ts:75` | `driftDetector.check()` returns `drifted \|\| classifierDown`, gated by `tryClaim("drift", "advisory")` | low | one of two: `[WARN]/[SUBTLE] Topic drift detected...` or `[drift-detector] Classifier unavailable...` |
| 24 | `[mars]` | `analysis/mars-handler.ts:50` | `shouldAdvise(ctx)` returns advice, gated by `tryClaim("mars", "advisory")` | low | one of four templates (tool_overuse, error_recurrence, stability_decline) |
| 25 | (signal-only) | `analysis/reflection-handler.ts:34` | `toolsSinceReflection >= 8` | n/a | no whisper; only `emitSignal(ctx, "reflection", "absent", "info", ...)` |
| 26 | (signal-only) | `analysis/feedback-handler.ts:23-32` | every `turn_end` | n/a | no whisper; calls `inferBeliefs` + `evaluatePendingAdvice` |
| 27 | `[stability]` | `handlers/message-analysis.ts:93` (via `enforcementSignals`) | `measureStability` returns `!stable` | L1 signal | `[stability] Response ${reason} (overlap=..., entropy=..., contradictions=...)` — written into `enforcementSignals[key]`, not directly whispered; consumed by BPE/MARS in subsequent turns |
| 28 | (probe mismatch) | `handlers/message-analysis.ts:50-58` | `checkComplexityMismatch` returns `mismatch: true` | L1 signal | e.g. `Context at X% - consider simpler approach or /compact first` |
| 29 | (routing mismatch) | `handlers/message-analysis.ts:65-75` | `checkRoutingMismatch` returns `mismatch: true` | L1 signal | `For ${intent}, consider: ${tools}. ${warning}.` |
| 30 | `[localization]` | `turn-end-handler.ts:340` | `getState(ctx)._localizationRisk` non-empty (set by `checkLocalizationRisk` on edit) | L2 bundle | `[localization] ${_localizationRisk}` |
| 31 | `[self-consistency]` | `handler-registry.ts:141` | `processAgentResponse` returns contradictions | low | `[self-consistency] ${n} cross-turn contradiction${s} detected:\n  • Turn ${old}: ... → Turn ${new}: ... (contradicts)` |
| 32 | (burst-skipped) | n/a | when `consecutiveErrorTurns >= 3` (ERROR_BURST_THRESHOLD) | n/a | all L2 `sessionSignals` are wiped and most analyses short-circuit (see `turn-end-handler.ts:347-349`) |

### 3.3 Cross-extension whispers

These are sent by other extensions, not by `enforcement/`, but they ride the
same `sendTrackedMessage` trunk and the same flood-cap / dedup system. They
are **part of the agent's nudge stream** in practice.

#### Cognitive extensions

| # | Tag | File:line | Trigger | Wake | Message template |
|---|---|---|---|---|---|
| 33 | `VbC correction: ` | `cognitive/sycophancy-detector/index.ts:231` | `detectVbC` (heuristic) returns `detected: true`, risk above threshold, ≥3 turns since last | low | `VbC correction: ${vbcResult.correction_hint}` (capped at 10/session) |
| 34 | `[reasoning]` | `cognitive/reasoning/index.ts:170` | `hasCompletionClaim(text) && stable && lastVerifyReminderTurn + 5 <= turnCount` | low | `[reasoning] Response looks complete. Consider calling verify() to catch any issues before finalizing.` |
| 35 | `## Repetitive Loop Detected` | `cognitive/turn-outcome/index.ts:189-198` | `detectLoop()` returns non-null (LLM classify on tool-loop), 8-turn cooldown | **triggerTurn: true** | `## Repetitive Loop Detected\n\n- **Tool repetition**: Using \`${details}\` every turn for the last several turns. The outcome hasn't changed.\n\n**Suggested actions:**\n1. Use \`think()\` to re-evaluate your approach\n2. Check if the problem has changed - you may be solving the wrong issue\n3. Consider breaking the task into smaller steps\n4. Use the \`memory\` tool to find past solutions to similar problems` |
| 36 | `## Loop Detector Offline` | `cognitive/turn-outcome/index.ts:131-142` | `detectLoop()` returns `LOOP_DETECTOR_OFFLINE` sentinel (LLM failed) | low | `## Loop Detector Offline\n\nThe loop-detection classifier is unavailable this turn, so this check could not run normally. ...` |

#### Memory extensions

| # | Tag | File:line | Trigger | Wake | Message template |
|---|---|---|---|---|---|
| 37 | `[recall]` | `memory/three-memory-stores/handlers/whisper-recall.ts:89` | tool_result/turn_end with relevant past episodes, 120 s cooldown | low | `[recall] ${title}\n  ${icon}${crossMark}${conf} ${task}\n    Solution: ${solution}` |
| 38 | `[recall]` (cross-recall) | `memory/three-memory-stores/index.ts:313` | semantic recall hashes change | low | `[recall] Related memory:\n  [${type}] ${content}` |
| 39 | `[recall]` (reliability) | `memory/three-memory-stores/index.ts:230` | tool reliability drops by > 0.2 vs alt | **triggerTurn: true** | `[recall] ${bestAlt} has better reliability (${pct}%) for "${taskType}" than ${toolName} (${pct}%)` |
| 40 | `[recall]` (session) | `memory/session-recall/index.ts:532` | ≥5 file matches and same project | low | `[recall] Past session found: "${basename}" (${count} matches)` |
| 41 | (rotation nudge) | `memory/context-manager/handlers/rotation.ts:200` | session rotation triggered | **triggerTurn: true** | `## Session Size Notice\n\n${reason}\n\nThe session has grown large. To keep working smoothly:\n1. **\`finalize()\`** ...\n2. **\`context_archive(start, end, summary)\`** ...\n3. **\`memory_store(...)\`** ...\n\nTaking any of these actions will reset the session counter for 25 turns.` |
| 42 | (deep branch) | `memory/context-manager/handlers/rotation.ts:138` | branch length > 150, ≥ 50 turns or 5 min since last | low (followUp) | `## Session Branch Depth Notice\n\nThe current branch is ${N} entries deep. ...\n1. **\`context_tag\`** ...\n2. **\`session_compact\` / \`context_compress\`** ...\n3. **\`finalize()\`** ...` |
| 43 | `## Session Rotation Required` | `memory/context-manager/handlers/shared.ts:323` | `triggerEmergencyRotation` | **triggerTurn: true** | `## Session Rotation Required\n\nContext overflow detected. Automatic rotation triggered to prevent data loss.\n\nPlease call \`finalize()\` to complete this task and start fresh.\n\nRotation will happen automatically on next \`finalize()\`.` |
| 44 | (checkout prepared) | `memory/context-manager/handlers/navigation.ts:58` | `state.checkoutParams` set | **triggerTurn: true** | `**Context checkout prepared.** Run \`context_checkout(target="${params.target}")\` when ready.` |
| 45 | (overflow retry) | `memory/context-manager/handlers/compaction-retry.ts:63` | overflow retry attempt N/M | low | `## ⚠️ Context overflow recovery failed (attempt ${n}/${max})\n${errMsg}\n\nRetrying with more aggressive compaction...\n\nIf this persists:\n1. Switch to a larger-context model\n2. Run \`/model\` to verify settings\n3. Store learnings in memory and start a new session` |
| 46 | (overflow exhausted) | `memory/context-manager/handlers/compaction-retry.ts:96` | overflow retry attempts exhausted | **triggerTurn: true** | `## ⚠️ Context overflow recovery exhausted\n${errMsg}\n\nAfter ${N} attempts, compaction cannot reduce context enough.\nConsider switching models, starting a new session, or storing learnings in memory.` |
| 47 | (transient retry) | `memory/context-manager/handlers/compaction-retry.ts:149` | compaction throws | low | (transient retry, see file) |
| 48 | (transient exhausted) | `memory/context-manager/handlers/compaction-retry.ts:169` | transient retries exhausted | **triggerTurn: true** | `⚠️ Auto-compaction failed after retries (server overload): ${errMsg}` |
| 49 | (context window error) | `memory/context-manager/handlers/compaction-retry.ts:206` | session > model context limit | **triggerTurn: true** | `## ⚠️ Session too large\n${errMsg}\n\nThe session cannot be compacted because it exceeds the model's context limit.\nPlease use \`finalize()\` to rotate the session, or \`context_archive` to archive older work.` |
| 50 | (auto-retry) | `memory/context-manager/handlers/events.ts:158` | `auto_retry_end` with `success: false` | low | `## ⚠️ API retry failed after ${n} attempt(s)\n${err}\n\nThe API kept returning errors despite retries. ...` |
| 51 | `[compact]` | `memory/context-lifecycle/index.ts:171` | context ≥ 80%: `sendCompactNudge()`; or `nudge` action | low (default, no `options`) | `Context at ${pct}%. Pipeline: context_tag → context_checkout → context_archive → compact (last resort).` |
| 52 | (auto-compact) | `memory/context-lifecycle/index.ts:225` | agent ignored nudges, auto-trigger | low (default) | `## ⚡ Auto-compacting context\nCompaction nudges were ignored. Auto-tagging then compacting to prevent overflow.\nUse context_tag proactively next time to avoid losing the completion summary.` |
| 53 | (lifecycle nudge) | `memory/context-lifecycle/index.ts:323` | `nudge` action type | low | (interpolated from policy rule) |
| 54 | `## 🔄 Session Rotated` | `memory/context-manager/handlers/rotation.ts:279` | finalize triggers rotation | low | `## 🔄 Session Rotated\n\nRotation #${n} completed at task boundary.\nKey context has been preserved in memory stores.\nUse the \`memory\` tool to retrieve relevant context.` |

#### Self / heartbeat / scheduling extensions

| # | Tag | File:line | Trigger | Wake | Message template |
|---|---|---|---|---|---|
| 55 | `## System Degradation Detected` | `self/auto-recovery/index.ts:76` | `isDegraded(ctx)` true, cooldown 10 turns, min 5 turns warm-up | **triggerTurn: true** | `## System Degradation Detected\n\n**Degradation reasons:**\n${reasons}\n\n**Recommended actions:**\n1. Run \`health_maintenance(action="check")\` ...\n2. Consider whether a different approach ...\n3. If the current approach keeps failing, use \`think()\` ...\n4. Use \`finalize()\` with task decomposition ...` |
| 56 | `[TIMER FIRED]` | `scheduling/timer/index.ts:292` (wake:false) | timer fires | low + `bypassFloodCap: true` | `[TIMER FIRED] ${reason}` |
| 57 | `[TIMER FIRED - Ns elapsed]` | `scheduling/timer/index.ts:243` (wake:true) | timer fires | **triggerTurn: true** + `bypassFloodCap: true` | `[TIMER FIRED - ${elapsedSec}s elapsed] ${reason} - Resume the task.` |
| 58 | `[analytics]` (addiction) | `heartbeat/analytics/index.ts:159` | tool-addiction pattern detected | low | `[analytics] Tool addiction pattern detected: ${warnings}. Assess intent - heavy single-tool use may be valid if the task demands it.` |
| 59 | `[health]` (degrade) | `heartbeat/analytics/index.ts:204` | `isDegraded(ctx)` newly true | **triggerTurn: true** | `[health] Degradation detected: ${reasons}` |
| 60 | `[health]` (recover) | `heartbeat/analytics/index.ts:236` | `isDegraded(ctx)` newly false | low | `[health] Performance recovered to healthy.` |
| 61 | (heartbeat auto-finalize) | `heartbeat/heartbeat-scheduler/index.ts:435` | policy engine fires auto-finalize | **triggerTurn: true** | `${message}` (from policy) |

## 4. The 16 NudgeType Definitions

`NudgeManager.DEFAULT_NUDGE_CONFIGS` (`extensions/enforcement/nudge-manager.ts:39-56`).
Cooldowns are **per session** and are the minimum between two consecutive
nudges of the same type:

| NudgeType | Cooldown | Escalate after | Dedup? | Actively used? |
|---|---|---|---|---|
| `validation` | 20 s | 3 | yes | ✅ `turn-analysis.ts:90` |
| `memory` | 45 s | 2 | no | ❌ |
| `recordFailure` | 20 s | 1 | yes | ❌ (the L2 path uses `lastNudgeTime` instead) |
| `toolError` | 15 s | 2 | yes | ❌ |
| `lazy` | 15 s | 2 | no | ❌ (legacy from the pre-LLM-judge era) |
| `claim` | 20 s | 2 | yes | ❌ |
| `toolDiversity` | 60 s | 1 | yes | ❌ (the field `toolDiversityNudged` is set but never read) |
| `exploreBeforeAct` | 30 s | 2 | yes | ❌ |
| `phaseValidation` | 15 s | 3 | yes | ❌ |
| `scratchpad` | 60 s | 2 | yes | ✅ `turn-end-handler.ts:362` (Session Signals bundle) |
| `malformed` | 10 s | 1 | no | ❌ (caller uses raw `sendEnforcementWhisper`) |
| `dangerousCommand` | 5 s | 1 | no | ❌ (no dangerous-command detection exists) |
| `judge` | 30 s | 2 | yes | ❌ |
| `context` | 90 s | 2 | yes | ❌ |
| `contextTool` | 120 s | 3 | yes | ❌ |

**Of 16, only 2 are wired up. The remaining 14 are forward-looking
scaffolding.** See §6.1 for the implications.

## 5. Supporting structures

### 5.1 The L2 "Session Signals" bundle

The most complex single whisper is `[Session Signals]`, assembled in
`turn-end-handler.ts:210-355`. It bundles up to ~5 sub-signals (gated by
`!hadErrors && !inOverflowRecovery`):

| Sub-signal | Condition | Cooldown |
|---|---|---|
| Memory nudge | `shouldNudgeForMemory(...)` (20 turns since memory + hasCodeChanges) | per `memoryNudgeSent` flag |
| Scratchpad nudge | `madeFileChanges` (cooldown 8 turns) OR `isComplexTurn` (cooldown 15 turns), both without scratchpad | dual cooldown |
| Think nudge | `noThinkThisSession && turn >= 5 && turn % 5 == 0` OR `madeHighStakesAction && noThinkThisSession && turn >= 3` | per turn mod |
| Context (token-soft) | `usageTokens >= USAGE_TOKENS_SOFT (30K)`, every 8 turns | dual cooldown (token-soft OR token-warning) |
| Context (token-warning) | `usageTokens >= USAGE_TOKENS_WARNING (75K)` |  |
| Context (pct medium) | `usagePercent >= USAGE_COMPACT_MEDIUM (80%)`, every 34 turns |  |
| Context (pct critical) | `usagePercent >= USAGE_WHISPER_CRITICAL (75%)` |  |
| Localization risk | `getState(ctx)._localizationRisk` non-empty | one-shot |
| A/B suppression | if `abVariant === "no_nudges"`, the entire bundle is suppressed but counters still increment | (BR3 — `recordNudgeSuppressed`) |

If `isBurst` (consecutiveErrorTurns ≥ 3), `sessionSignals.length = 0` — all
L2 wipes.

### 5.2 BPE Policy Recommendation messages

`lib/reasoning/policy-rules.ts` defines 7 rules, each returning 0 or 1
`PolicyRecommendation`. The `bpe-handler.ts` claims `tryClaim("bpe",
"advisory")` and dispatches the highest-priority one with
`customType: "context"`, `source: "enforcement/policy"`:

| Rule | Trigger | Message |
|---|---|---|
| `stability_decline` | ≥3 stability signals | `[stability] Reasoning coherence declining (overlap: X → Y). Consider: step back and verify assumptions.` |
| `conflict_accumulation` | ≥5 unresolved conflicts | `[epistemic] ${n} unresolved source conflicts. Epistemic debt accumulating. Consider: resolve one conflict explicitly.` |
| `drift_plus_scatter` | recent drift + ≥2 tool-overuse | `[focus] Topic drift + tool scatter detected. Consider: explicitly reaffirm the current task goal before continuing.` |
| `calibration_error` | ≥2 calibration-error signals | `[calibration] Prediction error consistently high (avg: ${pct}%). Consider being less confident in plans before executing.` |
| `reflection_gap` | no reflection in last 5 signals + ≥8 tool signals | `[reflection] 8+ consecutive tool calls without reflection. Consider: think(type="reflection") before proceeding.` |
| `reasoning_plus_conflict` | reasoning decline + conflict present | `[careful] Reasoning coherence declining AND source conflicts present. Recommend: slow down, verify facts, acknowledge uncertainty explicitly.` |
| `memory_contamination` | ≥3 cross-session memory signals in last 20 | `[memory] ${n} cross-session memory recall(s) - verify relevant to current project before acting.` |

### 5.3 MARS advice messages

`lib/reasoning/mars-reflector.ts:148-178`:

| `type` | Trigger | Message |
|---|---|---|
| `tool_overuse` | count > avg × 3 AND count > 5 (learning phase), failing | `[mars] ${tool} used ${n}/${total} times (${pct}%, ${successRate}% success). ${suggestion}` |
| `error_recurrence` | consecutiveErrors ≥ 3 | `[mars] ${n} consecutive errors detected. Consider: think(type="reflection") to identify root cause before continuing.` |
| `stability_decline` | trend drop > 30% over 3 samples | `[mars] Response quality declining (avg stability X vs Y earlier). Consider refocusing on the original task.` |

Cooldown: 60 s (initial, dynamically adjusted 30–300 s by `advice-tracker.ts`).

### 5.4 Dreamer messages

`lib/reasoning/dreamer.ts`:

| Path | Trigger | Message |
|---|---|---|
| `tailRun` (current loop) | ≥8 consecutive same-tool calls in current sequence | `[dream] Detected ${n} consecutive ${tool} calls with no progress. This pattern suggests a stuck loop. Consider: verify approach, switch tool, or ask for clarification.` |
| Markov `stuck` (top prediction) | prob > 0.6 | `[dream] Likely to get stuck in ${a→b} loop (prob: ${pct}%, confidence: ${conf}). Consider: verify approach or ask for clarification.` |
| Markov `failure` (top prediction) | prob > 0.6 | `[dream] Historical pattern suggests failure path: ${a→b} (prob: ${pct}%, confidence: ${conf}). Consider: run tests before more edits.` |

Cooldown: 60 s (initial, dynamically adjusted 30–300 s). The
`tryClaim("dreamer", "loop")` claim means dreamer's `loop` advisory is
**suppressed if turn-outcome already fired** in the same turn.

## 6. Audit findings

### 6.1 NudgeType coverage gap _(resolved v3.3)_

**Resolved 2026-06-27.** See §7.2 (shipped v3.3). The NudgeType union
went from 16 members (2 wired, 14 scaffolding) to 7 members (all
wired). The cross-cutting test
`test/runtime/lib/test-nudgetype-wiring.mjs` enforces the "every
NudgeType has a caller" contract going forward. The historical
finding:

> Of 16 `NudgeType` values, only `validation` and `scratchpad` are passed to
> `NudgeManager.shouldSendNudge()`. The other 14 have configs but **no
> callers**. This is intentional scaffolding for future enforcement features,
> but the configs create a *false impression* of a wired-up system. A new
> contributor reading `nudge-manager.ts` would assume e.g. `dangerousCommand`
> or `malformed` is rate-limited by NudgeManager — it is not.

The 14 unwired types (resolved):

- **Forward-looking** (`malformed`, `dangerousCommand`, `exploreBeforeAct`):
  `malformed` wired; `dangerousCommand` and `exploreBeforeAct` deleted
  (no detection logic exists).
- **Legacy** (`lazy`, `claim`): deleted (replaced by LLM judges).
- **Implicit** (`context`, `contextTool`, `toolError`, `toolDiversity`,
  `phaseValidation`, `judge`): `context` wired via L2 sub-signal table;
  rest deleted.

### 6.2 `checkBlocking` is a no-op

`handlers/blocking.ts:42-49` — the only real block (edit-before-explore) is
explicitly **downgraded** to a passthrough with the comment "Downgraded from
block to passthrough: too noisy to force exploration." The function still
records L2 signals (`toolChain.recentEditWithoutThink.push`, `firstWorkDone`,
`recentEditWithoutPlan`, `toolDiversityNudged`) but **none of those L2
signals are ever consumed** by a whisper. The `toolDiversityNudged` flag is
set but never read. The `firstWorkDone` flag is set but never read. This is
dead tracking code.

`ENFORCEMENT_PARAMS.blockExploreBeforeWrite: true` is also dead — the only
consumer (`checkBlocking`) returns `{ blocked: false, reason: "explore-before-edit (downgraded)" }` for that case.

### 6.3 Three near-duplicate "classifier offline" anti-patterns

The same pattern — "if the LLM judge failed, surface a `Classifier
unavailable` whisper instead of silently returning null" — appears in three
places:

- `lib/detection/topic-drift-detector.ts:271-277` → `[drift-detector] Classifier unavailable...`
- `extensions/cognitive/turn-outcome/index.ts:131-142` → `## Loop Detector Offline...`
- `extensions/cognitive/sycophancy-detector/index.ts:75-80` (classifierDown field) and emit-signal branch in same file

The pattern was added in three commits (`9966c8ad` for input-polisher,
`b25006f3` for drift+sycophancy). **No shared helper exists** — three
near-identical implementations with different message formats. A new
classifier that wants the same behavior would have to copy-paste a fourth
time.

### 6.4 `_localizationRisk` field name

`substate/tool-tracking-state.ts:30` defines `_localizationRisk: string`
(note the leading underscore). It's a magic field that crosses a
structural-test boundary. The structural test in
`test/runtime/lib/test-enforcement-state-composition.mjs` should catch the
underscore if it ever collides with another key, but the convention is
non-obvious and the underscore prefix is not used for any other field in
the same file.

### 6.5 `braid.suppressNudges` is checked inconsistently

`areCognitiveNudgesDisabled()` is checked at:

- `whisper.ts:39` (the wrapper — short-circuits at the top)
- `heartbeat/analytics/index.ts:159, 204, 236` (addiction, degrade, recover)

But it is **NOT** checked at:

- `handlers/register-message-end.ts:41, 57, 67, 107, 203` (the
  conflict/verification/QA whispers — #8, #9, #10, #11, #12)
- `handlers/turn-end-handler.ts:189, 340, 362` (orphan-chains #6,
  localization #30, Session Signals bundle #7)
- `detection/malformed.ts:24` (malformed tool #18)
- `detection/verification.ts:40` (verification reminder #17)
- `handlers/turn-analysis.ts:65, 91, 106` (redundancy #3, validation #4,
  recordFailure #5)

A user who sets `braid.suppressNudges=true` might still receive conflict-QA,
verification-judge, orphan-chain, drift, malformed-tool, and validation
whispers. The Session Signals bundle has its own A/B variant check
(`abVariant === "no_nudges"`) but that's a different mechanism.

### 6.6 `enforcement_violation → tool_error` propagation loop

`sendEnforcementWhisper` always emits `{ type: "enforcement_violation", rule:
"enforcement", description: message, severity: critical ? "high" : "medium" }`
to eventBus. `handlers/register-session-start.ts:55-58` subscribes to that
event and re-emits it as `type: "tool_error"`. The `tool_error` event
drives:

- The calibration error path in `register-tool-result.ts:38-44`
- Error burst detection in `turn-end-handler.ts:64-74`
- MARS error-recurrence detection in `mars-reflector.ts:163-167`

So **every whisper causes a synthetic tool_error event**. A perfectly
fine advisory ("consider adding scratchpad") propagates as a tool error,
which can then trigger the MARS error-recurrence advice on the next turn,
which can then trigger the auto-recovery extension. This is a real
amplification bug.

The handler comment claims the intent is "Route enforcement violations to
error tracking via tool_error event" — but the wrapping whisper is not a
violation. The simplest fix: only emit `enforcement_violation` when
`critical: true` (i.e., when it's actually a violation). Advisory nudges
should not be routed as errors.

### 6.7 `nudgeSuppressedCount` is dead

`handlers/turn-end-handler.ts:232` increments
`getState(ctx).nudgeSuppressedCount` when the A/B variant is `no_nudges`.
It is **never read anywhere**. The `recordNudgeSuppressed(ctx)` call
(separate counter) IS read via `getNudgeAnalytics`. Either surface
`nudgeSuppressedCount` in the TUI status bar (matching `ctx.ui.setStatus`)
or delete the field.

### 6.8 `enforcementSignals` pruning collides with MARS lookback

`pruneSignals(currentTurn)` in `signals.ts:49-57` keeps only the current
and previous turn (`SIGNAL_RETENTION_TURNS = 1`). Entries whose `turn` is
more than 1 behind `currentTurn` are deleted. This is the L1 enforcement
signal surface for the prompt-builder (RepE contrast mode).

But MARS (`lib/reasoning/mars-reflector.ts:91-101`) reads
`enforcementSignals` to build the stability trend. The
`stability_decline` MARS advice requires 3 samples (line 175:
`current.stabilityTrend.slice(-3)`). If the agent gets 3 stable responses
in turns T-2, T-1, T, the MARS check on turn T+1 cannot see the trend
because the T-2 and T-1 entries were pruned on turn T.

The comment in `signals.ts:4-15` acknowledges the pruning is correct for
the prompt-builder but the cross-turn readback by MARS is not factored
in. Two options: (a) make `SIGNAL_RETENTION_TURNS = 3` to cover MARS
lookback, (b) give MARS its own long-lived stability log.

### 6.9 The Session Signals bundle is all-or-nothing per turn

`turn-end-handler.ts:362-365` gates the entire L2 bundle on
`getNudgeManager(ctx).shouldSendNudge("scratchpad", bundled)`. The hash is
computed across the *full concatenated bundle text*. If the agent addresses
3 of 4 sub-signals (e.g., calls `memory_store`, `scratchpad`, `think`) and
the 4th sub-signal (e.g., context-token-warning) was the only remaining
unaddressed issue, the next turn's bundle will re-arm because the new
context token count is different and the hash differs. The agent has
already addressed the issue, but the bundle fires anyway.

The fix is either: (a) hash each sub-signal independently and only include
unseen hashes in the bundle; or (b) drop signals that the agent has
clearly addressed (e.g., `memoryUpdated` is already detected — that
suppresses the memory nudge; the same pattern could be applied to the
others).

### 6.10 Per-source cap is binary

`WHISPER_CAPS` and `PER_SOURCE_CAP` are global constants
(`lib/enforcement/turn-dedup.ts:80-91`). All sources get cap=2 per turn
regardless of whether they emit advisory or critical messages. The current
`turn-dedup.ts` design has no per-source override. The cap is *protective*
(makes sense for dreamer) but also *foolish* (a 3rd `enforcement/whisper`
critical message in a turn is also dropped).

The 13 `triggerTurn: true` sources are *exactly* the messages where
dropping the 3rd is the worst outcome. A priority-aware per-source cap
(e.g., `triggerTurn: true` sources get cap=4 instead of 2) would be more
honest about the design intent.

### 6.11 The low-priority cap of 1 is restrictive

`WHISPER_CAPS.low = 1` means the agent can see at most **1 low-priority
whisper per turn across all sources combined**. This is the real limit,
not the per-source cap of 2. The `advisory` and `loop` dedup categories
give a turn a maximum of 2 low-priority whispers (one from each category).
That's intentional but undocumented. A contributor adding a 3rd
low-priority source would be silently suppressed unless they coordinate
via `tryClaim`.

### 6.12 Inconsistent prefix taxonomy

Whisper message prefixes are inconsistent in case, format, and language:

- Lowercase, kebab-style: `[enforcement]`, `[stability]`, `[chains]`, `[Quality]` (one-off capitalized), `[policy]`, `[dream]`, `[mars]`, `[recall]`, `[drift-detector]`, `[calibration]`, `[conflict]`, `[conflict-qa]`, `[self-consistency]`, `[spec]`, `[reasoning]`, `[health]`, `[analytics]`, `[localization]`, `[Session Signals]`, `[compact]`
- UPPERCASE: `[TIMER FIRED]`, `[FAIL]/[WARN] VERIFICATION JUDGE`, `[ESCALATED]`
- Headline-style: `## Repetitive Loop Detected`, `## Loop Detector Offline`, `## System Degradation Detected`, `## ⚡ Auto-compacting context`, `## Session Size Notice`, `## Session Branch Depth Notice`, `## Session Rotation Required`, `## 🔄 Session Rotated`
- Bare sentence: `VbC correction: ...`, `**Context checkout prepared.**`, `Context at 80%. Pipeline: ...`, `Context compacted at turn 5. ...`

A naming convention (e.g., lowercase kebab `[<subsystem>-<event>]`) would
help downstream filtering, the TUI's display logic, and user-level rules
(e.g., a user wanting to suppress all `[drift]` whispers).

**Status: RESOLVED 2026-06-21** by EW-7.16 (universal whisper envelope).
Every system-injected message now starts with `[braid-whisper · <subsystem>]`,
applied centrally at the trunk (`sendTrackedMessage`). Body-level sub-tags
(e.g. `[dream]`, `[recall]`, `[TIMER FIRED]`, `## Session Size Notice`) are
preserved as a second filter level. See `lib/utils/whisper-format.ts` for
the design and migration story.

### 6.13 Burst-suppression wipes L2 but not L1

`turn-end-handler.ts:347-349` sets `sessionSignals.length = 0` when
`isBurst`. This wipes the Session Signals bundle but **does not** wipe
the L1 `enforcementSignals` map or the `claim-tracker` cross-turn
contradiction work. So an agent in error-burst mode still gets:

- `[conflict]` and `[conflict-qa]` from `register-message-end.ts:41, 67`
- `[self-consistency]` from `handler-registry.ts:141`
- `[FAIL] VERIFICATION JUDGE` from `register-message-end.ts:203`
- `[calibration]` from `register-tool-result.ts:73`

The original intent of burst suppression is to reduce noise during a
crash. The current implementation only blocks the L2 bundle. Either
expand the suppression (and document it) or make it explicit that
"burst" only freezes the Session Signals bundle.

### 6.14 The L1 signals map is a `Record<string, ...>`

`enforcementSignals` is typed as `Record<string, EnforcementSignalEntry>`.
The signals.ts comment explicitly acknowledges this is fragile: typos
(e.g., `enforcementSignals["stablity"]`) compile and silently fail.
The keys used in practice are `stability`, `probe`, `routing`, and
`unpersisted_learnings`. A typed key union would catch typos at compile
time.

## 7. Proposed Improvements

Each item below is **scored** for impact (high / medium / low) and effort
(easy / medium / hard). Items are ordered by impact, then by effort.

### 7.1 Fix `enforcement_violation → tool_error` amplification — **HIGH / EASY**

**Problem:** Every `sendEnforcementWhisper` call (even with `critical: false`) emits `enforcement_violation` to eventBus, which is then re-emitted as `tool_error`, which can drive the calibration error path, error burst detection, and MARS error-recurrence on the next turn.

**Fix:** In `whisper.ts:51-58`, only emit `enforcement_violation` when `critical: true`. Advisory nudges should not propagate as errors. The handler at `register-session-start.ts:55-58` can keep its current behavior — it already routes via `tool_error` and is harmless when only triggered by real violations.

**Estimated impact:** Eliminates a real amplification bug. Prevents MARS and auto-recovery from being triggered by advisory nudges.

### 7.2 Wire up the 14 unwired NudgeType values — **HIGH / EASY** _(shipped v3.3)_

**Problem:** 14 of 16 NudgeType configs are forward-looking scaffolding with no callers. The configs create a false impression of a wired system. Several have triggering logic that already exists in the L2 bundle and could be wired up with a 1-line change.

**Fix:** For each NudgeType, either wire it up to a real trigger or delete it. Specifically:

- **`malformed`**: wrap `detection/malformed.ts:24` in `getNudgeManager(ctx).shouldSendNudge("malformed", msg)`. The 10s cooldown + no-dedup config is exactly the right shape for a malformed-tool flood.
- **`dangerousCommand`**: keep as scaffolding (no detection exists). Mark with `// NOT YET WIRED — see `dangerous-command-detection.md``.
- **`lazy`**: delete. The LLM-judge replacement makes this obsolete.
- **`claim`**: delete. The verification judge (LLM) replaces the regex-based claim detection.
- **`toolDiversity`**: wire it up by reading the existing `state.toolDiversityNudged` flag (currently set but unread). Or delete the flag and the NudgeType.
- **`exploreBeforeAct`, `phaseValidation`, `judge`, `context`, `contextTool`, `toolError`, `memory`**: each has triggering logic in the L2 bundle. Either wire them up via the bundle's per-signal sub-checks (improvement 7.9) or delete the configs.
- **`recordFailure`**: wrap `turn-analysis.ts:106-118` in `getNudgeManager(ctx).shouldSendNudge("recordFailure", msg)`.

**Estimated impact:** Removes 14 false promises from the API. Either activates dormant code or clarifies what's planned.

**Status:** Shipped in v3.3 (P1-5 / EW-7.2). The NudgeType union
went from 16 members (2 wired, 14 scaffolding) to 7 members (all
wired). Concrete changes:

- Wired direct: `malformed` (10s cooldown, `detection/malformed.ts`
  now rate-limits via NudgeManager) and `recordFailure` (20s,
  `turn-analysis.ts:106-118` no longer uses the parallel
  `state.lastNudgeTime + nudgeCooldownMs` for this path).
- Wired via L2 sub-signal lookup table: `memory` (45s), `scratchpad`
  (60s), `context` (90s, with subKey distinguishing `context-tokens`
  vs `context-percent`). `turn-end-handler.ts` has a new
  `L2_NUDGE_TYPE` map and `nudgeTypeForKey(key)` helper.
- Deleted (no triggering logic, kept as false promises before):
  `toolDiversity`, `lazy`, `claim`, `exploreBeforeAct`,
  `phaseValidation`, `toolError`, `judge`, `contextTool`,
  `dangerousCommand`. `dangerousCommand` was deleted (not kept as
  scaffolding) — no detection exists, so the config would have
  re-introduced the false promise this audit called out. Re-create
  when detection ships.
- Cross-cutting test: `test/runtime/lib/test-nudgetype-wiring.mjs`
  (9 subtests) asserts every NudgeType has at least one caller.
  Would have caught the original 14 unwired types.
- State cleanup: `lastLazyNudgeTime` (dead field) removed from
  `ErrorTrackingState`. `lastJudgeTime` moved from
  `ErrorTrackingState` to `SessionState` (logical home with the
  other verification-judge fields). Structural test baseline
  `BASELINE_COUNT` updated 66 → 65.
- Test count: 77 → 78 passing.

### 7.3 Apply `braid.suppressNudges` consistently — **HIGH / EASY**

**Problem:** The off-switch is checked in 4 sites but missed in 11+ others, so a user setting `braid.suppressNudges=true` still gets ~70% of the agent-facing whispers.

**Fix:** Add `areCognitiveNudgesDisabled()` checks at:

- `handlers/register-message-end.ts:41, 57, 67, 107, 203`
- `handlers/turn-end-handler.ts:189, 340, 362` (or: refactor the L2 bundle to check once at the top)
- `detection/malformed.ts:24`
- `detection/verification.ts:40`
- `handlers/turn-analysis.ts:65, 91, 106`

A cleaner approach: route every call through a single wrapper that checks `areCognitiveNudgesDisabled()` once and either returns or calls `sendEnforcementWhisper`. But the calls are spread across 8 files in 2 categories (`sendEnforcementWhisper` direct + `sendTrackedMessage` for context-manager), so the cost of unification may be higher than just adding the check.

**Estimated impact:** Makes the off-switch actually work. Documents intent in every site.

### 7.4 Extract the "classifier offline" helper — **MEDIUM / EASY**

**Problem:** Three near-identical implementations in `topic-drift-detector.ts:271-277`, `turn-outcome/index.ts:131-142`, and `sycophancy-detector/index.ts:75-80` + emit-signal branch. New classifiers will copy-paste a fourth.

**Fix:** Add `lib/reasoning/classifier-offline.ts`:

```ts
export interface ClassifierResult<T> {
  value: T;
  classifierDown: boolean;
  tier: "heuristic" | "utility" | "session" | "failed";
}

export async function classifyWithOffline<T>(
  ctx: ExtensionContext,
  critics: { criteria: string; label: string },
  input: unknown,
  options: { timeoutMs?: number; fallback: () => T },
): Promise<ClassifierResult<T>> {
  try {
    const result = await classify(ctx, critics.criteria, input, { ...options, label: critics.label });
    return {
      value: result.label as T,
      classifierDown: result.tier === "failed",
      tier: result.tier,
    };
  } catch {
    return { value: options.fallback(), classifierDown: true, tier: "failed" };
  }
}

export const CLASSIFIER_OFFLINE_WHISPERS = {
  drift: "[drift-detector] Classifier unavailable - could not check topic drift this turn.",
  loop: "## Loop Detector Offline\n\nThe loop-detection classifier is unavailable this turn, ...",
  sycophancy: "[sycophancy] Classifier unavailable - could not check sycophancy risk this turn.",
};
```

Each call site becomes a single import. Future classifiers inherit the pattern.

**Estimated impact:** Removes ~50 lines of duplication. Establishes a contract for new classifier integrations.

### 7.5 Clean up `checkBlocking` dead tracking — **MEDIUM / EASY**

**Problem:** 3 of 4 L2 signals tracked in `blocking.ts` are never consumed: `toolDiversityNudged`, `firstWorkDone`, `toolChain.recentEditWithoutThink` (the L3 path through `sessionSignals` doesn't use any of them).

**Fix:** Delete the dead fields and their mutations. The `toolChain.recentEditWithoutThink` array is still used by `signals.ts:88-94` for RepE contrast mode (CORRECTION), so keep that one. Delete:

- `firstWorkDone` (set, never read)
- `toolDiversityNudged` (set, never read)
- `blockExploreBeforeWrite` from `ENFORCEMENT_PARAMS` (the only consumer is the downgraded block)

Update `state.ts` and the structural test as needed.

**Estimated impact:** Removes ~30 lines of dead code. Aligns the implementation with the project rule "Only remove truly dead code."

### 7.6 Fix `enforcementSignals` pruning vs. MARS lookback — **MEDIUM / EASY**

**Problem:** `SIGNAL_RETENTION_TURNS = 1` keeps only current+previous turn. MARS reads signals for the stability_decline trend (3 samples), so the trend is incomplete by the time the advice is supposed to fire.

**Fix:** Make the retention horizon depend on the slowest consumer. Either:

- (a) Set `SIGNAL_RETENTION_TURNS = 3` (covers MARS). Slight memory growth — at most 3 turns of signals per key.
- (b) Give MARS its own long-lived stability log (`state.stabilityTrend: number[]` on `ThoughtChainState` or a new sub-state). Update once per turn. MARS reads from there.

Option (a) is simpler; option (b) is cleaner but adds a new sub-state.

**Estimated impact:** Makes MARS stability_decline advice actually fire. Currently it's effectively dead because the data is pruned before the trend has 3 samples.

### 7.7 Type the `enforcementSignals` keys — **MEDIUM / EASY**

**Problem:** `Record<string, EnforcementSignalEntry>` allows typos. The comment in `signals.ts:4-15` acknowledges this is a known weakness.

**Fix:** Define a union type for valid keys:

```ts
export type EnforcementSignalKey =
  | "stability"
  | "probe"
  | "routing"
  | "unpersisted_learnings";

export const enforcementSignals: Partial<Record<EnforcementSignalKey, EnforcementSignalEntry>> = {};
```

Downcast at the call site if a new key is needed:

```ts
(enforcementSignals as Record<string, EnforcementSignalEntry>)[newKey] = signal;
```

This catches typos at the common call sites while keeping escape-hatch flexibility.

**Estimated impact:** Catches silent typos. The structural test already enforces the import contract — adding this would extend it to the data contract.

### 7.8 Promote `nudgeCooldownMs` to constants or remove it — **LOW / EASY**

**Problem:** `nudgeCooldownMs: 60_000` lives in `error-tracking-state.ts` and is read by `turn-end-handler.ts:255, 271, 298` for general rate-limiting. But the L2 bundle has its own per-NudgeType cooldowns in `NudgeManager`. Two parallel rate limits.

**Fix:** Either (a) move the value to `ENFORCEMENT_PARAMS` for centralization, or (b) delete it and rely on `NudgeManager` for all rate-limiting. Option (b) is cleaner.

**Estimated impact:** Removes one of two parallel rate-limit mechanisms. Probably a 10-line change.

### 7.9 Make the Session Signals bundle per-signal — **MEDIUM / MEDIUM**

**Problem:** The L2 bundle is gated by `getNudgeManager("scratchpad", bundled)` which hashes the entire bundle. Adding a single L2 line re-arms a previously-suppressed bundle.

**Fix:** Hash each sub-signal independently. The L2 signal push becomes:

```ts
sessionSignals.push({ key: "memory", content: "..." });
sessionSignals.push({ key: "scratchpad", content: "..." });
// etc.
```

And the gating becomes per-key:

```ts
const unsent: string[] = [];
for (const sig of sessionSignals) {
  if (getNudgeManager(ctx).shouldSendNudge(sig.key, sig.content).shouldSend) {
    unsent.push(sig.content);
  }
}
if (unsent.length > 0) {
  sendEnforcementWhisper(pi, ctx, `[Session Signals]\n${unsent.map(s => `- ${s}`).join("\n")}`);
}
```

This requires adding 4-5 new NudgeType configs (improvement 7.2 wires them up) and a small refactor of `turn-end-handler.ts`.

**Estimated impact:** Eliminates the "all-or-nothing" re-arm. Each sub-signal respects its own cooldown. Combined with 7.6, the L2 bundle becomes well-behaved.

### 7.10 Make `_localizationRisk` a regular field — **LOW / EASY**

**Problem:** `_localizationRisk: string` (leading underscore) is a magic convention. The structural test should catch collisions but the convention is non-obvious.

**Fix:** Rename to `localizationRisk` (no underscore). Add a brief comment in the state file explaining what triggers it and who reads it. Update the consumer (`turn-end-handler.ts:340`) and the setter (`register-tool-call.ts:49`).

**Estimated impact:** Self-documenting. One rename across ~3 sites.

### 7.11 Add a `braid.enforcement` settings block — **HIGH / MEDIUM**

**Problem:** All per-type cooldowns are hardcoded. Power users have no way to tune enforcement behavior short of forking.

**Fix:** Add a `braid.enforcement` block to `~/.pi/agent/settings.json`:

```json
{
  "braid": {
    "enforcement": {
      "cooldowns": {
        "validation": 30000,
        "scratchpad": 90000,
        "context": 60000
      },
      "floodCaps": {
        "low": 1,
        "high": 3
      },
      "burstThreshold": 3,
      "verificationJudgeInterval": 15
    }
  }
}
```

Implementation: `braid-settings.ts` reads the block, `NudgeManager` and `ENFORCEMENT_PARAMS` consult it. Add a `validateNudgeConfig` helper that warns about invalid values.

**Estimated impact:** Let users tune enforcement to their workload. Power users (long-running sessions, custom tool mixes) are currently locked into the defaults.

### 7.12 Establish a prefix naming convention — **LOW / MEDIUM**

**Problem:** ~30+ inconsistent prefix formats. Downstream filtering is fragile.

**Fix:** Establish a convention in the enforcement AGENTS.md:

- Lowercase kebab for subsystem tags: `[enforcement]`, `[drift]`, `[drift-detector]`
- `[<subsystem>-<event>]` for events: `[enforcement-malformed]`, `[context-overflow]`
- Title-case for headlines: `## Loop Detector Offline`, `## System Degradation Detected`
- UPPERCASE for emergency: `[TIMER FIRED]`, `[FAIL] VERIFICATION JUDGE`

Migrate one prefix at a time as files are touched. Document the convention so new contributors follow it.

**Estimated impact:** Self-documenting. Improves the user experience in `/logs` and TUI notifications. Backward-compatible if done by adding new prefix text alongside the old.

**Status: SUPERSEDED by EW-7.16.** The proposed gradual migration was
too weak to address the agent's confusion with human input. EW-7.16
implements a universal envelope at the trunk instead, which immediately
fixes 100% of system-injected messages without per-site changes.

### 7.13 Add per-source priority-aware caps — **MEDIUM / MEDIUM**

**Problem:** All sources share the same `PER_SOURCE_CAP = 2`. A 3rd `enforcement/whisper` critical message in a turn is silently dropped.

**Fix:** Extend `turn-dedup.ts` to support per-source overrides:

```ts
export const PER_SOURCE_CAP_OVERRIDES: Record<string, number> = {
  "enforcement/whisper": 3,   // allow up to 3 enforcement whispers per turn
  "timer/fire": 3,            // multiple timers firing is normal
};

export function getPerSourceCap(source: string): number {
  return PER_SOURCE_CAP_OVERRIDES[source] ?? PER_SOURCE_CAP;
}
```

Update `tryWhisper` to use the override.

**Estimated impact:** Honors the design intent (triggerTurn sources can fire more). Avoids silent drops of critical whispers.

### 7.14 Surface `nudgeSuppressedCount` in the TUI — **LOW / EASY**

**Problem:** `nudgeSuppressedCount` is incremented but never read.

**Fix:** Either surface it via `ctx.ui.setStatus` (similar to the existing
"compaction in progress" pattern in `compaction-retry.ts:166-170`) or delete the field. The TUI surfacing would be more user-friendly:

```ts
if (nudgeSuppressedCount > 0 && nudgeSuppressedCount % 5 === 0) {
  ctx.ui.setStatus("enforcement", `X nudges suppressed (A/B variant no_nudges)`);
}
```

**Estimated impact:** Users running the `no_nudges` A/B variant can see how many nudges are being held back. Otherwise, just delete it.

### 7.15 Document the burst-suppression scope — **LOW / EASY**

**Problem:** `isBurst` wipes the L2 `sessionSignals` but not L1 `enforcementSignals`, the cross-turn claim tracker, the verification judge, or the conflict detection. The intent of "burst" (reduce noise during a crash) is only partially achieved.

**Fix:** Either:

- (a) Expand `isBurst` to also skip `register-message-end.ts` conflict detection and claim-tracker work. Document the expanded behavior.
- (b) Rename "burst" to "l2-burst" and document that it only freezes the Session Signals bundle.

**Estimated impact:** Removes ambiguity in the burst-handling logic. Option (a) is a behavior change; option (b) is documentation only.

### 7.16 Universal whisper envelope — **HIGH / EASY** _(shipped 2026-06-21)_

**Problem:** §6.12 found that ~30% of system-injected messages had no
prefix at all (`Context at 80%`, `## Session Size Notice`, `VbC
correction:`) and the rest had inconsistent prefixes (`[enforcement]`,
`[Quality]`, `[chains]`, `[TIMER FIRED]`). The agent could confuse
these with human user input, especially because many use imperative
voice (`Consider X`, `Run Y`). §7.12's "gradual migration" was too weak
to address this — there was no single source of truth and no guarantee
that future call sites would follow the convention.

**Fix:** Add a universal envelope, applied at the trunk
(`sendTrackedMessage`), so every system-injected message gets a
consistent, unambiguous prefix automatically.

- New file `src/lib/utils/whisper-format.ts` with
  `formatWhisperEnvelope(source)` returning `[braid-whisper · <subsystem>]`
  and `applyWhisperEnvelope(content, source)` which mutates the content
  array in place to prepend the envelope to the first text element.
- The subsystem is derived from the source path's first segment
  (e.g. `enforcement/whisper` → `enforcement`,
        `memory/context-manager` → `memory`,
        `cognitive/sycophancy-detector` → `cognitive`).
- `sendTrackedMessage` calls `applyWhisperEnvelope(params.content,
  injectionMeta.source)` after the suppressNudges check and before the
  flood cap. So the tracked (and possibly suppressed) content reflects
  what would have been delivered.
- The redundant inline `[enforcement] ` prefix is removed from the
  wrapper (`whisper.ts`) and 4 analysis/critical handlers (dreamer,
  mars, drift, register-session-start's `context_full` event).
- Body-level sub-tags (`[dream]`, `[recall]`, `[policy]`,
  `[TIMER FIRED]`, `## Session Size Notice`) are preserved as a second
  filter level.
- New test file `test/runtime/lib/test-whisper-envelope.mjs` (18
  assertions) pins the contract at both runtime and source levels.

**Example:**

```
Before: [enforcement] [dream] Likely to get stuck in edit loop (prob: 100%, confidence: high). Consider: verify approach or ask for clarification.
After:  [braid-whisper · enforcement] [dream] Likely to get stuck in edit loop (prob: 100%, confidence: high). Consider: verify approach or ask for clarification.
```

The universal prefix is added by the trunk; the body-level `[dream]`
sub-tag is preserved.

**Migration story for user filters:**

- Filters on the bare subsystem name (e.g. `grep enforcement`,
  `grep memory`) keep working — `enforcement` is a substring of
  `[braid-whisper · enforcement]`.
- Filters on the old bracket-wrapped prefix (e.g. `grep '\[enforcement\]'`)
  need to be updated to the new canonical form
  (`grep '\[braid-whisper · enforcement\]'`) or the bare substring
  (`grep enforcement`).
- The audit's proposed kebab-case subsystem tags (`[drift]`, `[recall]`,
  etc.) can still be added inside the message body as a second filter
  level — the envelope is one level above them.

**Estimated impact:** Eliminates the "no prefix at all" case for 100%
of system-injected messages. Eliminates the "inconsistent prefix" case
for the universal layer. Body-level sub-tags (the audit's proposed
convention) remain as a second filter. The agent can now distinguish
system-injected messages from human user input purely by the universal
prefix — no inference needed.

**Files changed:**

- `src/lib/utils/whisper-format.ts` (new, 110 LOC)
- `src/lib/utils/injection-tracker.ts` (import + 1 call site, ~10 LOC
  delta)
- `src/extensions/enforcement/whisper.ts` (removed inline `[enforcement] `
  prefix)
- `src/extensions/enforcement/handlers/analysis/dreamer-handler.ts`
  (removed inline `[enforcement] ` prefix)
- `src/extensions/enforcement/handlers/analysis/mars-handler.ts`
  (removed inline `[enforcement] ` prefix)
- `src/extensions/enforcement/handlers/analysis/drift-handler.ts`
  (removed inline `[enforcement] ` prefix)
- `src/extensions/enforcement/handlers/register-session-start.ts`
  (removed inline `[enforcement] ` prefix from the `context_full` event)
- `test/runtime/lib/test-whisper-envelope.mjs` (new, 18 assertions)
- `docs/ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` (this entry + §6.12
  status + §7.12 superseded note)

## 8. Summary

The enforcement layer is the largest in pi-braid (32 files, ~6K LOC) and
the canonical path for agent-visible nudges. It is internally consistent
and well-tested, with a clean two-API / one-trunk delivery model and a
3-layer dedup system. The improvements above address real gaps in:

- **Bugs:** §7.1 (enforcement_violation amplification), §7.3 (suppressNudges gap), §7.6 (signals pruning vs. MARS).
- **Dead code:** §7.2 (14 unwired NudgeTypes), §7.5 (checkBlocking tracking), §7.8 (nudgeCooldownMs), §7.10 (underscore field), §7.14 (nudgeSuppressedCount).
- **Duplication:** §7.4 (classifier offline helper).
- **Robustness:** §7.7 (typed signal keys), §7.9 (per-signal bundle), §7.13 (per-source caps).
- **User control:** §7.11 (settings block), §7.12 (prefix convention), §7.15 (burst scope).

The cross-extension whisper sources (memory, heartbeat, timer, self,
cognitive) ride the same trunk and the same flood cap. Of the ~35
distinct message templates, 13 are hard-wake (`triggerTurn: true`) and
the rest are advisory.

---

**Cooldown parameters quick reference** (for tuning, see `lib/detection/context-thresholds.ts`):

| Threshold | Value | Used by |
|---|---|---|
| `USAGE_WHISPER_SOFT` | 40% | context-manager |
| `USAGE_WHISPER_ADVISORY` | 50% | context-manager |
| `USAGE_WHISPER_WARNING` | 60% | context-manager |
| `USAGE_WHISPER_CRITICAL` | 75% | enforcement (L2 pct-critical) |
| `USAGE_COMPACT_MEDIUM` | 80% | enforcement (L2 pct-medium) |
| `USAGE_COMPACT_AGGRESSIVE` | 90% | context-manager |
| `USAGE_FIRED_RESET_BELOW` | 50% | enforcement (reset fired-set) |
| `USAGE_TOKENS_SOFT` | 30K | enforcement (L2 token-soft) |
| `USAGE_TOKENS_WARNING` | 75K | enforcement (L2 token-warning) |
| `USAGE_TOKENS_CRITICAL` | 100K | context-manager |
| `RECOVERY_GRACE_TURNS` | 5 | enforcement (overflow recovery) |
| `ERROR_BURST_THRESHOLD` | 3 | enforcement (error burst) |
| `VERIFICATION_REMINDER_THRESHOLD` | 12 turns | enforcement/detection/verification |
| `WINDOW_SIZE` | 12 turns | turn-outcome |
| `LOOP_COOLDOWN_TURNS` | 8 turns | turn-outcome |
| `LEARNING_PHASE_CALLS` | 5 calls | MARS |
| `OVERUSE_MULTIPLIER` | 3 (dynamic 2-10) | MARS |
| `MARS advice cooldown` | 60s (dynamic 30-300) | MARS |
| `dreamer cooldown` | 60s (dynamic 30-300) | dreamer |
| `calibration window` | 10 pairs | register-tool-result |
| `calibration cooldown` | 120s | register-tool-result |
| `judge min turn gap` | 1 turn | verification judge |
| `judge min time gap` | 60s | verification judge |
| `judge cooldown` | 20s | verification judge |
| `judge interval` | 15 turns | verification judge |
| `recall cooldown` | 120s | three-memory-stores |
| `rotation nudge cooldown` | 50 turns / 5 min | context-manager |
| `recovery cooldown` | 10 turns, min 5 warm-up | auto-recovery |
| `NudgeManager validation` | 20s | enforcement |
| `NudgeManager scratchpad` | 60s | enforcement (Session Signals) |
