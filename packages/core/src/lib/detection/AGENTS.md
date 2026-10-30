<!-- status: current -->

# src/lib/detection/ - Detection Primitives

Pure-logic detectors used by extensions to identify patterns.

## Files

| File                      | Purpose                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-loop-detector.ts`   | The one tool-loop detector: is the agent repeating one call? Identity is tool + arguments, so a chain of distinct commands under one tool name is not a loop. Used by `enforcement/`. |
| `degradation-detector.ts` | Tracks analytics metrics and detects degradation (e.g., declining tool-success rate).                                                                                                 |
| `topic-drift-detector.ts` | Determines whether the current turn is drifting away from the original task. Used by `enforcement/`.                                                                                  |
| `context-density.ts`      | Estimates how "dense" the context is (tokens per turn). Used to predict overflow.                                                                                                     |
| `context-thresholds.ts`   | Threshold constants and helpers for "context full" signals.                                                                                                                           |
| `compression-strategy.ts` | Decides which compaction strategy to use when context is full.                                                                                                                        |

## Local Contracts

- All detectors are **pure** - they take state in, return signal out. No side effects.
- Detectors don't emit whispers. They return a signal that handlers in `extensions/` translate into whispers.
- Detectors should be testable in isolation (no pi core dependency).
