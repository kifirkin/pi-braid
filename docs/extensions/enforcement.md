# Extension: enforcement

**Status**: ✅ Working
**Tests**: 29 enforcement tests (v0.2.6)
**Version**: v0.2.6

## Purpose

Turn validation, tool tracking, and heuristic advice. Delivers hints/warnings/feedback to the agent via three-tier signal architecture. Entry point for Dreamer/MARS advice systems.

## Signal Architecture (L1-L3)

| Tier | Type             | Delivery                    | Example                                  |
| ---- | ---------------- | --------------------------- | ---------------------------------------- |
| L1   | Internal         | State only (no message)     | Tool usage tracking, context hygiene     |
| L2   | Structured hints | Session Signals nudge/turn  | Redundancy, verification hints           |
| L3   | Critical         | Individual semantic message | Overflow failures, infrastructure errors |

**Key rule**: Agent gets ONE [enforcement] message per turn max for non-critical signals. Critical signals (L3) get individual messages.

## Modules

| Module                         | Purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `handler-registry.ts`          | All pi.on() registrations, coordinator dispatch    |
| `handlers/blocking.ts`         | Block dangerous commands                           |
| `handlers/tool-tracker.ts`     | Track bash commands, tool inputs                   |
| `handlers/message-analysis.ts` | Analyze message structure                          |
| `handlers/turn-analysis.ts`    | Detect redundancy, critical signals, orphan chains |
| `handlers/orphan-chains.ts`    | Detect orphan tool call chains                     |
| `handlers/turn-end-handler.ts` | Main enforcement loop (error bursts, context, L2)  |
| `verification-judge.ts`        | LLM-based work quality audit                       |
| `whisper.ts`                   | Message delivery via sendTrackedMessage            |
| `validation.ts`                | Turn and tool validation                           |
| `state.ts`                     | Composed state (7 sub-states)                      |
| `types.ts`                     | Shared types                                       |
| `signals.ts`                   | Contrast mode detection                            |
| `similarity.ts`                | Text similarity (redundancy detection)             |
| `session-state.ts`             | Session turn tracking                              |
| `tool-tracking-state.ts`       | Tool usage + calibration                           |
| `error-tracking-state.ts`      | Error bursts + validation failures                 |
| `memory-hygiene-state.ts`      | Memory tool nudges                                 |
| `scratchpad-state.ts`          | Scratchpad nudges                                  |
| `context-hygiene-state.ts`     | Context usage + overflow                           |
| `thought-chain-state.ts`       | think() tracking + reflection gaps                 |
| `verification-judge-state.ts`  | Judge/calibration state                            |

## Events Handled (via handler-registry.ts)

| Event                      | Handler                        |
| -------------------------- | ------------------------------ |
| `input`                    | Language detection             |
| `session_start`            | Drift detector init            |
| `tool_call`                | Tool tracking + blocking       |
| `message_end`              | Conflict + analysis + judge    |
| `tool_result`              | Calibration                    |
| `turn_end`                 | Coordinator dispatch (4 handlers) |
| `session_compact`          | Hygiene reset + learnings      |
| `auto_retry_end`           | Error classification           |
| `session_shutdown`         | State reset                    |

## Key Features

- **turn_end coordinator**: 4 registered sub-handlers (analysis, loop, claim-tracker, MARS/Dreamer)
- **Advice tracker**: Dreamer/MARS predictions evaluated after 10 turns; thresholds adjust dynamically
- **Claim tracker**: Registered as separate handler via coordinator (extracted from enforcement-loop)
- **Evidence pool integration**: Conflicts from code/command changes tracked via `addEvidence`
- **Belief policy engine**: Emits structured enforcement signals via `emitSignal`
- **Language hints**: Supports multilingual agents with `language-hint.ts` lib

## State

Composed from 7 focused sub-state interfaces via spread composition:
- ToolTrackingState (tool usage, calibration)
- ErrorTrackingState (error bursts, cooldowns)
- SessionState (turn tracking, drift detector)
- MemoryHygieneState (memory tool nudges)
- ScratchpadState (scratchpad nudges)
- ContextHygieneState (context usage, overflow)
- ThoughtChainState (think() tracking, reflection gaps)

## Tools

No tools registered directly — enforces via events and coordinator-registered turn_end handlers.
