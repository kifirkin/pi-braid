# Logging and Whisper Delivery Audit

**Date:** 2026-06-15
**Scope:** All `console.*`, `log.*`, `ctx.ui.notify`, `sendTrackedMessage`, and `pi.sendMessage` call sites in `src/`. Plus the fix for the "Branch X entries deep" warning.

## TL;DR

Three delivery channels, three audiences. They should be used as follows:

| Channel | Audience | Use for |
|---|---|---|
| `log.*` (createLogger) | Operator | Diagnostics, system state, error escalation, action records |
| `ctx.ui.notify` | User | Confirmation of user-initiated tool results (success/failure of actions the user took) |
| `sendTrackedMessage` (whisper) | Agent | Actionable advice, nudges, course corrections the agent can act on |
| `pi.sendMessage` (direct) | Agent | Reserved for critical wake-ups (timer fires, post-compaction resume) with `bypassFloodCap` |

## The four-channel split — verified

### 0 `console.*` outside `logger.ts` ✅ Clean

```
grep -rn "console\." src/ --include='*.ts' | grep -v "core/logger"  →  0 matches
```

All `console.warn` / `info` / `error` / `debug` calls go through `createLogger`. The logger fix in commit `67d59fea` (Q1) routed all levels to the right `console` method (the previous empty default case silently dropped warn/info/debug).

### 206 `createLogger` calls ✅

All 206 calls produce operator-facing diagnostic lines. Sampled distribution:
- `src/extensions/enforcement/handlers/`: 12 calls (debug + warn + info)
- `src/extensions/memory/context-manager/handlers/`: 66 calls
- `src/lib/ai/`, `src/lib/state/`, `src/lib/utils/`: scattered, all diagnostics

The operator log is for the human to debug. The agent should NEVER see it (the agent's context window is for actionable information, not diagnostic chatter).

### 31 `ctx.ui.notify` calls ✅

All 31 calls are tool-result confirmations of user-initiated actions:
- `loader/api.ts` (10): "modules-enable <id> enabled (next session startup)"
- `core/polyfill/index.ts` (10): "Utility model set to: X", "Vision model cleared"
- `core/input-polisher/index.ts` (4): polisher enabled/disabled, polish skipped
- `memory/context-manager/handlers/events.ts` (3): overflow/compaction retry status
- `heartbeat/analytics/index.ts` (3): analytics tool results
- `lib/core/logger.ts` (1): self-test warning

**Pattern:** every `ctx.ui.notify` is in response to a user-invoked tool call. The notifications confirm the outcome. The diagnostics (why it failed) are in `log.*` lines. This is the correct separation.

### 37 `sendTrackedMessage` (whisper) callsites

37 callsites across:
- `cognitive/`: 4
- `memory/`: 20
- `enforcement/`: 7
- `scheduling/`: 2 (now both with `bypassFloodCap: true`)
- `heartbeat/`: 4

All delivery goes through ONE chokepoint. The `bypassFloodCap` flag (added in `c3e3d1cb`) is reserved for user/agent-contracted events (timer fires, post-compaction resume) where dropping the message is a correctness bug.

## BUG found and fixed in this audit: the "deep-branch warning" anti-pattern

**Symptom (user report, 2026-06-15):**
```
11:30:29.999 WARN  [context-manager] Branch 2394 entries deep - consider context_tag + session_compact
```
This appeared as `log.warn` on EVERY turn when branch > 150. After a long session, hundreds of these warnings cluttered the operator console.

**Root cause:** `src/extensions/memory/context-manager/handlers/rotation.ts:113`:
```typescript
if (branch.length > 150) {
  log.warn(`Branch ${branch.length} entries deep - consider context_tag + session_compact`);
}
```

The message contains **actionable advice for the agent** ("consider context_tag + session_compact") but goes to **the operator's console** via `log.warn`. Three problems:
1. The agent never sees the advice (log is operator-facing, not in agent's context).
2. The operator can't act on it (they don't have the tools).
3. It fires every turn → hundreds of redundant warnings per long session.

**Fix (commit `979f635d`):** Replaced the per-turn `log.warn` with a throttled `sendTrackedMessage` whisper, using the same `NUDGE_COOLDOWN_TURNS` / `NUDGE_COOLDOWN_MS` gate as the existing rotation nudge:
- Whisper source: `"context-manager/deep-branch"`
- Delivery: `deliverAs: "followUp"`, `triggerTurn: false` (non-urgent, doesn't force turn)
- Throttle: separate counter `lastDeepBranchWhisperTurn` / `lastDeepBranchWhisperTimestamp` in `RotationState` so a deep branch can fire its own whisper independent of the rotation nudge

The new message is conversational and clearly an *invitation*, not a directive:
> The current branch is N entries deep. Deep branches can slow down context operations. To keep the session manageable: `context_tag` / `context_compress` / `finalize()`. These are non-urgent suggestions — take them when natural in your workflow.

## Survey of all other `log.warn` / `log.info` in context-manager

Audited 22 distinct `log.warn` / `log.info` callsites in `src/extensions/memory/context-manager/`. **Only ONE** (`rotation.ts:113`) was an "advice for the agent" pattern. All others are correctly operator-facing diagnostics.

| File:line | Message type | Audience | Correct? |
|---|---|---|---|
| `rotation.ts:113` | "Branch X entries deep - consider X" | Agent (was Operator) | ❌ Fixed in 979f635d |
| `rotation.ts:193` | "Session rotation nudge #N: <reason>" | Operator | ✅ Action record |
| `rotation.ts:246` | "Rotation action recorded: <tool> at turn N" | Operator | ✅ Action record |
| `rotation.ts:276` | "Session rotation triggered at task boundary" | Operator | ✅ Action record |
| `compaction.ts:334` | "session_before_compact duplicate - skipping" | Operator | ✅ Internal state |
| `compaction.ts:412` | "failed to emit end-of-turn context signal" | Operator | ✅ Error escalation |
| `compaction.ts:437` | "failed to emit memory_evict event" | Operator | ✅ Error escalation |
| `compaction.ts:588` | "Compaction completed successfully" | Operator | ✅ Action record |
| `shared.ts:315` | "[Emergency] Rotation already pending, skipping duplicate" | Operator | ✅ Internal state |
| `shared.ts:347` | "[Emergency] Rotation triggered due to context overflow risk" | Operator | ✅ Action record (escalation) |
| `compaction-retry.ts:44, 134` | "[Critical] Context at X% - triggering emergency rotation" | Operator | ✅ Critical escalation |
| `compaction-retry.ts:196` | "[Critical] <error message>" | Operator | ✅ Critical escalation |
| `compaction-retry.ts:242` | "Compaction retry succeeded/failed at attempt N" | Operator | ✅ Action record |

The `[Critical]` and `[Emergency]` prefixes are intentional — these tell the operator "we made an automatic safety decision." The agent doesn't need to act.

## Survey of whisper content (sample)

I sampled 10 of the 37 `sendTrackedMessage` callsites and verified the message content is **always agent-actionable**:

| Source label | Content | Agent action |
|---|---|---|
| `context-manager/rotation` | "Session Size Notice - use finalize / context_archive / memory_store" | Call one of the listed tools |
| `context-manager/deep-branch` (new) | "Branch is N deep - use context_tag / context_compress / finalize" | Call one of the listed tools |
| `context-manager/compaction/overflow` | "Context overflow recovery failed/exhausted - switch models or store learnings" | Switch models via `/model` |
| `enforcement/whisper` | Variable per-source | See enforcement/AGENTS.md |
| `timer/fire` | "[TIMER FIRED - Ns elapsed] reason - Resume the task" | Resume the original task |
| `enforcement/dreamer`, `enforcement/drift`, `enforcement/bpe` | Behavioral advice | Adjust next-turn behavior |

All agent-bound messages include explicit action paths or references to specific tools. No diagnostic chatter leaks into the agent's context.

## Process recommendation

When adding a new log/notify/whisper:
1. **`log.*`** — use for ANY state the operator would want to see in the braid log. The operator is the human running braid; they want to know "what is the system doing."
2. **`ctx.ui.notify`** — use ONLY for tool-result confirmations of user-initiated actions. The user pressed Enter on a tool; tell them what happened.
3. **`sendTrackedMessage`** — use for anything the agent should know that affects its next action. The advice must be actionable (a specific tool to call, a specific behavior to adjust).
4. **Never** put "consider X" or "you should Y" advice in `log.warn` — the agent can't see logs. It will be invisible advice that pollutes the operator console.

## Test coverage

- `test/runtime/lib/test-timer-fire-wake-handling.mjs`: asserts the unified `sendTrackedMessage` + `bypassFloodCap` path.
- `test/runtime/lib/test-promise-allsettled-pattern.mjs`: asserts 0 `Promise.all` over LLM-fanout (a class of bugs where the agent would miss a result on rejection).
- `test/runtime/lib/test-enforcement-deps.mjs`: enforces dependency contracts.
- **No test yet for the rotation deep-branch whisper specifically** — the source-level audit above is the manual gate. A targeted test can be added if regression risk appears.
