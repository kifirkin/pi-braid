# Whisper Delivery & Logging Audit

**Date:** 2026-06-15
**Scope:** All `sendTrackedMessage`, `pi.sendMessage`, `console.*`, `ctx.ui.notify`, and `createLogger` call sites in `src/`.

## Summary

| Mechanism | Count | Purpose | Verdict |
|---|---|---|---|
| `sendTrackedMessage` | 37 callsites | Tracked whisper injection with flood-cap + re-entry guard | ✅ Correct pattern |
| `pi.sendMessage` direct | 2 callsites (both inside `sendTrackedMessage` itself) | Internal to flood-cap-deferred path | ✅ Correct |
| `console.*` outside `logger.ts` | 0 | — | ✅ Clean |
| `ctx.ui.notify` | 31 callsites | User-facing transient notifications | ✅ Correct pattern |
| `createLogger` | 206 callsites | Per-subsystem diagnostic logging | ✅ Correct pattern |

**No logging anti-patterns found.** All subsystems use `createLogger("name")` for diagnostics and `ctx.ui.notify` for user-facing popups. No raw `console.*` calls leak outside the central logger.

## Logging audit findings

### `console.*` outside `lib/core/logger.ts`
**Zero.** Grep result: `grep -rn "console\." src/ --include='*.ts' | grep -v "core/logger"` returns no matches. All `console.warn`/`info`/`error`/`debug` calls go through `createLogger`. The logger fix in commit `67d59fea` (Q1) routed all levels to the right `console` method (the previous empty default case silently dropped warn/info/debug).

### `ctx.ui.notify` patterns (31 callsites)

All 31 are **legitimate user-facing notifications**, not diagnostic logging:

| Source | Count | Pattern |
|---|---|---|
| `src/loader/api.ts` | 10 | `modules-enable <id>` / `modules-disable <id>` feedback (e.g. "X enabled (next session startup)") |
| `src/extensions/core/polyfill/index.ts` | 10 | Utility/vision model set/cleared, model not found |
| `src/extensions/core/input-polisher/index.ts` | 4 | Polishing error, "text was not modified" hint, enable/disable confirmation |
| `src/extensions/memory/context-manager/handlers/events.ts` | 3 | Overflow/compaction retry success/failure |
| `src/extensions/heartbeat/analytics/index.ts` | 3 | Analytics tool results (format-current-session, format-all-sessions, format-ab-results) |
| `src/lib/core/logger.ts` | 1 | Self-test warning |

**Pattern check:** Every `ctx.ui.notify` is in response to a user-initiated tool call (the user invoked `modules-enable`, the user invoked `input_polisher_set`, the user invoked `session_analytics`). The notifications are confirmation of the action's outcome. The diagnostics (why it failed, what was rejected) are in `createLogger` log lines. **This is the correct separation.**

## Whisper inventory (37 callsites)

### Delivery mechanism classification

| Extension | Callsites | Mechanism | Notes |
|---|---|---|---|
| `cognitive/` | 4 | `sendTrackedMessage` | hints, turn-outcome, openspec, metacognition — all go through tracker |
| `memory/` | 20 | `sendTrackedMessage` | context-manager (compaction-retry 7, rotation 2, navigation, shared, events), context-lifecycle (3), three-memory-stores (3), session-recall, past-insights |
| `enforcement/` | 7 | `sendTrackedMessage` | BPE, dreamer, drift, etc. — all go through tracker |
| `scheduling/` | 2 (now) | `sendTrackedMessage` with `bypassFloodCap: true` | timer wake:true + wake:false (the bug fix) |
| `heartbeat/` | 4 | `sendTrackedMessage` | analytics + heartbeat reminders |
| `lib/` | 2 | `sendTrackedMessage` (the helper itself) | shared utility |

**All 37 callsites use `sendTrackedMessage`.** Direct `pi.sendMessage` is only called inside `sendTrackedMessage` itself (the flood-cap-deferred microtask path, lines 278 and 285 of `injection-tracker.ts`).

### Source label distribution (priority)

`priorityFromSource` in `injection-tracker.ts:174` maps each source to a priority:

```
critical: auto-recovery, turn-outcome/loop, timer/fire
high:     enforcement/whisper, exhausted, compaction-retry, context-manager/rotation, triggerTurn:true
medium:   analytics, navigation, context-full, register-session-start
low:      everything else (hints, suggestions, drift, dreamer)
```

The flood cap (`WHISPER_CAPS`) is `critical=5, high=3, medium=2, low=1` per turn, combined from all sources. Per-source cap is 2. Critical bypasses the per-priority cap but is still subject to per-source cap.

## Bug discovered: silent drop of timer fires

**Root cause:** `sendTrackedMessage` applies a per-source flood cap of 2 per turn. A timer fire is mapped to `critical` priority (bypasses the per-priority cap), but if 2 timer fires already happened in the same turn, the 3rd is dropped at `tryWhisper` and only logged at `log.debug` (not visible to the user).

**User-visible symptom:** User reports "timer_set sometimes doesn't fire." Most common trigger: 2+ timer fires in a single turn (e.g., compaction-reuse timer fires, then a user-scheduled timer fires, then the agent schedules another timer that also fires — the 3rd is dropped).

**Proper fix shipped (commit `c3e3d1cb`):** Both timer fire branches (wake:true and wake:false) now go through `sendTrackedMessage` with `{ bypassFloodCap: true }` as a 5th argument. The bypass is reserved for user/agent-contracted events (timer fires, post-compaction resume, hard errors). The flood cap still applies to all other system whispers.

**Architectural improvement over the previous workaround:** The previous "fix" was to bypass `sendTrackedMessage` entirely in the wake:true branch and call `pi.sendMessage` directly. That lost observability (no `trackInjection`), lost the re-entry guard, and created two code paths. The new architecture unifies into one path with an explicit bypass flag.

## Other findings

### `pi.sendMessage` direct callsites: 2

Both are inside `sendTrackedMessage` itself (`injection-tracker.ts:278` and `:285`):
- `:278` is the `queueMicrotask` deferral path (when `_sendDepth >= MAX_REENTRY_DEPTH`)
- `:285` is the normal synchronous path

These are intentional — the re-entry guard defers to microtask to break the synchronous `pi.sendMessage → before_agent_start → sendTrackedMessage` loop. No external direct calls remain.

### Re-entry guard observation

`_sendDepth` is process-global (per the file's header), not per-session. In pi's single-session-per-process model this is equivalent to per-session, but the comment at line 47-50 documents this as intentional. No fix needed.

### `trackInjection` call shape

Every `sendTrackedMessage` caller passes a `{ type, source }` injectionMeta. The source is what `priorityFromSource` keys on. Mislabeling the source (e.g., calling it "enforcement/whisper" when it's actually a heart-beat) would cause it to be categorized as high priority and subject to WHISPER_CAPS.high=3. Future improvement: a static set of valid source labels, validated at compile time. Deferred (out of scope for this audit).

## Architectural recommendations

1. **No changes needed for the logging patterns.** All subsystems follow the right pattern.
2. **No changes needed for `ctx.ui.notify`.** All 31 calls are user-facing notifications of tool results.
3. **Ship the timer fix** (commit `c3e3d1cb`).
4. **Document the bypassFloodCap contract.** This is now in the JSDoc of `sendTrackedMessage` and the test `test-timer-fire-wake-handling.mjs` pins the architecture.
5. **Consider (deferred):** Make source labels a typed enum so mislabeling fails at compile time.
6. **Consider (deferred):** Add a `bypassReentry` flag if any future caller needs to bypass the re-entry guard (currently no caller needs this — timer fires don't re-enter because they fire outside agent turns).

## Test coverage

| Test | Asserts |
|---|---|
| `test-timer-fire-suppression.mjs` | Layer 1 priority mapping + per-turn cap behavior |
| `test-timer-fire-wake-handling.mjs` | Unified `sendTrackedMessage` path with `bypassFloodCap: true` for both branches |
| `test-promise-allsettled-pattern.mjs` | LLM-fanout sites use `allSettled`, not `all` |

The timer wake-handling test rewrote the previous "wake:true uses pi.sendMessage direct" assertions to assert the new architecture. The architecture-level test pins the contract: both branches go through `sendTrackedMessage`, both pass `bypassFloodCap: true`, distinct customTypes preserved.
