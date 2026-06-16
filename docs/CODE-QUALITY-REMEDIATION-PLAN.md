# Code Quality Remediation — Final Status

**Last updated:** 2026-06-16 (continued after first wrap)
**Status:** Four rounds of fixes shipped after initial wrap.

## Headline numbers

| Metric | Start | After first wrap | After classifier-down fixes | After stopReason+maxTokens16 | After 4 more typed-wrapper migrations |
|---|---|---|---|---|---|
| Source files | 199 | 199 | 199 | 199 | 199 |
| Test files | ~35 | 42 | 45 | 51 | 52 |
| Tests pass | 32/32 | 40/40 | 46/46 | 51/51 | 52/52 |
| Unused identifiers (tsc --noUnusedLocals) | 89 | 0 | 0 | 0 | 0 |
| Module-level `let` violations | 20+ | 2 (documented) | 2 (documented) | 2 (documented) | 2 (documented) |
| A-class fragile fallbacks | 11 | 0 | 0 | 0 | 0 |
| B-class fragile fallbacks | 12 | 0 | 0 | 0 | 0 |
| `Promise.all` with LLM fanout | 8 | 0 | 0 | 0 | 0 |
| Hallucinated tool names | 7 | 0 | 0 | 0 | 0 |
| Dynamic `await import()` | 16 | 0 | 0 | 0 | 0 |
| `Date.now() + Math.random()` IDs | 23 | 0 | 0 | 0 | 0 |
| `as any` / `as unknown as` casts | 48 | 43 | 43 | 37 | 28 (after 8 new type-narrowing helpers in `extension-state.ts`) |
| `safeSessionManager(ctx) as { ... }` casts | 5+ | 5+ | 5+ | 1 (just the docs comment) | 0 (all migrated to `safeSessionManagerTyped`) |
| Tool count | 30 | 30 | 30 | 30 | 30 |
| Commits this session (total) | — | 28 | 38 | 41 | 43 |

## What was done after first wrap (commits `5eef50cf` → `??`)

### User-flagged issue: input polisher classifier failures
- **Investigation** (`979f635d`): Found that the "Branch X entries deep" log.warn was actionable advice for the agent going to console, not the agent. Replaced with a throttled `sendTrackedMessage` whisper.
- **Concurrent BUG-M2 + BUG-M3** (`5cba90a7`): `since`/`until` filter applied only to semantic memories, not episodes. Double-encoded unicode in episodes.jsonl. Fixed with `.filter()` chain + `sanitizeEpisode()` at load time.
- **Classifier "always failing" investigation** (`9966c8ad`): When all classify() tiers fail, the input-polisher was proceeding with expensive LLM polish. Added `tier: "failed"` to `CritiqueResult` union; polisher now checks `critique.tier === "failed"` and skips the polish call.
- **Per-model concurrency limiter** (`0eb8c8e2`): `MAX_CONCURRENT_PER_MODEL = 2` semaphore. The 4-way burst in `input-critic.ts` was triggering rate limits on the user's "minimax-m3 a0-venice" model. Slot acquired once per `callLlm`, released in `finally`. Coexists with the rate-limit cooldown (different safety nets).

### Logging architecture overhaul (user direction)
- **TUI-safe default** (`2bdb000f`): `_consoleMinLevel` defaults to `"none"` so `console.*` writes never corrupt the TUI. In-memory buffer always populated. New `/logs` slash command for retrieval with subcommands (show N / clear / level).
- **Routing via ctx.ui.notify** (`435a76a3`): When session ctx is bound (via `setLoggerContext` on `session_start`), all `log.*` calls route to `ctx.ui.notify` instead of console. Zero call site changes. The 206 existing `log.*` callsites benefit transparently.
- **Delivery channel rules pinned in `src/AGENTS.md`** (`85795fa1`, `b3ce9c54`): The 6-channel matrix (notify/setStatus/setWidget/log/console/sendTrackedMessage) is now part of the documented contract.

### "Classifier fails silently" pattern (this round)
Following the input-polisher precedent (`9966c8ad`): detectors that call `classify()` must not silently default to "no problem" when the classifier is down. Surface the offline state.

- **topic-drift-detector** (`fix(detectors): ...`): `DriftCheck.classifierDown?: boolean`. `check()` sets it true when all 3 results are null OR `tier === "failed"`. `drift-handler` dispatches on it: emits `classifier_down` signal with warn severity and distinct source label.
- **sycophancy-detector** (same commit): `SycophancyRisk.classifierDown?: boolean`. `computeRisk` flags it on the safe-default return (score still 0; we don't false-positive). `handleSycophancy` emits a separate `user_risk_classifier_down` signal.

### "Classifier empty string" investigation (root-cause fix)
User report (2026-06-15 16:42): mistral-small-2603 and minimax-m3 both return `""` to classifier calls. The TIER 2/3 WARN said only `unparseable label: ""` with no hint about why. Two commits:

- **`8a89f4d7` - inline actual error reason in TIER 2/3 warns**: `tryModelCall` returns `{ ok: true, raw, label } | { ok: false, reason } | null`. The TIER 2/3 WARN now inlines the actual reason. The `Run /logs level info for the actual error` pointer was removed. 12-assertion test pins the contract.
- **`3c91ef19` - input-polisher prompt pattern**: 4 input-polisher critics (inputCodeHeavy, inputWellWritten, inputClarity, inputAmbiguity) refactored to use PERSONA-in-system / instructions+`<text>`-wrap-in-user pattern (same as the working input-polisher). The other 6 critic prompts not yet migrated (consistency is the next task).
- **`b1365ce7` - surface stopReason + usage in unparseable-label warn**: `callLlm` return type now includes `stopReason?: string` and `usage?: { input?, output?, totalTokens? }`. The classifier unparseable-label reason now includes `(stopReason=length, used N tokens)` inline. This was the ROOT CAUSE: the model hits the max_tokens ceiling and returns empty AssistantMessage with no text. Users now see the cause directly. Also bumped `classify()` default `maxTokens` from 10 to 16.
- **`31217cb6` - bump maxTokens 5/10 -> 16 at all critic callers**: input-critic.ts (4 sites), topic-drift/index.ts (3), cognitive/hints.ts, cognitive/turn-outcome/index.ts. Even before the stopReason diagnostic helps, the larger budget prevents the empty-on-length case for typical yes/no answers.
- **`beea7273` - correct pi-ai Usage field names**: pi-ai's Usage interface uses `{ input, output, totalTokens }` (not `{ inputTokens, outputTokens }`). I had the wrong names in b1365ce7, so the `used N/M` part of the diagnostic was never shown. Fixed in this commit.
- **`c7d233b1` - disable reasoning for classifier calls**: User hypothesis was correct - both `mistral-small-2603` and `minimax-m3` have `reasoning: true` in their pi-ai model spec. Default thinking burns the entire max_tokens budget on internal thinking and produces 0 output tokens. Fix: `classify()` passes `reasoning: "minimal"` on every call. pi-ai's `clampThinkingLevel` maps "minimal" to the lowest available level (effectively "off" for models that support it). Also bumped `classify()` default `maxTokens` from 16 to 64.
- **`c80966ef` - REMOVE maxTokens default entirely**: User direction: 'why ever we need it?' The cat-and-mouse game of bumping the cap (10 -> 16 -> 64) was a workaround. Yes/no answers are 1-2 tokens; the model stops early. Setting a cap caused the bug; setting it high is a no-op. classify() no longer has a default `maxTokens` - the provider decides. Callers can still pass an explicit cap if needed.

### Cast cleanup
- **`68dc3ab3` - `safeSessionManagerTyped`**: 5 `safeSessionManager(ctx) as unknown as SmWithSessionFile` casts in `self/watchdog/index.ts` removed. New `safeSessionManagerTyped(ctx)` returns the typed wrapper directly. `SessionManager.getSessionFile(): string | null` added to the canonical interface. Local `SmWithSessionFile` interface declarations no longer needed. 10-assertion test pins the contract.

### Tests added in this continuation
- `test-episode-sanitizer.mjs` — 8 assertions (BUG-M3 + BUG-M2)
- `test-input-critic-failed-tier.mjs` — input-polisher classifier-down
- `test-logs-command.mjs` — 14 assertions (TUI-safe logging + `/logs`)
- `test-llm-call-concurrency.mjs` — 12 assertions (per-model semaphore)
- `test-drift-classifier-down.mjs` — 13 assertions (topic-drift)
- `test-sycophancy-classifier-down.mjs` — 6 assertions
- `test-turn-outcome-classifier-down.mjs` — 9 assertions (turn-outcome loop-detector offline)
- `test-cognitive-topic-drift-classifier-down.mjs` — 13 assertions
- `test-claim-verification-classifier-down.mjs` — 9 assertions
- `test-text-classifier-warn-detail.mjs` — 13 assertions (TIER 2/3 warn inline reason)
- `test-safe-session-manager-typed.mjs` — 10 assertions (watchdog cast cleanup)

## Decisions log (additions)

- **D-8 (2026-06-15)**: When fixing fragile-fallback bugs, fix the ROOT CAUSE (proper unified API like `bypassFloodCap`) rather than forking the path. Tests should assert architectural invariants, not brittle source patterns.
- **D-9 (2026-06-15)**: When sync fallback for LLM extraction is unused (no callers, `@deprecated`), REMOVE the fragile heuristic. Better to have empty result than wrong result.
- **D-10 (2026-06-15)**: Detectors that call `classify()` must propagate `classifierDown` rather than silently defaulting to "no problem." Pattern documented in the two new tests; future classifier consumers should follow it.

## What was done

### Q1 — Logger silent-drop bug (FIXED, commit `67d59fea`)
`logger.ts:97-106` was silently dropping `warn`/`info`/`debug` (empty default switch case). Now explicit case for each level routes to `console.warn`/`info`/`debug`/`error`. New `setConsoleLogLevel(level)` export.

### Q2 — arXiv citations (AUDITED, test added, commit `d58fab20`)
All 7 cited arXiv papers are real. Initial HEAD-request check returned false 404s (arxiv.org CDN quirk); re-verification with GET confirmed all resolve. New `test-arxiv-citations.mjs` prevents future re-introduction of broken citations.

### Q3 + Q11 — Per-session state migration (FIXED, commit `47010c41`)
Migrated `NudgeManager` and `_lastRecommendationType` to per-session. `getNudgeManager(ctx)` factory uses `getExtensionState`. Removed `nudgeManager` parameter from `registerHandlers`/`registerCompactAndSessionHandlers`/`dispatchTurnEndLoop`. Added `lastRecommendationType: string | null` to `ToolTrackingState`.

### Q4 — `tool-safety` extension (REMOVED, commit `b3152c75`)
Out of scope for braid. 25 extensions remain.

### Q5 — Module-level `let` migration (PARTIAL, commits `ccaa48c6`, `f8d651c0`)
Migrated 7 sites:
1. `core/input-polisher/index.ts:7` — `_isCompactionActive` lazy-load
2. `memory/context-manager/handlers/compaction.ts:114-126` — 5 vars consolidated into `CompactionInterceptState`
3. `memory/context-manager/handlers/shared.ts:96` — `_compactionActive` per-session
4. `core/prompt-builder/skills-section.ts:96` — skills cache
5. `memory/context-lifecycle/index.ts:57` — re-entrancy guard
6. `heartbeat/analytics/shared.ts:105` — analytics cache (documented as process-global mirror)
7. `core/agent-environment/index.ts:41` — full 50-line state object

**2 documented exceptions remain:**
- `context-lifecycle/state.ts:74-75` — `_currentSessionState` / `_currentSessionId` are used by `helpers.ts:readProposalsFromSession()` during session replay where no ctx is available; intentionally process-global and bounded by replay lifetime.
- `injection-tracker.ts` `_buckets` map (session-keyed) and `_sendDepth` counter (re-entry guard) — both are process-global with documented justification.

### Q6 — `HANDLER_REGISTRATIONS` removal (DONE, commit `0292e8c2`)
The exported `HANDLER_REGISTRATIONS` array was unused outside the file. Removed; handler registration is direct.

### Q8 — `Promise.allSettled` for LLM fanout (DONE, commit `155952b3`)
8 of 10 LLM-fanout sites converted to `Promise.allSettled` with an `unwrap()` helper. Exempt: `file-mutation-queue.ts` (queue ops, not LLM), `explore-paths.ts` (local glob). Test `test-promise-allsettled-pattern.mjs` scans 196 src files and asserts 0 violations.

### Q9 — Fragile heuristic fallbacks (DONE, commits `e8abefe6`, `2c92ed5f`, `ee8bc466`, `90de76a1`, `be8464d9`, `979117bf`, `43a1ae31`)
- 11 A-class fallbacks → `tierPolicy: "always-llm"` (skip tier 1 heuristic)
- 4 B-class fallbacks → `tierPolicy: "fallback-only"` (downweight to 0.5 confidence)
- 1 dead B-class fallback (`complianceFramingFallback`) removed
- `text-classifier.ts` got `tierPolicy: "prefer-heuristic" | "fallback-only" | "always-llm"` and `validLabels?: string[]` options
- Test `test-a-class-critic-policy.mjs` locks the rule: 11 specific A-class fallbacks must NOT be used as fallbacks at call sites
- Full inventory at `docs/FRAGILE-HEURISTICS-INVENTORY.md` (424 lines, 76 heuristics)

### Q10 — Auto-singleton CUT (DONE, commit `0292e8c2`)
`auto-singleton` extension removed (out of scope, near-zero usage, session-leak issue).

### Q12 — `signals.ts pruneSignals` (DONE, commit `0292e8c2`)
Signal retention extracted to `signals.ts` with `SIGNAL_RETENTION_TURNS = 1` constant.

### Q14 — `lib/utils/id.ts` (DONE, commit `dace97d6`)
`nextId(prefix)`, `setIdGenerator(fn)`, `setRandomSuffixFn(fn)`, `resetIdGenerator()` — replaced 23 `Date.now() + Math.random()` ID sites.

### P6 cleanup (DONE, commits `122b5c63`, `d16d5e45`, `485d58e8`, `43a1ae31`)
Removed 24 unused `log` declarations, 23 unused `createLogger` imports, 19 unused locals/params/declarations. `tsc --noUnusedLocals --noUnusedParameters` passes clean.

### Investigations (commits `c3e3d1cb`, `4555e871`, `eb8bb07c`, `43a1ae31`)

1. **Logging audit** — `docs/WHISPER-AND-LOGGING-AUDIT.md`. 0 anti-patterns: all 31 `ctx.ui.notify` are user-facing, 206 `createLogger` for diagnostics, 0 raw `console.*` outside logger.
2. **Whisper audit** — same doc. 37 `sendTrackedMessage` callsites, 0 direct `pi.sendMessage` outside the tracker.
3. **Timer flood cap bug** — fixed. Per-source cap (2/turn) was dropping 3rd timer fire. Replaced 2-path workaround (wake:true direct, wake:false through sendTrackedMessage) with unified `sendTrackedMessage(pi, params, options, meta, { bypassFloodCap: true })` path. The 5th `bypass` argument is a new API for user/agent-contracted events.
4. **Consolidation hint gate bug** — fixed. `isHintTooGeneric` was calling `CRITICS.hintQualityFallback()` directly (not through `classify()`), so the LLM tier never ran and the heuristic always returned "yes" (allow through). Generic debugging-cliché hints were never filtered. Now `isHintTooGeneric(task, steps, ctx)` is async and goes through `classify()` with `tierPolicy: "fallback-only"`.
5. **Q13 split large index.ts** — `docs/Q13-SPLIT-INDEX-STATUS.md`. 4 of 8 large files are already split (sub-module pattern). 4 are mechanical candidates (`memory-agent-bridge`, `timer`, `session-recall`, `latent-activator`) — deferred with documented trigger conditions.

## Decisions log

- **D-1 (2026-06-13)**: Logger bug (Q1) — RESOLVED, fix shipped
- **D-2 (2026-06-13)**: Q15 lint rules deferred
- **D-3 (2026-06-13)**: Q4 RESOLVED BY REMOVAL — `tool-safety` extension deleted
- **D-4 (2026-06-13)**: Q9 DEFAULTED to widened matcher — **REVERTED 2026-06-14**. Hand-coded heuristic fallbacks are FRAGILE; not trustworthy. Replace with LLM critic calls. TierPolicy plumbing added; per-critic audit applied.
- **D-5 (2026-06-13)**: All Q1–Q15 answered inline. Execution order: Q6 → Q10 → Q12 → Q3 → Q11 → Q9 → Q1 → Q2 → Q7 → Q5 → Q13 → Q8 → Q15
- **D-6 (2026-06-14)**: Promise.allSettled LINT RULE — apply to all LLM-fanout sites; exempt local-glob/queue operations
- **D-7 (2026-06-14)**: Q9 correct direction = Approach A: review whole codebase for fragile heuristics, replace with LLM critic calls. 76 total heuristics catalogued, 29 (A+B) flagged for replacement

## Deferred work (with documented triggers)

### Q13 — Split 4 large index.ts files
**Triggers to revisit:**
- A new contributor gets lost in one of the 4 unsplit files (>500 lines, no sub-module navigation)
- A test becomes flaky in one of the 4 files and the diagnostic chain is too long
- A refactor requires touching multiple unrelated sections in one of the 4 files

Files: `memory-agent-bridge/index.ts` (805L), `timer/index.ts` (596L), `session-recall/index.ts` (578L), `latent-activator/index.ts` (576L). All have clear section dividers.

### Q7 — Global state design policy
Already partially addressed by `src/lib/state/AGENTS.md` "State Policy" table. Full design policy doc was on the Q-blocked list and not written. The 2 documented exceptions (replay state, re-entry guard) cover the edge cases.

### Q15 — ESLint rule authoring
Authoring custom rules (e.g., "no `Promise.all` over LLM-fanout", "no `Date.now() + Math.random()`") was deferred. The test `test-promise-allsettled-pattern.mjs` partially fills this gap. A formal ESLint setup is a separate project.

## New infrastructure added

- `bypassFloodCap` flag in `sendTrackedMessage` (5th arg) — for user/agent-contracted events
- `getExtensionState(ctx, key, factory)` for per-session state (already existed, used more)
- `getNudgeManager(ctx)`, `getSessionIdSafe(ctx)`, `getLeafIdSafe(ctx)` helpers
- `getIsCompactionActive()` wrapper for input-polisher
- `lib/utils/id.ts` (nextId, setIdGenerator, setRandomSuffixFn, resetIdGenerator)
- `lib/utils/dedup.ts` (hashForDedup)
- `lib/constants/injection-details.ts` (BRAID_INJECTED, BRAID_SOURCE)
- `lib/constants/session-thresholds.ts` (MAX_SESSION_AGE_MS, NUDGE_COOLDOWN_TURNS, NUDGE_COOLDOWN_MS, HINT_MAX_AGE_MS, ANCHOR_TURNS_BEFORE_RESET, MIN_TEXT_LENGTH_FOR_CLASSIFY)
- `text-classifier.ts tierPolicy` (always-llm, fallback-only, validLabels)
- `lib/core/logger.ts setConsoleLogLevel(level)`
- `lib/enforcement/signals.ts pruneSignals(currentTurn)` and `SIGNAL_RETENTION_TURNS = 1`

## New tests added

- `test/runtime/lib/test-a-class-critic-policy.mjs` — locks 11 A-class fallbacks to `tierPolicy: always-llm`
- `test/runtime/lib/test-promise-allsettled-pattern.mjs` — scans src/ for `Promise.all` over LLM-fanout
- `test/runtime/lib/test-logger.mjs` — Q1 fix regression
- `test/runtime/lib/test-text-classifier-tier-policy.mjs` — tierPolicy plumbing
- `test/runtime/test-arxiv-citations.mjs` — Q2 arXiv citation guard
- `test/runtime/lib/test-enforcement-deps.mjs` — enforcement dependency graph
- `test/runtime/lib/test-enforcement-state-composition.mjs` — state factory contracts
- `test/runtime/test-manifest-consistency.mjs` — manifest ↔ filesystem consistency
- Updated `test/runtime/lib/test-timer-fire-wake-handling.mjs` — unified `sendTrackedMessage` + `bypassFloodCap` architecture

## Reference docs

- `docs/CODE-QUALITY-REMEDIATION-PLAN.md` — this doc
- `docs/FRAGILE-HEURISTICS-INVENTORY.md` — 76 heuristics classified A/B/C/D
- `docs/WHISPER-AND-LOGGING-AUDIT.md` — 37 sendTrackedMessage callsites, 31 ctx.ui.notify
- `docs/ARXIV-CITATIONS-AUDIT.md` — 7 cited papers, all real
- `docs/Q13-SPLIT-INDEX-STATUS.md` — split deferral rationale
- `docs/TIMER-DELIVERY-INVESTIGATION.md` — historical (from prior session)
- `docs/AUTO-SINGLETON-DECISION.md` — historical (from prior session)
- `docs/CUT-CANDIDATES-DEEP-DIVE.md` — historical (from prior session)
