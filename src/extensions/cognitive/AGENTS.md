# src/extensions/cognitive/ — Cognitive Analysis Tools

The `cognitive` group is a mixed bag: some sub-extensions are **detectors**
that return signals the enforcement layer turns into whispers, and some are
**LLM-callable analysis tools** the agent can invoke directly. All of them
analyze either the agent's own behavior or its outputs.

## Sub-extensions

| Path | Role | Purpose |
|---|---|---|
| `topic-drift/` | detector + tools | Detects when the agent drifts away from the original task. Also exposes `check_topic_drift` / `reset_topic_anchors` for direct agent use. |
| `reasoning/` | detector | Runs `measureStability()` on assistant responses, emits `reasoning/unstable` signals on the belief bus when stability degrades, and nudges the agent to `verify()` before finalizing. Exposes `getReasoningStateView` for analytics. |
| `sycophancy-detector/` | detector | Detects when the agent is agreeing with the user just to be agreeable. |
| `turn-outcome/` | detector | Classifies the outcome of each turn (success/partial/failure/loop). |
| `tool-safety/` | gate | Allow-list/deny-list for dangerous tool operations (e.g., file mutations). |

> **Note:** The `verify_claim` and `verify_decomposition` tools were moved from
> `cognitive/verification/` into `core/metacognition/handlers/claim-verification.ts`
> so the entire verify family (`verify`, `verify_claim`, `verify_decomposition`)
> lives under one roof.

## Local Contracts

- Detectors are **read-only** — they analyze events, they don't mutate state.
- Detectors are **stateless across turns** — they read state from `getExtensionState(ctx, ...)`.
- See `extensions/enforcement/handlers/analysis/` for how detectors are wired into the turn pipeline.
