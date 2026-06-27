<!-- status: forward-looking -->

# Hooks & Whispers Audit — 2026-06-23

> Companion to the session-management enforcement task. Maps every pi
> event subscription, every whisper emission site, and the existing
> analysis primitives. Identifies gaps the new architecture must fill.

## Native pi events consumed by braid

| Event | Subscribers |
|---|---|
| `session_start` | `src/index.ts:71`, `input-polisher`, `timer` |
| `session_shutdown` | `src/index.ts:74`, `analytics`, `heartbeat-scheduler`, `memory-agent-bridge`, `three-memory-stores`, `health-maintenance`, `rotation` |
| `session_before_compact` | `compaction` |
| `session_compact` | `compaction` |
| `session_before_tree` | `navigation` |
| `session_end` | `compaction` |
| `before_agent_start` | `reasoning`, `polyfill`, `prompt-builder`, `context-lifecycle` |
| `agent_start` | `watchdog` |
| `agent_end` | `input-polisher`, `heartbeat-scheduler`, `watchdog`, `three-memory-stores`, `events.ts`, `navigation` |
| `turn_start` | `heartbeat-scheduler` |
| `turn_end` | `analytics`, `heartbeat-scheduler`, `rotation`, `navigation`, `compaction-retry`, `three-memory-stores`, `error-tracking`, `timer`, `enforcement/handler-registry` (8 sub-handlers) |
| `MESSAGE_END` | `reasoning`, `sycophancy-detector`, `agent-environment`, `watchdog`, `register-message-end`, `compaction` (edge-case fallback) |
| `tool_call` | `heartbeat-scheduler`, `context-lifecycle`, `timer` |
| `tool_execution_start` | `analytics` |
| `tool_execution_end` | `metacognition`, `analytics`, `timer` |
| `tool_result` | `heartbeat-scheduler`, `rotation` (×2), `three-memory-stores`, `register-tool-result` |
| `input` | `input-polisher`, `register-input-handler`, `compaction` |
| `context` | `context-manager/handlers/events.ts` |
| `model_select` | `session-recall` |
| `resources_discover` | `prompt-builder` |

**Note:** pi has no dedicated "final_response" event. `agent_end` is the closest analogue (agent returned without tool calls).

## Whisper emission — single trunk

Every whisper, nudge, and system-injected message flows through **one chokepoint**:

```
sendTrackedMessage(pi, params, options, meta)       ← lib/utils/injection-tracker.ts (THE TRUNK)
└── sendEnforcementWhisper(pi, ctx, msg, critical)  ← extensions/enforcement/whisper.ts (advisory wrapper)
    └── ~40+ direct callers                         ← extensions + lib
```

Cross-cutting concerns applied at the trunk (so all sites benefit):

- **Universal envelope** `[braid-whisper · <subsystem>]` — `lib/utils/whisper-format.ts`. Subsystem is the first segment of the source path (e.g. `enforcement/whisper` → `enforcement`).
- **Flood cap** per turn by priority tier — `lib/enforcement/turn-dedup.ts`.
- **Re-entry guard** — `MAX_REENTRY_DEPTH = 1`, defer to `queueMicrotask` beyond.
- **Nudge analytics** — `recordNudgeSent(ctx)`.
- **Cognitive-nudge suppression** — `braid.suppressNudges=true` short-circuits advisory whispers.

Bypassing the trunk (calling `pi.sendMessage` directly) is the documented anti-pattern. Currently zero violations in the source.

## LLM call patterns

| Layer | Function | Where | Notes |
|---|---|---|---|
| Low-level | `callLlm` | `lib/ai/llm-call.ts` | Wraps `pi.getModel()` + `completeSimple` (imported from `@earendil-works/pi-ai/compat` on v0.80+). Abort, retry, structured-output parsing handled internally. |
| Classifier | `classify` | `lib/ai/text-classifier.ts` | Utility-first via `critic-gate`. |
| Post-loop | `postLoopClassify` | `lib/ai/post-loop-classify.ts` | Bundles 4 guarantees: signal thread, abort demotion, 8s timeout, `onFailure` fallback. **Recommended for any post-loop work.** |
| Background judge | verification-judge | `extensions/enforcement/verification-judge.ts` | Asynchronous judge pipeline. |

### `postLoopClassify` adoption status

Defined and tested, but only `dreamer-handler` is confirmed as an early adopter. Other turn_end analysis handlers still call `classify` (or even `callLlm`) directly, missing the four guarantees the wrapper provides.

## Existing analysis primitives

### On `turn_end` (per-turn boundary)
- `extensions/enforcement/handler-registry.ts` → 8 sub-handlers:
  - degradation→checkpoint rollback
  - claim tracker (cross-turn contradiction)
  - spec verification (edited files vs specs)
  - archive ingestion
  - coordinator dispatch
  - individual analysis handlers: `bpe-handler`, `dreamer-handler`, `drift-handler`, `feedback-handler`, `mars-handler`, `reflection-handler`
- `extensions/self/error-tracking/index.ts` — error analytics
- `extensions/heartbeat/analytics/index.ts` — addiction + degradation
- `extensions/heartbeat/heartbeat-scheduler/index.ts` — module scheduling
- `extensions/memory/three-memory-stores/index.ts` — memorize this turn
- `extensions/memory/context-manager/handlers/{rotation,navigation,compaction-retry}.ts`

### On `MESSAGE_END` (per assistant message)
- `extensions/cognitive/sycophancy-detector/index.ts` — VbC
- `extensions/cognitive/reasoning/index.ts` — reasoning quality
- `extensions/core/agent-environment/index.ts` — env tracking
- `extensions/self/watchdog/index.ts` — stuck loop
- `extensions/enforcement/handlers/register-message-end.ts` — verification nudge, contradiction whisper

### On `TOOL_EXECUTION_END` (per tool invocation)
- `extensions/cognitive/metacognition/handlers/{think,hypothesize,verify,claim-verification,finalize}.ts`

### On `agent_end` (final response)
- `extensions/core/input-polisher/index.ts` — end-of-turn reflection
- `extensions/heartbeat/heartbeat-scheduler/index.ts` — module scheduling
- `extensions/self/watchdog/index.ts` — check
- `extensions/memory/three-memory-stores/index.ts` — memorize this turn
- `extensions/memory/context-manager/handlers/events.ts` — retry
- `extensions/memory/context-manager/handlers/navigation.ts`

## Session health state

`src/extensions/enforcement/session-health.ts` — Layer 2 of session-recovery:

- **States:** `healthy` / `degraded` / `balance` / `context_overflow` / `auth` / `aborted`
- **Updates:** `recordLlmError(ctx, err)` / `recordLlmSuccess(ctx)`
- **Transitions:** driven by error category from `lib/errors/llm-error.ts`. Balance/auth don't auto-clear (user must act). Aborted clears on next turn_start. Degraded clears after 10 healthy turns. Context overflow clears after compaction.
- **Layer 3 status: DEFERRED.** The state is populated, but no consumer currently decides "this session is broken, rotate it." This is the gap.

## Rotation vs checkout — mechanisms exist, policy does not

| Mechanism | Where | What it does |
|---|---|---|
| Emergency rotation | `extensions/memory/context-manager/handlers/rotation.ts` | Forces a session split at a turn boundary. |
| `context_navigate` tool | `extensions/memory/context-manager/handlers/tools/context-navigate.ts` | Includes `context_checkout` action (fixed in `9cb12f1b` — no longer corrupts session). |
| Re-entrancy guard | `extensions/memory/context-lifecycle/index.ts:56`, `lib/utils/injection-tracker.ts:47` | Prevents stack overflow from synchronous steer messages during `before_agent_start`. |
| Scratchpad `continue` | `extensions/memory/scratchpad/index.ts` | Resumes from disk-cached scratchpad. |

What's **missing**: a policy that, on the next user input, reads SessionHealthState + analysis history and decides:
- *continue as-is*
- *rotate session* (force fresh session, push continuity via scratchpad/memory)
- *auto-checkout* (tag current context, check out a clean one, continue via scratchpad/memory tools)

## Gaps the enforcement-loop task must fill

1. **No unified analysis dispatch.** Each handler subscribes independently and builds its own context subset. There is no "here is the properly-fed analysis context, all handlers share it" infrastructure.
2. **No analysis persistence.** Analysis results are mostly ephemeral (whispers + transient state). Nothing is written to a per-session store that "what we learned about this session" can be queried from.
3. **No rotate-vs-checkout policy.** Mechanisms exist; the decision logic does not.
4. **Layer 3 of session-recovery unwritten.** The consumer of SessionHealthState that says "this session is broken, do something" is the missing piece.
5. **`postLoopClassify` under-adopted.** Most turn_end handlers bypass the wrapper, leaving the four guarantees unapplied.
6. **pi-ai v0.80 port — minimum-change shipped (P0-8).** `completeSimple` was moved out of the top-level `@earendil-works/pi-ai` export in v0.80.0; it now lives at the `/compat` subpath (`compat.d.ts:64`) as a "Temporary compatibility entrypoint" with identical signature. The forward-looking replacement is `Models.completeSimple()` on a `createModels()` instance (`models.d.ts:82`); that path is a structural refactor (hold a `Models` instance, delegate auth resolution through it) and is deferred to a separate ticket. Current state: `src/lib/ai/llm-call.ts:29` imports from `/compat`; peerDep floor is `>=0.80.0`.

## Cross-reference

- `src/lib/ai/AGENTS.md` — post-loop wrapper contract
- `src/extensions/enforcement/AGENTS.md` — wake-up policy table
- `src/AGENTS.md` — delivery channel rules (user vs agent)
- `docs/ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` — whisper content audit
- `src/lib/utils/whisper-format.ts` — universal envelope design