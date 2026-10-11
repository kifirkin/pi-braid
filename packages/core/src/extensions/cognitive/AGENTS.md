<!-- status: current -->

# src/extensions/cognitive/ - Cognitive Analysis & Reasoning

The `cognitive` group contains the agent's reasoning tools and the detectors
that produce signals for the enforcement layer. All extensions here analyze
either the agent's own behavior or its outputs.

## Sub-extensions

| Path                   | Role            | Purpose                                                                                                                                    |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `metacognition/`       | tools           | `think`, `hypothesize`, `verify`, `finalize`, `verify_claim` for structured reasoning.                                                     |
| `topic-drift/`         | detector + tool | Detects when the agent drifts from the original task. Exposes `topic_drift` (action=check\|reset) for direct agent use.                    |
| `reasoning/`           | detector        | Runs `measureStability()` on assistant responses; emits `reasoning/unstable` signals on the belief bus.                                    |
| `sycophancy-detector/` | detector        | Detects when the agent is agreeing with the user just to be agreeable.                                                                     |
| `turn-outcome/`        | detector        | Classifies the outcome of each turn (success/partial/failure/loop).                                                                        |
| `mars-reflector/`      | utility         | MARS principle+procedure reflection on task completion. Utility consumed by enforcement/mars-handler. Moved from lib/reasoning/ (July 29). |
| `tool-safety/`         | gate            | Allow-list/deny-list for dangerous tool operations (file mutations, etc).                                                                  |

> **Note:** `metacognition/` was moved here from `core/` so the entire
> reasoning family (think, hypothesize, verify, finalize, verify_claim)
> lives in one place.

## Local Contracts

- Detectors are **read-only** - they analyze events, they don't mutate state.
- Detectors are **stateless across turns** - they read state from `getExtensionState(ctx, ...)`.
- See `extensions/enforcement/handlers/analysis/` for how detectors are wired into the turn pipeline.
