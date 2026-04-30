# Extension: heartbeat-scheduler

**Status**: ✅ Working
**Tests**: Integration tests in `test/runtime/test-heartbeat.mjs`
**Version**: v0.14.0

## Purpose

Central timing coordinator for TIER 1 infrastructure. Fires cognitive modules on interval, monitors token usage, triggers auto-finalize at 90%, and manages meta-learning via the recaller module.

## Architecture

| Component             | Role                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| **Tick timer**        | Fires cognitive modules at configured interval                            |
| **Cognitive modules** | Individual policy handlers (recaller, dreamer, context-hygiene)           |
| **Token monitor**     | Tracks context usage via `ctx.getContext()`, fires warnings at thresholds |
| **Policy engine**     | Coordinates module firing based on state and thresholds                   |

## Modules

| Module            | Fires At                    | Purpose                                              |
| ----------------- | --------------------------- | ---------------------------------------------------- |
| `recaller`        | Every tick (if data exists) | RUMS-based recall of similar past episodes           |
| `dreamer`         | Every tick                  | Generates implicit plans from recent action patterns |
| `context-hygiene` | 90% context                 | Auto-finalize via sendUserMessage                    |

## Tools (11)

| Tool               | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `timer_set`        | Set a non-blocking timer                                      |
| `timer_list`       | List all active timers                                        |
| `timer_cancel`     | Cancel an active timer                                        |
| `heartbeat_status` | View scheduler status, registered modules, activation history |

Plus 8 implicit scheduling tools for the policy engine.

## Events (5)

| Event                | Handler                                   |
| -------------------- | ----------------------------------------- |
| `session_start`      | Initialize timer, recaller data load      |
| `session_shutdown`   | Cancel all timers, cleanup                |
| `agent_end`          | Record outcome episode, update heuristic  |
| `message_end`        | Check timer state, fire cognitive modules |
| `before_agent_start` | Initialize belief store                   |

## Token Thresholds

| Threshold | Priority | Action                                          |
| --------- | -------- | ----------------------------------------------- |
| 85%       | 3        | Whisper: cognitive load warning                 |
| 90%       | 4        | Whisper + **auto-finalize** via sendUserMessage |
| 95%       | 5        | Whisper: critical overflow warning              |

Auto-finalize sends a `deliverAs:"steer"` message instructing the agent to call `finalize(completed=false, autoProceed=true)`.

## Meta-Learning (Recaller)

Based on paper 2604.14178. RUMS (Ranked Useful Memory Store) algorithm:

1. Encode current task description as vector
2. Score past episodes by Jaccard similarity of task/action token sets
3. Top-K episodes surface similar past work for cross-session learning

Recaller activates on every tick if past episodes exist. Episodes load from `~/.pi/memory/memory.json` on session_start (via three-memory-stores integration).

## State

```typescript
interface HeartbeatState {
  tickIntervalMs: number; // default: 60000 (1 min)
  lastTick: number | null;
  timerIds: string[];
  fired: Set<number>; // which threshold percentages already fired this tick
  cognitiveModules: CognitiveModule[];
  moduleActivationHistory: Record<string, number[]>;
}
```
