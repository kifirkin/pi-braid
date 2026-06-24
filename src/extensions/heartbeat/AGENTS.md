<!-- status: current -->

# src/extensions/heartbeat/ - Background Daemons

Background services that run continuously during a session. Unlike
cognitive/ detectors (which fire on events), heartbeat services run on
their own schedule.

## Sub-extensions

| Path | Purpose |
|---|---|
| `heartbeat-scheduler/` | The main heartbeat engine. Runs policies on a schedule. Includes modules: `timer-reminder`, `behavioral-drift`, `evolver`, `recaller`, `context-hygiene`, `measurement`, `budget`, `reflection-consolidator`. |
| `analytics/` | Analytics engine. Tracks tool usage, success rates, and produces A/B test variants. |

## Local Contracts

- Heartbeat services are **decoupled from the turn loop** - they run on timers or on `turn_end` events.
- They don't emit whispers directly to the agent. They emit signals that the enforcement layer translates.
- See `extensions/heartbeat/heartbeat-scheduler/policies.ts` for the policy DSL.
- See `extensions/heartbeat/heartbeat-scheduler/modules/` for the built-in policies.

## Abort handling (ESC, session shutdown)

`agent_end` and `tick()` handlers make LLM calls (consolidation scoring,
SOP extraction, optional hint-quality classification). These calls
**MUST honor the session abort signal** so ESC and shutdown propagate.

The contract (verified by `test/runtime/lib/test-classifier-abort-handling.mjs`):

1. `tryModelCall` in `src/lib/ai/text-classifier.ts` threads `ctx.signal`
   through to `callLlm`. When `ctx.signal` is set (agent streaming or
   session signal active), ESC aborts parallel braid LLM calls cleanly.
2. `callLlm` in `src/lib/ai/llm-call.ts` checks `signal?.aborted === true`
   before logging aborts at ERROR level. External aborts (ESC / shutdown)
   log at debug; provider errors and timeouts still log at ERROR.
3. `detectPatternWithLLM` in `src/lib/utils/sop-extractor.ts` checks
   `result.tier === "failed"` from `classify()` and falls back to the
   heuristic `detectPattern(tools)` pattern. Previously "unknown" was
   accepted as a valid label and embedded in the strategic SOP - a real
   regression that surfaced under abort pressure.
4. `detectPatternWithLLM` timeout is 5000ms (was 3000ms). Slow utility
   models + busy session model at session end routinely exceeded 3s.

If you add a new module that calls LLM from a heartbeat context, you
inherit these guarantees automatically via `classify()` / `callLlm()`.
Direct `pi-ai` calls or external HTTP bypass them - prefer the wrapper.
