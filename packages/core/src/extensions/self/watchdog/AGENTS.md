<!-- status: current -->

# src/extensions/watchdog/ - Session Health Monitor and Escalation Engine

A **background monitor** with two layers: a passive per-session observer
(uptime, idle time, message count, surfaced via the `watchdog-status` TUI
command) and an active engine that detects stall/quota/tunnel/dead-wake
conditions with no model call and escalates them.

## Files

| File        | Purpose                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `index.ts`  | Extension surface: per-session state, whisper/tg delivery, engine wiring, turn-progress feeds, session shutdown.       |
| `engine.ts` | The state machine: condition latches, milestone ladders, escalation budget, stall classification, wake-delivery feed.  |
| `config.ts` | `broker.watchdog` reader (mode, cadences, thresholds). Defaults live in `engine.ts`; invalid fields fall back to them. |

## Local Contracts

- Default-ON (`manifest.ts` declares no `disabledByDefault`), module id `watchdog`, dependency `agent-environment`.
- Not LLM-callable: the agent cannot trigger it.
- `broker.watchdog` is read when the extension factory loads. Restart the agent after changing it.

## Escalation delivery

`fireEscalation` is the one escalation action: a whisper plus an optional
one-line tg signal. The whisper's delivery class follows the session's
route-failure latch (`isRouteLatchOpen` from the enforcement health module,
read once per bark, fail-open):

- latch closed: `wakeWhisper` (`triggerTurn: true`) - the bark wakes the agent;
- latch open: `quietWhisper` - the same text reaches the session on the next
  turn, and the tg line still fires, because the page costs no provider call
  and the turn the bark would have started is the call the latch exists to
  save.

The route-failure latch and its settings are documented in
`extensions/enforcement/AGENTS.md`; fixture:
`test/runtime/lib/test-route-latch.mjs`.

## Fixtures

- `test/runtime/self/test-watchdog-engine.mjs` - condition latches, ladders, budget.
- `test/runtime/self/test-watchdog-stall-ladder.mjs` - stall classification and remediation.
- `test/runtime/self/test-watchdog-wake-delivery.mjs` - the timer-to-watchdog dead-wake feed.
- `test/runtime/self/test-watchdog-unknown-failure-ring.mjs` - unclassified-failure retention.
