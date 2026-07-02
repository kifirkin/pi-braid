<!-- status: current -->

# src/lib/state/ - State Management

## Purpose

Per-extension state, session state, and global state utilities. The canonical
home for "where do I put state that needs to outlive a function call".

## Ownership

| File | Owns |
|---|---|
| `extension-state.ts` | `getExtensionState(ctx, key, factory)` - per-session, per-extension state. **The canonical pattern.** |
| `global-state.ts` | Process-global state (use sparingly - only for things that must survive session boundaries). All process-global `let` declarations in `lib/` are colocated here. |
| `session-manager.ts` | Wrapper around pi core's session manager. |
| `session-start-queue.ts` | Queues handlers that need to run on `session_start`. |
| `metacognitive-state.ts` | State for the metacognition layer. |
| `state-checkpoint.ts` | Save/restore extension state to disk for crash recovery. |
| `workspace-snapshot.ts` | Snapshot of the workspace (file contents, session position). |
| `async-storage.ts` | Async-local-storage wrapper for context propagation. |

## Local Contracts

### Per-extension, per-session state: use `getExtensionState(ctx, key, factory)`.

`getExtensionState` is session-scoped, resets on `session_start`, and is the
only correct pattern for data that one extension reads/writes for the duration
of a single session.

### Process-global state: use `global-state.ts`.

For state that **must** survive session boundaries (custom model keys, cached
model specs, singleton class instances), declare a getter and (optional)
setter in `global-state.ts`. The `let` is encapsulated in that file; consumers
call the getter.

### Module-level `let` is banned for stateful data.

Module-level `let` variables leak across sessions. They are acceptable ONLY
for the documented exceptions below, and only when a process-global slot
in `global-state.ts` cannot be used (e.g., the value is needed in code paths
that have no access to a `global-state` import, like pi core's hook
invocations).

### Re-entrancy guards are exempt.

The `MAX_REENTRY_DEPTH` re-entry counter in `lib/utils/injection-tracker.ts`
(`_sendDepth`) and the re-entrancy guard in `lib/memory/context-lifecycle/state.ts`
(`_currentSessionState` / `_currentSessionId`) are process-global by necessity:
they protect against the runtime re-entering an extension's hook before a
prior call has returned. They are documented in the `## Documented exceptions`
section below.

## State Policy (which file to use for what)

| Need to store | Use | Why |
|---|---|---|
| Per-session data for one extension | `getExtensionState(ctx, "key", factory)` | Session-scoped; resets on session_start. |
| Cross-extension configuration (e.g., custom model keys from /commands) | `global-state.ts` (`getCustomModelKey`, etc.) | Process-lifetime; one map shared across all sessions. |
| Per-session data spanning many extensions (e.g., recent errors) | `getExtensionState` with a shared key | Scoped to the session. |
| Singleton class instances used by multiple extensions | `global-state.ts` (one per singleton) | Process-lifetime is correct. |
| Caches that span session boundaries (e.g., resolved model specs) | `global-state.ts` with explicit cache invalidation | Reusing across sessions is the goal. |
| Scratchpad / plan / current goal | `getExtensionState(ctx, "scratchpad", factory)` | Per-session. |
| Cached LLM responses | `global-state.ts` keyed by input hash, with TTL | Reuse across sessions. |
| Re-entrancy guards (sync-flow protection) | Module-level `let` (exception) | Needed where no ctx is available. |
| Test-injectable function slots (e.g., id generators) | Module-level `let` (exception) | Intentionally swappable for test isolation. |

## Documented exceptions (module-level `let`)

The sites below are EXPLICITLY acceptable violations of the
"no module-level let" rule. Each is justified by a specific runtime
constraint that prevents using `getExtensionState` or `global-state.ts`.

The exception list is enforced by `test/runtime/lib/test-no-module-level-let.mjs`
(Q15 lint). Adding a new exception requires editing both that test AND this table.

### A. Re-entry guards (sync-flow protection)

| File | Symbol | Justification |
|---|---|---|
| `context-lifecycle/state.ts:100-101` | `_currentSessionState`, `_currentSessionId` | Session replay path (`helpers.ts:readProposalsFromSession()`) has no ctx. Reset on `session_start`. Bounded by replay lifetime. (Line numbers shifted 2026-06-22 when policyEngine + detector fields were added to ContextLifecycleState as part of DR-C-2 migration.) |
| `injection-tracker.ts:48` | `_activeSessionId` | Tracks the active session for flood-cap accounting. Sync re-entry path. |
| `injection-tracker.ts:56` | `_sendDepth` | Re-entry guard. Incremented before `pi.sendMessage`, decremented after. |
| `enforcement/turn-dedup.ts:84` | `_state` | Per-turn dedup state; sync access from event handlers. |

### A2. Lazy-load guards (disk-backed persistence init)

| File | Symbol | Justification |
|---|---|---|
| `lib/store/evidence-pool.ts:38` | `loadedFromDisk` | `async-storage` cache-load guard. Prevents re-reading the evidence pool JSON file on every `getState()` call. Fires once on first access, merges disk state into session scoped state, then no-ops. No ctx available at the time of the async init call. |

### B. Test-injectable function slots (intentionally mutable for test isolation)

| File | Symbol | Justification |
|---|---|---|
| `lib/ai/llm-call.ts:53` | `_completeSimple` | Stub `completeSimple` for behavioral testing (timeout, signal abort, retry) without a real LLM provider. Reset to production via `__setCompleteSimpleForTest(null)`. See `test-call-llm-behavior.mjs`. |
| `lib/utils/id.ts:29,33,35` | `_randomSuffix`, `_counter`, `_idGenerator` | `setIdGenerator` / `resetIdGenerator` / `setRandomSuffixFn` are the test injection API. See `test-id-injection.mjs`. |

### C. Encapsulated lets in `global-state.ts` (getter pattern)

| File | Symbol | Justification |
|---|---|---|
| `global-state.ts:82` | `_rotationState` | Encapsulated; only `getRotationState()` exported. |
| `global-state.ts:118` | `_nudgeAnalyticsFallback` | Encapsulated; only `getNudgeAnalyticsFallback()` exported. |
| `global-state.ts:144` | `_cognitiveMemoryInstance` | Encapsulated; only `getCognitiveMemoryInstance()` exported. |
| `global-state.ts:172` | `_postLoopTimeoutMs` | Encapsulated; only `getPostLoopTimeoutMs()` / `setPostLoopTimeoutMs()` exported. Defaulted from `DEFAULT_POST_LOOP_TIMEOUT_MS` (30_000). Tunable so the post-loop timeout can change without code edits. |
| `global-state.ts:279` | `_timerExtensionFactoryState` | Encapsulated; only `getTimerExtensionFactoryState()` exported. Used by `extensions/scheduling/timer/index.ts` to count factory invocations and warn when the DR-C-4 single-process-per-session assumption is violated (see the comment block at timer/index.ts:16-41). |
| `global-state.ts:309` | `_shownDiscoveryBundles` | Encapsulated; only `getShownDiscoveryBundles()` / `resetShownDiscoveryBundles()` exported. Used by `extensions/enforcement/handlers/register-session-start-discoverability.ts` to dedup the bundled discoverability whisper across /reload calls within the same process. The extension module is re-evaluated on /reload, so a module-level Set there would be lost. |

### D. Logger / framework config (process-global by design)

| File | Symbol | Justification |
|---|---|---|
| `lib/core/logger.ts:73,79,80,96` | `_boundContext`, `_globalMinLevel`, `_globallySuppressed`, `_consoleMinLevel` | Process-global logger configuration. Mutated by `setLoggerContext`, `setLogLevel`, `setConsoleLogLevel`. |
| `lib/state/extension-state.ts:42` | `_lastSessionKey` | Memoization cache for session-key derivation. |
| `lib/state/session-start-queue.ts:44` | `initialized` | One-time init flag. |
| `lib/state/async-storage.ts:24` | `flushScheduled` | Process-global flush scheduling flag. |

### E. Session-state mirrors (process-global fallback for code without ctx)

| File | Symbol | Justification |
|---|---|---|
| `core/input-polisher/index.ts:10` | `_isCompactionActiveImpl` | Lazy-load wrapper. The function reference is set once in SESSION_START and never reassigned; effectively const. |
| `heartbeat/analytics/shared.ts:109` | `_lastState` | Process-global mirror; pi-core's single-session-per-process model makes this equivalent to per-session. |
| `context-manager/handlers/shared.ts:125` | `_fallbackActive` | Process-global mirror; same single-session-per-process justification. |
| `lib/detection/degradation-detector.ts:63` | `_global` | Legacy fallback for tool handlers without ctx. |
| `lib/detection/topic-drift-detector.ts:66` | `_ctx` | Cached ctx for sync access; `setCriticCtx` is the injection API. |
| `lib/events/timer-bus.ts:22` | `pendingReminders` | Timer-reminder queue. |
| `lib/ai/llm-call.ts:78` | `rateLimitCooldownUntil` | Rate-limit timestamp. |

### F. Mutable config values (tunable parameters, intentionally exported)

| File | Symbol | Justification |
|---|---|---|
| `lib/reasoning/advice-tracker.ts:47,50` | `dreamerCooldownMs`, `marsOveruseMultiplier` | Tunable parameters, adjusted by accuracy feedback. |
| `lib/reasoning/advice-tracker.ts:60` | `_idCounter` | ID generator counter. |

### H. Scratchpad write queue (debounced, process-global)

| File | Symbol | Justification |
|---|---|---|
| `scratchpad/utils.ts:214-216` | `_pendingPad`, `_flushTimer`, `_lastError` | Debounced scratchpad write queue. Process-global by design: coalesces rapid mutations from any session to the same events.jsonl file. Not per-session because the queue's purpose is to batch writes across all handlers. See ROADMAP P2-8 / DR-L-5. |

### I. Search backend cache (process-global, no ctx during tool exec)

| File | Symbol | Justification |
|---|---|---|
| `session-recall/search.ts:58` | `_cachedBackend` | Cached search backend detection result (rg/grep/node). Process-global by design: survives across calls within the same process. There's no ctx during tool execution (the tool execute callback doesn't receive ctx with sessionKey), so getExtensionState is not available. |

### Migration history

| Date | Action | Result |
|---|---|---|
| 2026-06-13 | First Q5 audit | 7 sites migrated to `getExtensionState`. |
| 2026-06-17 | Second Q5 audit | 2 additional sites (`nudge-analytics`, `memory singleton`) moved to `global-state.ts`. |
| 2026-06-17 | `test-no-module-level-let.mjs` added | 27 documented exceptions enumerated. Test enforces the policy. |
| 2026-06-27 | DR-C-4 runtime check added | `_timerExtensionFactoryState` added (28 documented exceptions). Process-global counter for the timer extension factory; logs a warning when the single-process-per-session assumption is violated. |
| 2026-07-01 | GAP #3: cross-session evidence pool persistence | `loadedFromDisk` added (29 documented exceptions). Async-storage lazy-load guard for the evidence pool JSON file. |
| 2026-07-02 | /reload discoverability dedup | `_shownDiscoveryBundles` added (30 documented exceptions). Process-global Set in global-state.ts prevents the bundled discoverability whisper from re-firing on /reload. Extension module is re-evaluated on /reload, so a module-level Set would be lost. |
| 2026-07-02 | P2-8 scratchpad write debounce | `_pendingPad`, `_flushTimer`, `_lastError` added (33 documented exceptions). Module-level let in scratchpad/utils.ts for the debounced write queue. Process-global by design: coalesces writes from all handlers to the same events.jsonl file. |
| 2026-07-02 | P2-10 session-recall split | `_cachedBackend` added (34 documented exceptions). Module-level let in session-recall/search.ts for cached search backend detection. No ctx during tool execution. |

## Work Guidance

- **Adding new state**: pick the right file from the State Policy table first. If you're tempted to add a `let` at module scope, stop: either use `getExtensionState` (with a ctx) or add a getter to `global-state.ts` (without a ctx).
- **Migrating a module-level `let`**: replace it with `const foo = getExtensionState(ctx, "key", factory)` and pass `foo` through the call chain. The helpers in `extension-state.ts` (`getSessionIdSafe`, `getLeafIdSafe`) make the session-key derivation clean.
- **Adding a process-global slot**: add a `let _foo: ... | undefined = undefined;` and a `getFoo()` function in `global-state.ts`. Other files import the getter. Never export the `let` directly.
- **Test-injectable singletons** (e.g., id generators in `lib/utils/id.ts`): use a `set*()` / `reset*()` pair around the `let`. This is a legitimate pattern for test isolation, not stateful data, and is exempt from the rule.

## Verification

- `npm run typecheck` - any new `let` at module scope in `lib/` is suspicious; review the State Policy table.
- `test/runtime/lib/test-enforcement-state-composition.mjs` - state factory contracts.
- The `test-no-module-level-let.mjs` lint test (added in Q15) scans `src/extensions/` and `src/lib/` for new `let` declarations and asserts that the 34 documented exceptions (in the table above) are the only ones.

## Child DOX Index

This directory has no durable sub-boundaries. The 8 files in this table above
are independent utilities, not a hierarchy. The patterns documented here
(parent's State Policy) apply to the entire `src/lib/` tree and to
`src/extensions/`.
