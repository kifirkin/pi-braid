# lib/mars-reflector.ts

**Purpose**: MARS (Metacognitive Reflection) — self-reflection engine that analyzes tool-use patterns and generates structured advice when the agent goes off-track.

## Architecture

Two-phase operation:
1. `buildPattern(ctx)` — reads enforcement state to build a `SessionPattern` snapshot
2. `generateAdvice(current, prev?, successRates?)` — compares patterns and generates advice

## Key Functions

| Function | Description |
|----------|-------------|
| `buildPattern(ctx)` | Build `SessionPattern` from enforcement state (tool distribution, error types, consecutive errors, confidence/stability trends) |
| `generateAdvice(current, prev?, successRates?)` | Compare patterns → advice. Returns `MARSAdvice` or `null` |
| `getState(ctx)` | Access MARS session state (pattern snapshot, last advice timestamp) |

## SessionPattern

```typescript
{
  toolDistribution: Map<string, number>,  // tool call counts
  errorTypes: Map<string, number>,        // error type frequencies
  confidenceTrend: number[],              // rolling confidence values
  stabilityTrend: number[],               // rolling stability values
  errorRate: number,                      // fraction of tool calls that errored
  consecutiveErrors: number,              // current streak
}
```

## Advice Types

| Type | Trigger | Severity |
|------|---------|----------|
| `tool_overuse` | Tool count > `avgPerTool * OVERUSE_MULTIPLIER(3)` AND success rate < `0.5` | warn |
| `error_recurrence` | `consecutiveErrors >= 3` | warn |
| `stability_decline` | Current stability trend significantly below previous | info |

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `LEARNING_PHASE_CALLS` | 5 | Tool calls below this are not flagged |
| `OVERUSE_MULTIPLIER` | 3 | Threshold = `avgPerTool * 3` |
| `MIN_SUCCESS_RATE_FOR_OVERUSE` | 0.5 | Only flag if tool is failing |
| `ADVICE_COOLDOWN_MS` | 60_000 | Max 1 advice per minute |

## Key Patterns

- **State-driven**: Reads enforcement toolLog for raw data, but maintains its own session state (patternSnapshot, lastAdviceAt) to avoid double-firing.
- **Conservative by design**: Only flags tools that are BOTH overused AND failing. Successful tools (high success rate) are never flagged even if overused.
- **Learning phase exemption**: First 5 calls of any tool are never flagged as overuse — it assumes the agent is learning.
