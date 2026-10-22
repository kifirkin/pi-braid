<!-- status: current -->

# src/lib/events/ - Event Infrastructure

Internal event bus and channel infrastructure. Used for cross-extension
communication that doesn't fit pi core's event model.

## Files

| File                       | Purpose                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event-bus.ts`             | Process-global event bus (`eventBus.on/off/emit`). 9 typed event types: `timer_fire`, `memory_evict`, `turn_complete`, `context_full`, `enforcement_violation`, `heartbeat_tick`, `tool_error`, `analytics_alert`, `sop_suggestion`, `enforcement_signals`. Use for cross-cutting events that span multiple extensions. |
| `event-types.ts`           | Type definitions for events on the bus.                                                                                                                                                                                                                                                                                 |
| `consolidation-channel.ts` | The channel between enforcement and consolidation logic. Carries "things that should be remembered".                                                                                                                                                                                                                    |
| `timer-bus.ts`             | Channel for timer-related cross-extension communication.                                                                                                                                                                                                                                                                |
| `timer-types.ts`           | Type definitions for timer events.                                                                                                                                                                                                                                                                                      |
| `turn-end-coordinator.ts`  | Coordinates handlers that need to run at turn end (post-message-end). Provides ordering and dedup.                                                                                                                                                                                                                      |
| `turn-boundary.ts`         | The one rule for which `turn_end` boundaries a deferred compaction may abort a run at (allow-list over `message.stopReason`, fail-closed on unreadable boundaries). Shared by the context_compress drain and the enforcement hygiene act.                                                                               |

## Local Contracts

- **Use pi core's `pi.on()` for pi events.** Use the event-bus only for internal braid events.
- Don't use the event-bus to send messages to the agent. Use `sendTrackedMessage` for that.
- The `event-bus` is process-global. Be careful with subscriptions in long-lived contexts.
