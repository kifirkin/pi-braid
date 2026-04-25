# Extension: evolve

**Status**: ✅ Working
**Tests**: None
**Version**: v0.5.x

## Purpose

Self-evolution — tracks agent health, creates checkpoints, detects degradation, and manages performance metrics. Provides the `evolve` tool for checkpointing and health monitoring.

Integrates `resource-manager` (resource tracking), `time-tracker` (time budgets), and `metacognitive-state` (confidence/knowledge tracking) from `lib/`.

## Events Handled

| Event | Handler |
|-------|---------|
| `session_start` | Reset metrics, load checkpoints |
| `tool_execution_end` | Track error rates and tool success stats |
| `turn_end` | Degradation check — compares metrics against thresholds |
| `session_shutdown` | Save final metrics, create auto-checkpoint |

## Tools

| Tool | Description |
|------|-------------|
| `evolve` | Actions: `status` (view state), `health` (run healthcheck), `check` (degradation check), `commit` (checkpoint), `rollback` (reset metrics), `config` (thresholds), `benchmark` (log results), `reset` (clear metrics) |

## State

Disk-persisted JSON: `~/.pi/agent/evolve/metrics.json`
```typescript
{
  checkpoints: Checkpoint[],
  currentSession: { startTime, toolCalls, errors, avgSuccess },
  thresholds: { healthcheckMinScore, errorRateMax, toolSuccessMin, maxConsecutiveErrors }
}
```

## Key Patterns

- **Library integration**: Uses `resource-manager` for CPU/memory tracking, `time-tracker` for time budgets, `metacognitive-state` for confidence/knowledge gap tracking.
- **Degradation detection**: `check` action compares current metrics against thresholds. If error rate > errorRateMax or tool success < toolSuccessMin, flags degradation.
- **Checkpoint/rollback**: Checkpoints store metric snapshots. Rollback resets current metrics to last checkpoint (forces a fresh start without restart).
