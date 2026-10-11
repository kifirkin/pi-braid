<!-- status: current -->

# src/lib/reasoning/ - Reasoning Engines

Pure reasoning modules used by the enforcement layer and reasoning
extensions.

## Files

| File                      | Purpose                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dreamer.ts`              | Loop prediction - uses Markov chains to predict whether the agent is stuck. Min sample size 5; current-sequence loop detection.                             |
| `belief-policy-engine.ts` | Updates belief states and chooses policy actions based on evidence.                                                                                         |
| `tool-usage-analyzer.ts`  | Tool usage frequency analyzer (formerly mars-reflector). Statistical thresholding for overuse/error/stability patterns.                                     |
| ~~`mars-reflector.ts`~~   | MOVED to `extensions/cognitive/mars-reflector/` - MARS reflection is an extension concern (writes to three-memory-stores, reads heartbeat-scheduler state). |
| `reasoning-summary.ts`    | Summarizes the agent's reasoning for memory consolidation.                                                                                                  |
| `reasoning-metrics.ts`    | Metrics about reasoning quality.                                                                                                                            |
| `advice-tracker.ts`       | Tracks the history of advice/nudges given to the agent.                                                                                                     |
| `nudge-analytics.ts`      | Analytics on which nudges the agent acts on.                                                                                                                |

## Local Contracts

- All reasoning modules are **pure** - input state in, output signal/decision out. No side effects.
- Reasoning modules don't emit whispers. They return signals that the enforcement layer translates.
- `dreamer.ts` has a minimum sample size guard - never predict on fewer than 5 observations.
