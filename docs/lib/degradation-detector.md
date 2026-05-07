# lib/degradation-detector.ts

**Purpose**: Tracks performance metrics across sessions and detects degradation trends. Writes to `~/.pi/agent/evolve/metrics.json`.

## Key Functions

| Function                                              | Description                               |
| ----------------------------------------------------- | ----------------------------------------- |
| `recordMetric(ctx, category, name, value, metadata?)` | Record a single metric point              |
| `checkDegradation(ctx)`                               | Run degradation checks against thresholds |
| `getDegradationReport(ctx)`                           | Get structured degradation analysis       |
| `getPerformanceSummary(ctx)`                          | Get session-level performance summary     |

## Degradation Signals

| Signal                 | Threshold                         | Trigger                    |
| ---------------------- | --------------------------------- | -------------------------- |
| Error rate increase    | >30% increase over rolling window | Multiple tool failures     |
| Success rate decline   | <70% success over last 10 calls   | Tools failing consistently |
| Consecutive errors     | ≥5 consecutive tool errors        | Tool in broken state       |
| Response time increase | >2x baseline over 5 calls         | System slowdown            |

## Key Patterns

- **Rolling windows**: All metrics computed over sliding windows (last 10/20/50 calls) — no unbounded accumulation.
- **File persistence**: Metrics are appended to a JSON file on disk. Each session loads previous metrics for baseline comparison.
- **Conservative thresholds**: Degradation only fires when metrics cross clear thresholds — avoids false positives.
- **Integration**: Used by `evolve` extension's `check` command for agent health monitoring.
