# src/extensions/cognitive/ — Cognitive Detectors

Detectors that run in the background to identify patterns in the agent's
behavior. Each detector returns a signal; the enforcement layer translates
signals into whispers.

## Sub-extensions

| Path | Purpose |
|---|---|
| `topic-drift/` | Detects when the agent drifts away from the original task. |
| `sycophancy-detector/` | Detects when the agent is agreeing with the user just to be agreeable. |
| `tool-safety/` | Allow-list/deny-list for dangerous tool operations (e.g., file mutations). |
| `reasoning/` | Analyzes the agent's reasoning quality. |
| `turn-outcome/` | Classifies the outcome of each turn (success/partial/failure/loop). |
| `verification/` | Runs verification queries on the agent's claims. Provides `verify_claim` and `verify_decomposition` tools. |

## Local Contracts

- Detectors are **read-only** — they analyze events, they don't mutate state.
- Detectors are **stateless across turns** — they read state from `getExtensionState(ctx, ...)`.
- See `extensions/enforcement/handlers/analysis/` for how detectors are wired into the turn pipeline.
