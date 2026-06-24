<!-- status: current -->

# src/extensions/enforcement/handlers/analysis/ - Analysis Handlers

Specialized handlers that run as part of the **analysis pipeline** during
turn-end and message-end processing. Distinct from the `register-*` handlers
in the parent `handlers/` directory, which handle the framework-level events.

## Why a subdir?

The parent `handlers/` directory contains 16+ files, mostly `register-*.ts`
files that wire framework events (session_start, session_shutdown, turn_end,
tool_call, etc.) into enforcement logic. These are the "wire-up" handlers.

The `analysis/` subdir contains 6 handlers that implement specific analytical
computations invoked from the analysis pipeline:

| File | Purpose |
|---|---|
| `bpe-handler.ts` | Belief Policy Engine - updates belief states from tool outcomes. |
| `dreamer-handler.ts` | Dreamer - loop prediction via Markov chains. |
| `drift-handler.ts` | Drift - detects when the agent is drifting from the task. |
| `feedback-handler.ts` | Feedback - closed-loop feedback from outcomes. |
| `mars-handler.ts` | MARS - Memory-Augmented Reflection. |
| `reflection-handler.ts` | Reflection - meta-reasoning about the turn. |

## Local Contracts

- These handlers are invoked from `turn-end-handler.ts` (the parent dir's
  main orchestrator) during the analysis phase.
- They are NOT `pi.on(...)` event handlers - they are called directly.
- Each handler is responsible for one analytical concern. They share
  state via `enforcement/session-state.ts` and the per-turn analytics.
- New analytical concerns should be added here, not as new `register-*`
  files in the parent dir.

## Relationship to other subdirs

The `handlers/` directory has only one surviving subdir (`analysis/`).
An earlier `handlers/loop/` was empty and removed (see recent commit).
