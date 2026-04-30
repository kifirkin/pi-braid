# lib/belief-policy-engine.ts

**Purpose**: Policy engine that evaluates signals from extensions and generates actionable recommendations. Closes the feedback loop between agent behavior and system responses.

## Architecture

Signal-based policy system:

1. Extensions emit signals via `emitSignal(ctx, source, type, severity, isResolved, metadata)`
2. `evaluatePolicies(state)` runs every time a signal is emitted
3. Policy rules match signal patterns → generate `PolicyRecommendation`
4. `getNextRecommendation(ctx)` surfaces one recommendation at a time with cooldown

## Key Functions

| Function                                                        | Description                                          |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| `emitSignal(ctx, source, type, severity, isResolved, metadata)` | Emit a signal from any extension                     |
| `getNextRecommendation(ctx)`                                    | Pop next recommendation (respects cooldown)          |
| `reportRecommendationOutcome(ctx, type, wasEffective)`          | Close the feedback loop — auto-tunes cooldowns       |
| `getSignals(ctx)`                                               | List all signals in current session                  |
| `getBeliefs(ctx)`                                               | List all accumulated beliefs                         |
| `getOutcomes(ctx)`                                              | Get outcome tracking summary per recommendation type |
| `clearBeliefEngine(ctx)`                                        | Reset all state (testing/session reset)              |

## Policy Rules

| Rule                    | Trigger                                    | Recommendation                 |
| ----------------------- | ------------------------------------------ | ------------------------------ |
| `reflection_gap`        | 8+ tool-use signals, no reflection signal  | Suggest pausing to reflect     |
| `stability_decline`     | 3+ consecutive `stability/decline` signals | Suggest re-evaluating approach |
| `conflict_accumulation` | 5+ `conflict/unresolved` signals           | Suggest conflict QA            |
| `drift_plus_scatter`    | topic-drift + 2+ tool overuse signals      | Suggest re-focusing            |

## Outcome Tracking (D0)

When `reportRecommendationOutcome` is called:

- Tracks effective vs ineffective counts per recommendation type
- After 3+ reports: auto-adjusts `recommendationCooldownMs`:
  - > 70% effective → reduce cooldown by 2s (suggest more often)
  - <30% effective → increase cooldown by 5s (suggest less often)
- Range: 10s–120s

## Constants

| Constant                     | Default          | Description                           |
| ---------------------------- | ---------------- | ------------------------------------- |
| `SIGNAL_TTL_MS`              | 600_000 (10 min) | Signal lifetime before auto-reaping   |
| `RECOMMENDATION_COOLDOWN_MS` | 30_000 (30s)     | Base cooldown between recommendations |

## Key Patterns

- **Append-only signals**: Signals accumulate until TTL-expired. No deletions.
- **Dedup on type**: `evaluatePolicies` won't push a recommendation type that's already in the queue.
- **Feedback loop**: Enforcement extension calls `reportRecommendationOutcome` on turn_end using tool call progress as a proxy for effectiveness.
