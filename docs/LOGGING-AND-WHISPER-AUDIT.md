# Logging and Whisper Delivery Audit

**Date:** 2026-06-15 (revised after user correction)
**Scope:** All `console.*`, `log.*`, `ctx.ui.notify`, `sendTrackedMessage`, and `pi.sendMessage` call sites in `src/`. Plus the fix for the "Branch X entries deep" warning.

## TL;DR — corrected (2026-06-15)

The audience model has **two** consumers, not three:

| Audience | Sees | Delivery channels |
|---|---|---|
| **User** (the human in the TUI) | TUI notifications, persistent UI, in-memory log buffer | `ctx.ui.notify`, `ctx.ui.setStatus`, `ctx.ui.setWidget`, `/logs` retrieval. `console.*` and `log.*` are **suppressed by default** (TUI-safe mode). |
| **Agent** (the LLM in its next turn) | Injected messages, exactly as if the system said them | `sendTrackedMessage` — the only path |

### TUI corruption fix (commit `2bdb000f`)

The user's deeper concern: `console.*` writes from extension handlers corrupt the TUI's cursor positioning. pi is a TUI process; any stdout/stderr write from an event handler runs while the TUI is in an indeterminate render state.

**Fix:** `_consoleMinLevel` defaults to `"none"` (a new sentinel). Nothing writes to console by default. The in-memory buffer is always populated regardless. The `/logs` slash command (in health-maintenance) retrieves the buffer. Subcommands:
- `/logs` — show last 50 entries
- `/logs N` — show last N entries (capped at 500)
- `/logs clear` — clear the buffer
- `/logs level <X>` — set console level for debug (will corrupt TUI)

There is no "operator" persona. The "user" sees everything in their TUI, but the in-memory buffer is the recommended channel for diagnostics. `createLogger` is a thin wrapper that pipes to console when configured; with the new "none" default, the TUI is never corrupted.

The ONLY way to send a message to the agent is `sendTrackedMessage`. The only direct `pi.sendMessage(...)` calls in `src/` are inside `sendTrackedMessage` itself (`src/lib/utils/injection-tracker.ts:278, 285`). All 37 whisper callsites in extensions go through `sendTrackedMessage`. This is the correct architecture.

**Critical messages** (timer fires, post-compaction resume, overflow recovery exhausted) also go through `sendTrackedMessage`. The `bypassFloodCap` option (added in `c3e3d1cb`) is how `sendTrackedMessage` handles "this message must always reach the agent, even if the per-source rate limit is hot." That's the only reason `bypassFloodCap` exists — to prevent a critical message from being silently dropped by the rate cap.

## The bug found and fixed in this audit

**Symptom (user report, 2026-06-15):**
```
11:30:29.999 WARN  [context-manager] Branch 2394 entries deep - consider context_tag + session_compact
```
This appeared as `log.warn` on EVERY turn when branch > 150. After a long session, hundreds of these warnings cluttered the user's scrollback.

**Root cause:** `src/extensions/memory/context-manager/handlers/rotation.ts:113`:
```typescript
if (branch.length > 150) {
  log.warn(`Branch ${branch.length} entries deep - consider context_tag + session_compact`);
}
```

The message contains **actionable advice for the agent** ("consider context_tag + session_compact") but goes to the user via `log.warn`. Two problems:
1. The agent never sees the advice (the agent doesn't read scrollback).
2. The user can't act on it (the user doesn't have the tools — the agent does).

**Fix (commit `979f635d`):** Replaced the per-turn `log.warn` with a throttled `sendTrackedMessage` whisper, using the same `NUDGE_COOLDOWN_TURNS` / `NUDGE_COOLDOWN_MS` gate as the existing rotation nudge:
- Whisper source: `"context-manager/deep-branch"`
- Delivery: `deliverAs: "followUp"`, `triggerTurn: false` (non-urgent, doesn't force a turn)
- Throttle: separate counter `lastDeepBranchWhisperTurn` / `lastDeepBranchWhisperTimestamp` in `RotationState` so a deep branch can fire its own whisper independent of the rotation nudge

The new message is conversational and clearly an *invitation*, not a directive:
> The current branch is N entries deep. Deep branches can slow down context operations. To keep the session manageable: `context_tag` / `context_compress` / `finalize()`. These are non-urgent suggestions — take them when natural in your workflow.

## Architectural rules (corrected)

When adding a new log/notify/whisper:

1. **`ctx.ui.notify(msg, severity)`** — use for user-facing notifications tied to user-initiated actions. The user pressed Enter on a tool; tell them what happened. Severity levels: `info` / `warning` / `error`. The TUI typically shows these as toast notifications or as inline status. **This is the correct native API for user-facing messages.**
2. **`ctx.ui.setStatus(key, text)` / `ctx.ui.setWidget(key, lines)`** — use for persistent state the user should see across renders (footer indicator, content above/below editor). For ongoing operations ("compaction in progress", "X nudges suppressed this session").
3. **`log.*` / in-memory buffer + `/logs`** — use for freeform diagnostics. The buffer is always populated. By default nothing writes to console (TUI-safe). To read the buffer, the user runs `/logs` (or the agent invokes the corresponding tool). Do not put "consider X" / "you should Y" advice here — the agent can't see scrollback.
4. **`console.*`** — **suppressed by default** in third-party extensions. Will corrupt TUI rendering. Use only via `/logs level <X>` for explicit debug sessions.
5. **`sendTrackedMessage`** — the ONLY path for messages the agent will read on its next turn. Use for any actionable advice, nudge, or course correction. Set `bypassFloodCap: true` ONLY for events that are correctness-critical (timer fire wake-ups, post-compaction resume) where dropping the message is a bug.
6. **Never** call `pi.sendMessage` directly. Always go through `sendTrackedMessage` so the per-source rate cap, re-entry depth guard, and tracking markers all work.

## Survey of all `log.warn` / `log.info` in context-manager (audited)

I reviewed all 22 `log.warn` / `log.info` callsites in `src/extensions/memory/context-manager/`. **Only ONE** (`rotation.ts:113`) was an "advice for the agent" pattern. All others are correctly user-facing diagnostics.

| File:line | Message | Notes |
|---|---|---|
| `rotation.ts:113` | "Branch X entries deep - consider X" | **Agent advice** — fixed in `979f635d` |
| `rotation.ts:193` | "Session rotation nudge #N: <reason>" | Action record (user scrollback) |
| `rotation.ts:246` | "Rotation action recorded: <tool> at turn N" | Action record |
| `rotation.ts:276` | "Session rotation triggered at task boundary" | Action record |
| `compaction.ts:334` | "session_before_compact duplicate - skipping" | Internal state |
| `compaction.ts:412` | "failed to emit end-of-turn context signal" | Error escalation |
| `compaction.ts:437` | "failed to emit memory_evict event" | Error escalation |
| `compaction.ts:588` | "Compaction completed successfully" | Action record |
| `shared.ts:315` | "[Emergency] Rotation already pending, skipping duplicate" | Internal state |
| `shared.ts:347` | "[Emergency] Rotation triggered due to context overflow risk" | Action record (escalation) |
| `compaction-retry.ts:44, 134` | "[Critical] Context at X% - triggering emergency rotation" | Critical escalation |
| `compaction-retry.ts:196` | "[Critical] <error message>" | Critical escalation |
| `compaction-retry.ts:242` | "Compaction retry succeeded/failed at attempt N" | Action record |

The `[Critical]` and `[Emergency]` prefixes are intentional — these tell the user "we made an automatic safety decision." The agent doesn't need to act (the system already handled it); the user might want to know about it.

## What `log.*` is for, and when to use `ctx.ui.notify` instead

`log.warn` / `log.error` → in-memory buffer (by default console writes are suppressed). Use `/logs` to retrieve. Best for: "I made a decision the user might want to know about" (action records, escalations, internal state).

`ctx.ui.notify(msg, severity)` → TUI notification, sometimes ephemeral. Best for: "the user invoked a tool and wants to see the outcome" (tool result confirmations).

A reasonable rewrite would migrate "tool result confirmations" from `log.info` to `ctx.ui.notify`. The reverse migration (turning notifications into logs) is rarely correct because the user can't see a `log.info` line as easily as a TUI notification.

The `createLogger` abstraction itself is questionable — the native pi extension model uses `console.log` directly in its examples (see `docs/extensions.md`). Keeping `log.*` as a thin wrapper is fine, but the correct pattern for **new** code is:
- For user-facing information tied to an action: `ctx.ui.notify` directly
- For diagnostics: let them go through `log.*` (in-memory buffer); retrieve with `/logs` when needed
- For persistent state: `ctx.ui.setStatus` / `ctx.ui.setWidget`

## Architecture verification: `pi.sendMessage` direct calls

| File:line | Call | Inside `sendTrackedMessage`? |
|---|---|---|
| `injection-tracker.ts:278` | `pi.sendMessage(params, options)` | ✅ yes (sync path) |
| `injection-tracker.ts:285` | `pi.sendMessage(params, options)` | ✅ yes (async path) |

All other occurrences of `pi.sendMessage` in `src/` are comments or docstrings. The architecture is correct: **every** extension-injected message goes through `sendTrackedMessage`. No extension should call `pi.sendMessage` directly.

## Test coverage

- `test/runtime/lib/test-timer-fire-wake-handling.mjs`: asserts the unified `sendTrackedMessage` + `bypassFloodCap` path.
- `test/runtime/lib/test-promise-allsettled-pattern.mjs`: asserts 0 `Promise.all` over LLM-fanout.
- `test/runtime/lib/test-enforcement-deps.mjs`: enforces dependency contracts.
- **No test yet for the rotation deep-branch whisper specifically** — the source-level audit above is the manual gate. A targeted test can be added if regression risk appears.

## Recommendation: a rule for the codebase

Add to `src/AGENTS.md`:

> **Delivery channel rules**
> - `ctx.ui.notify(...)` — for user-facing notifications tied to user-initiated actions.
> - `console.*` / `log.*` — for freeform diagnostics; do not put "consider X" advice here (the agent can't read scrollback).
> - `sendTrackedMessage(...)` — the ONLY path for messages the agent will read. Use `bypassFloodCap: true` only for correctness-critical wake-ups (timer fires, post-compaction resume).
> - **Never** call `pi.sendMessage` directly outside `src/lib/utils/injection-tracker.ts`.
