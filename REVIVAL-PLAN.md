# pi-braid Revival Plan

Transformation of the critical review into an actionable recovery roadmap.
Each item has a diagnosis, a targeted fix, files affected, and success criteria.
Ordered by impact/effort ratio — start at the top.

---

## Tier 1: High Impact, Safe, Achievable Solo (days)

### ~~1. Merge the Two Nudge Systems~~ ✅ DONE

**Changes made:**
- Removed `src/extensions/nudge/` (entire directory)
- Removed nudge module registration from `src/modules/definitions.ts`
- Removed `FEEDBACK_DIR`, `FEEDBACK_FILE`, `FEEDBACK_ANALYTICS_FILE` from `src/lib/braid-paths.ts`
- Enforcement already covered all active nudge triggers (scratchpad missing, think tool missing)
- Nudge's `message_end` handler had a dead loop (empty issues array)
- Test count: 58→57 (removed no-op extension, 0 regressions)

**Diagnosis:** `extensions/nudge/` and `extensions/enforcement/` both check think-tool-missing, scratchpad-missing, silent turns on the same events and both send messages to the agent. Agent receives duplicates.

**Action:** Pick one canonical path. The enforcement extension already owns the turn_end dispatch. Move the nudge extension's unique triggers into enforcement's `dispatchTurnEndLoop`, then disable or remove the nudge extension.

Specifically:
- Nudge's `scratchpad_missing` detection at turn_end → merge into enforcement's existing scratchpad check (currently at `turn-end-handler.ts:~200`). Nudge checks `tools.length >= 3` as a trigger; enforcement only checks file changes. Merge both conditions.
- Nudge's `think_tool_missing` detection at turn_end → merge into enforcement's existing think enforcement (currently at `turn-end-handler.ts:~240`). Nudge's variant (`madeHighStakesAction && noThinkEver && currentTurn >= 3`) is already partially replicated.
- Nudge's A/B testing framework → remove or extract as a standalone tool. It's disabled by default and has no consumers of its accumulated data.
- Nudge's file persistence (`NUDGE_HISTORY_FILE`, `AB_TESTS_FILE`, `MODEL_PREFS_FILE`, `CONFIG_FILE`) → stop writing nudge history to disk. Enforcement doesn't persist nudges; nudge extension shouldn't either. Remove persistence.

**Files:**
- `src/extensions/nudge/index.ts` — strip down to just what enforcement doesn't cover, then remove module registration from `definitions.ts`
- `src/extensions/enforcement/handlers/turn-end-handler.ts` — merge nudge's `isComplexTurn` check into scratchpad detection
- `src/modules/definitions.ts` — remove nudge module entry
- `src/lib/braid-paths.ts` — remove `FEEDBACK_DIR` and related paths if no longer used

**Success criteria:**
- No duplicate "consider using think()" messages in a single turn
- No duplicate "update scratchpad" messages in a single turn
- Nudge extension module can be removed without functional change
- Zero writes to `~/.pi/agent/braid/feedback/`

---

### ~~2. Wire `enforcement_signals` Payload to the Agent~~ ✅ DONE

**Changes made:**
- Removed the heavy signal bundle construction + `pi.events.emit` from `turn-end-handler.ts` (the `enforcementSignals` categorization loop, `contrastMode` emission, and full bundle emit)
- Removed duplicate `pi.events.emit( `pi.events.emit("enforcement_signals", { turn, signals: {...}, contrastMode })` fires every turn_end with a full signal bundle. The only listener (`prompt-builder/index.ts`) extracts only `contrastMode` and throws away `signals`. The turn-end handler also emits individual signals via `sendTrackedMessage` — so the signal bundle is built, serialized, emitted, and ignored.

**Action:** Remove the dual path. Either the signal bundle is the canonical message source, or the individual `sendTrackedMessage` calls are. Pick one.

Option A (recommended — simpler): Stop building the signal bundle in `turn-end-handler.ts` lines 388-430. The individual `sendEnforcementWhisper` calls throughout the handler already deliver each signal. Delete the bundle-building block and the `pi.events.emit` call.

Option B (if you want the bundle): Route the bundle through `sendEnforcementWhisper` instead of `pi.events.emit`. Replace the emit with a single composed message.

**Files:**
- `src/extensions/enforcement/handlers/turn-end-handler.ts` — lines 388-430: signal bundle construction and emission
- `src/extensions/enforcement/handler-registry.ts` — line 436: secondary emit point
- `src/extensions/core/prompt-builder/index.ts` — lines 597-605: listener that only reads contrastMode (simplify or remove)

**Success criteria:**
- `pi.events.emit("enforcement_signals", ...)` has zero callers, or every emission is consumed
- The signal bundle and individual whispers don't both fire for the same condition
- Fewer lines of code in turn-end-handler.ts

---

### ~~3. Fix Module-Level State Leak in Bidirectional Verifier~~ ✅ DONE

**Changes made:**
- Removed all module-level state arrays (`_claimedActions`, `_mismatches`, `_derivedFiles`, `_staleDerivedFiles`, `_coordinationRisks`)
- Removed all dead Phase 2/4 functions that wrote to them (`recordClaimedActions`, `validateArtifact`, `recordDerivedFrom`, `markDerivedResolved`, `checkCoordinationRisk`, `scanForDerivedFiles`, `getArtifactValidationSummary`, `getCoordinationCheckSummary`, `getFullVerificationReport`, `validateCompletion`)
- Removed unused type exports (`ClaimedAction`, `CompletionValidation`, `DerivedFile`)
- Trimmed file from ~480 lines to ~130 lines
- Updated test file to match (removed BV2/BV4 test suites)

**Diagnosis:** Three module-level arrays (`_claimedActions`, `_mismatches`, `_derivedFiles`) accumulate across sessions because "they can't be per-session due to stale ctx." Any statement the agent makes carries over into the next session as a "claimed action."

**Action:** Move these into session-scoped state. The stale ctx problem only affects `extension-state.ts` when `sessionManager` throws — which is handled by the `safeSessionManager` pattern. Use the same pattern: try to get session-scoped state; fall back gracefully.

If stale ctx is genuinely unrecoverable (the WeakMap fallback in extension-state.js also won't help), then at minimum add a `clearAllBidirectionalState()` call on `session_shutdown` event. Enforcement already listens to `session_shutdown` in `handler-registry.ts` — add the cleanup there.

**Files:**
- `src/lib/bidirectional-verifier.ts` — lines ~75-80: `_claimedActions`, `_mismatches`, `_derivedFiles` module-level declarations
- If moving to session-scoped: create a state interface and use `getExtensionState`
- If keeping module-level: add cleanup call in `handler-registry.ts` session_shutdown handler

**Success criteria:**
- Run two sequential sessions. Session A makes a claimed action. Session B starts fresh — zero inherited claims.
- The `session_shutdown` handler in enforcement calls the cleanup function.

---

### ~~4. Nuke or Repurpose the Logging-Only Event Bus Consumers~~ ✅ DONE

**Changes made:**
- Deleted `src/lib/event-consumers.ts` entirely (7 logging-only handlers)
- Removed call to `registerEventConsumers()` from heartbeat-scheduler session_start
- Removed call to `resetSessionCounters()` from heartbeat-scheduler session_shutdown
- Deleted the test file `test-event-consumers.mjs`

**Diagnosis:** `lib/event-consumers.ts` registers 7 handlers. Each one increments a counter and logs. No handler triggers an action. The comments acknowledge this (`"This handler adds parallel logging and metrics tracking"`).

**Action:** Either:
- (a) Remove `registerEventConsumers()` entirely — saving code, removing a registration step, eliminating 7 lines of "does nothing" from every session startup.
- (b) Make each handler actually do something: `context_full` should trigger compaction, `enforcement_violation` should log to a structured sink that's queryable, `timer_fire` should... not exist (timer already handles itself).

Option (a) is safe and immediate. The counters (`_violationCount`, `_peakUsagePercent`) are never read by any subsystem — grep for them to confirm.

**Files:**
- `src/lib/event-consumers.ts` — entire file
- Any file that calls `registerEventConsumers()` — remove the call

**Success criteria:**
- The file `event-consumers.ts` is deleted, or every handler produces an observable effect
- No regression in timer, enforcement, or memory behavior

---

### ~~5. Remove Dead Code~~ ✅ DONE

**Changes made:**
- Deleted `src/extensions/enforcement/prompts.ts` (32 lines, inlined `POST_TURN_VALIDATION_TEMPLATE` into `validation.ts`)
- Deleted `src/extensions/enforcement/judge.ts` (489 lines, never imported)
- Removed unused `JUDGE_SYSTEM_PROMPT` from `judge-prompt.ts` (kept `VERIFICATION_JUDGE_SYSTEM_PROMPT`)
- Polyfill verified as doing real work — skipped

**Diagnosis:** Multiple files have zero consumers:
- `src/extensions/enforcement/prompts.ts` — `ENFORCEMENT_PROMPT_PREFIX`, `ENFORCEMENT_WHISPER_FORMAT`, `getEnforcementPrompt()` never imported
- `src/extensions/enforcement/judge.ts` — 489-line LLM judge that almost never runs (guarded by `tools.length === 0 && hasCodeChanges && >1 turn gap && >60s cooldown`)
- `src/extensions/core/polyfill/` — 0 source files found under dist but exists in src. Check if it's actually a no-op.

**Action:** 
- Delete `prompts.ts` — 32 lines, zero callers
- Either fix the judge activation condition or delete the module. If kept, change the guard from `actualTools.length === 0` to `actualTools.length <= 2` — this at least catches plausible scenarios.
- Verify polyfill is doing work. If it's a no-op, remove its entry from definitions.ts.

**Files:**
- `src/extensions/enforcement/prompts.ts` — delete
- `src/extensions/enforcement/judge.ts` and `judge-prompt.ts` and `judge-utils.ts` — fix or delete
- `src/extensions/core/polyfill/index.ts` — inspect for actual work

**Success criteria:**
- `grep -r 'prompts' src/` returns zero imports from prompts.ts
- Judge fires on at least one realistic scenario per 20 turns (not once per session)

---

## Tier 2: Structural But Contained (needs design agreement, ~week)

### ~~6. Create a `turn_end` Coordinator~~ ✅ DONE

**Changes made:**
- Created `src/lib/turn-end-coordinator.ts` — lightweight priority-ordered handler dispatch with deduplication, error isolation, and debugging helpers
- Modified `handler-registry.ts` — enforcement registers two handlers (`enforcement-analysis` at priority 100, `enforcement-loop` at priority 90)
- Single `pi.on("turn_end")` entry point dispatches through coordinator
- Testable: `getRegisteredHandlers()`, `clearHandlers()`, `handlerCount()`

**Diagnosis:** Enforcement owns the `turn_end` slot entirely. Any new post-turn concern must be added to enforcement's handler chain. This is why enforcement is 3000+ lines with 14 concerns — there's no alternative registration point.

**Action:** Build a simple coordinator that other extensions can register against. Not the event bus (too generic). Not a module system (too heavy). Just a `Map<string, TurnEndHandler>` that collects callbacks and runs them in priority order.

```typescript
// lib/turn-end-coordinator.ts
export type TurnEndHandler = (event: any, ctx: ExtensionContext) => Promise<void>;

const _handlers: { name: string; priority: number; handler: TurnEndHandler }[] = [];

export function registerTurnEndHandler(name: string, priority: number, handler: TurnEndHandler): void {
  _handlers.push({ name, priority, handler });
  _handlers.sort((a, b) => b.priority - a.priority);
}

export async function dispatchTurnEnd(event: any, ctx: ExtensionContext): Promise<void> {
  for (const h of _handlers) {
    try {
      await h.handler(event, ctx);
    } catch (err) {
      log.error(`turn_end handler ${h.name} failed:`, err);
    }
  }
}
```

Then:
- Enforcement registers its current turn_end logic as one handler (priority 100)
- Nudge registers its turn_end logic as a separate handler (priority 90)
- Claim tracker registers as its own handler (priority 80)
- etc.

Each handler is independently testable. You can add/remove handlers without touching enforcement.

**Eventually**, extract the monolithic call chain in `dispatchTurnEndAnalysis` and `dispatchTurnEndLoop` into individually registered handlers, so enforcement's turn_end handler becomes:

```typescript
pi.on("turn_end", (event, ctx) => dispatchTurnEnd(event, ctx));
```

And enforcement's individual concerns register at init:
```typescript
registerTurnEndHandler("enforcement-main", 100, turnEndHandler);
registerTurnEndHandler("error-burst", 90, errorBurstHandler);
registerTurnEndHandler("context-overflow", 80, contextOverflowHandler);
registerTurnEndHandler("think-enforcement", 60, thinkEnforcementHandler);
registerTurnEndHandler("scratchpad-nudge", 50, scratchpadNudgeHandler);
```

**Files:**
- `src/lib/turn-end-coordinator.ts` — new file
- `src/extensions/enforcement/handler-registry.ts` — replace direct `pi.on("turn_end", ...)` with coordinator dispatch
- Individual enforcement handlers become separate functions or modules

**Success criteria:**
- Any extension can register a `turn_end` handler without touching enforcement code
- Each handler can be tested independently
- Enforcement's handler-registry.ts is shorter after extraction than before

---

### ~~7. Decompose `BehavioralState` God Interface~~ ✅ DONE

**Changes made:**
- `BehavioralState` removed (was 5 mixed concerns in one interface)
- Split into 4 focused sub-state interfaces:
  - `MemoryHygieneState` — memory tool tracking (`memory-hygiene-state.ts`)
  - `ScratchpadState` — scratchpad usage and verification nudges (`scratchpad-state.ts`, new file)
  - `ContextHygieneState` — context usage and overflow (`context-hygiene-state.ts`)
  - `ThoughtChainState` — think() tracking and reflection gaps (`thought-chain-state.ts`)
- Each sub-state has its own factory, reset function, and accessor helpers
- Sub-state files do NOT import `state.ts` (avoids circular dependency via intersection types)
- `EnforcementState` now extends 7 focused interfaces instead of 4
- `toolCallsAtLastRecommendation` moved to `ToolTrackingState` (it tracks BPE progress)
- 3 dead hygiene-score fields dropped (zero external references)
- `recordCompaction` helper no longer touches scratchpad state directly (uses intersection type)

**Diagnosis:** `BehavioralState` in `behavioral-state.ts` holds 5 independent concerns under one interface: memory hygiene, scratchpad nudges, context hygiene, thought chains, hygiene scoring. The sub-state composition pattern was supposed to prevent this — but `BehavioralState` became the miscellaneous drawer.

**Action:** Split into proper sub-state interfaces:

```typescript
// memory-hygiene-state.ts
export interface MemoryHygieneState { lastMemoryCall, turnsSinceMemory, ... }

// scratchpad-state.ts  
export interface ScratchpadState { lastScratchpadNudgeTurn, claimsDetectedThisTurn, ... }

// context-hygiene-state.ts  (already partially exists — consolidate)
export interface ContextHygieneState { contextNudgeSent, lastContextCheckTurn, ... }
```

Each gets its own factory, reset, and accessor helpers. The composed `EnforcementState` becomes a 6-way spread instead of 4-way — but each spread has a single, clear concern.

**Files:**
- `src/extensions/enforcement/behavioral-state.ts` — delete, replaced by 3-4 focused files
- `src/extensions/enforcement/state.ts` — update composition
- Individual state accessors in handlers to import from new files

**Success criteria:**
- `BehavioralState` no longer exists as a type
- Each new sub-state interface has ≤5 properties and a single documented concern

---

### ~~8. Fix Paper-Claim Gap in Documentation~~ ✅ DONE

**Changes made:**
- `mars-reflector.ts`: Removed "MARS" paper citation. Now describes itself as "Tool Usage Frequency Analyzer"
- `claim-tracker.ts`: Removed "RepE §5 — honesty direction in residual stream". Added caveat about heuristic detection
- `dreamer.ts`: Removed "arXiv:2604.14178". Now describes as "1-deep Markov transition model"
- `consolidation-channel.ts`: Removed "Contextual Agentic Memory (2604.27707)" and "MARS (2601.11974)"
- `definitions.ts`: Enforcement module paper field changed from "Representation Engineering (RepE)" to accurate description

**Diagnosis:** Multiple files cite arXiv papers for implementations that don't match the cited technique.

**Action:** For each module, either:
- Update the comment/docstring to describe what it actually does (e.g., "heuristic tool-overuse detection" not "MARS")
- Or remove the paper citation if it's misleading

Specifically:
- `mars-reflector.ts`: Remove "MARS" from docstring. Replace with "Tool usage frequency analysis."
- `claim-tracker.ts`: Remove "RepE §5 — honesty direction in residual stream" from the header comment. Replace with "Cross-turn text claim extraction."
- `dreamer.ts`: Remove "arXiv:2604.14178 Heartbeat Scheduling" from docstring. Replace with "Simple Markov transition predictor."
- `consolidation-channel.ts`: Remove "MARS (2601.11974)" and "2604.27707" references. Replace with "Scoring + file-based queue."
- `definitions.ts`: Update enforcement module's `paper` field from "Representation Engineering (RepE)" to something accurate.

**Files:**
- `src/lib/mars-reflector.ts` — top comment
- `src/lib/claim-tracker.ts` — top comment  
- `src/lib/dreamer.ts` — top comment
- `src/lib/consolidation-channel.ts` — top comment
- `src/modules/definitions.ts` — enforcement module paper field

**Success criteria:**
- Every paper citation in the codebase matches the actual implementation technique
- No module claims to implement a technique it doesn't use

---

## Tier 3: Aspirational (needs larger investment, 2+ weeks)

### 9. Extract Enforcement's 14 Concerns into Independent Modules

Once the turn_end coordinator exists (Tier 2, #6), each concern in enforcement becomes a candidate for extraction into its own extension. The goal isn't more files — it's independent testability and removability.

Candidates for extraction:
- **Claim tracker** → `extensions/cognitive/claim-tracker/` (already exists as a lib module; just needs extension wrapper)
- **Verification judge** → `extensions/cognitive/verification-judge/` (fix the guard condition first)
- **Context overflow** → `extensions/memory/context-overflow/` (belongs with memory, not enforcement)
- **Language detection** → `extensions/core/language-detection/` (already partially separate)

Each extraction follows the same pattern:
1. Create extension directory with `index.ts`
2. Register at `definitions.ts` under the appropriate module
3. Register turn_end handlers via the coordinator
4. Remove the corresponding code from enforcement

**Effort:** 2-3 days per extraction. After 3 extractions, enforcement is ~40% smaller and each extracted module has clear boundaries.

---

### 10. Make Event Bus Actually Route Events to Actions

The event bus infrastructure is solid. The problem is all consumers are logging-only. To revive it:

1. Each `eventBus.on(...)` handler should have exactly one measurable side effect
2. `context_full` → trigger `pi.sendMessage(...)` to the agent, or call the coordinator
3. `enforcement_violation` → push to a structured error sink (e.g., error-tracking module)
4. `analytics_alert` → push to a monitoring dashboard or log sink

This requires: (a) giving event handlers access to `pi` and `ctx`, (b) deciding who owns the event bus lifecycle.

**Effort:** 1 week to design the API, 2-3 days to migrate the first 2 handlers.

---

### 11. Replace Dreamer/MARS With Something That Has a Feedback Loop

The core flaw in both Dreamer and MARS is that they produce advice without ever learning whether the advice was correct or acted upon.

To fix this:
1. **Tag each advice emission** with a unique ID
2. **Observe the next N turns**: was the advice followed? Did the predicted outcome occur?
3. **Adjust thresholds** based on prediction accuracy

This is what `reportRecommendationOutcome` in the belief-policy-engine already attempts — but the feedback is binary (tool calls increased or not) and doesn't connect back to the original advice. Make the connection explicit: advice ID → outcome → threshold update.

Without this feedback loop, Dreamer and MARS are noise generators. With it, they're learning systems.

**Effort:** 1 week for the feedback protocol + instrumenting one subsystem (start with Dreamer, simpler).

---

### 12. Unit Tests for Lib Modules

**Diagnosis:** 63 integration tests, zero unit tests. Lib modules (`evidence-pool.ts`, `claim-tracker.ts`, `dreamer.ts`, `mars-reflector.ts`, etc.) have no isolated verification.

**Action:** Add unit tests using the existing test-*.mjs pattern but without launching pi. Each test:
- Imports the module directly
- Creates a minimal mock context (`{ sessionManager: null }`)
- Calls the exported functions with known inputs
- Asserts known outputs

Start with pure functions that have no pi dependency:
- `evidence-pool`: `addEvidence()`, `detectConflicts()`, `formatConflictMessage()` — all pure data transformations
- `dreamer`: `simulatePaths()` — inputs → outputs, no side effects
- `mars-reflector`: `buildPattern()`, `generateAdvice()` — inputs → outputs
- `claim-tracker`: claim extraction from text — input string → output Claim[]
- `bidirectional-verifier`: `checkLocalizationRisk()`, `verifyCompletion()` — state + input → output

**Effort:** 2-3 days for the first 5 modules. ~20 tests covering ~80% of pure function surface.

---

## Execution Order

```
══ COMPLETED ════════════════════════════════════════════════════════════
Week 1 (solo, safe, days):                          Week 2 (structural, ~week):
┌──────────────────────────────────┐                ┌──────────────────────────────────┐
│ ✅ #1 Merge nudge systems         │                │ ✅ #6 Turn-end coordinator       │
│ ✅ #2 Wire enforcement_signals    │                │ ✅ #7 Decompose BehavioralState   │
│ ✅ #3 Fix state leak              │                │ ✅ #8 Fix paper docs              │
│ ✅ #4 Remove event bus consumers  │                └──────────────────────────────────┘
│ ✅ #5 Remove dead code            │                
└──────────────────────────────────┘                

══ REMAINING (Tier 3, needs investment) ═══════════════════════════════
#9  Extract enforcement concerns into independent modules
#10 Make event bus route events to actions
#11 Feedback loop for Dreamer/MARS
#12 Unit tests for lib modules
```

---

## Measuring Success — Actual Results

- **~2000 lines of dead code removed** (prompts.ts, judge.ts, event-consumers.ts, nudge extension, bidirectional-verifier Phase 2/4, BehavioralState)
- **Duplicate messages eliminated:** nudge extension removed — enforcement is now the sole nudge delivery path
- **State leak fixed:** bidirectional-verifier module-level arrays removed; BehavioralState decomposed into focused sub-states
- **Dead code eliminated:** prompts.ts (32L), judge.ts (489L), event-consumers.ts (160L), nudge extension (544L), bidirectional-verifier Phase 2/4 (~250L)
- **Paper citations match reality:** 5 files updated to remove misleading paper references
- **Turn-end coordinator created:** infrastructure exists for non-enforcement handlers
- **Zero regressions:** 56/57 tests pass (1 pre-existing failure in quick-benchmark — analytics tools never implemented)