# Extension: planner

**Status**: ✅ Working (fixed content bug Apr 24)
**Tests**: None (implicit via usage)
**Version**: v0.13.0

## Purpose

Budget-aware planning tool. Estimates task cost before starting and tracks progress via checkpoints. Part of TIER 1 infrastructure.

## Tools (8)

| Tool               | Description                                  |
| ------------------ | -------------------------------------------- |
| `plan_with_budget` | Plan task with phases, estimate calls/tokens |
| `check_budget`     | Show current budget usage                    |
| `set_budget`       | Set/modify budget, optionally reset          |

Plus 5 implicit planning tools (analyze, implement, verify, review, document).

## Budget Model

| Tool               | Estimated Cost |
| ------------------ | -------------- |
| `bash`             | 3 calls        |
| `repl`             | 5 calls        |
| `read`             | 1 call         |
| `grep/find`        | 1 call         |
| `write/edit`       | 3 calls        |
| `think`            | 2 calls        |
| `web_fetch`        | 5 calls        |
| `browser_navigate` | 4 calls        |
| Default            | 2 calls        |

Task cost heuristic: `phases × 8 + words`, where `phases = min(5, max(1, words/10))`.

## State

```typescript
interface BudgetState {
  budget: number; // default: 50
  spent: number; // cumulative tool calls
  checkpoints: BudgetCheckpoint[];
  warnings: string[];
}
```

## Notes

- `plan_with_budget` was returning plain strings (v0.13.0 bug) — fixed to `[{type:"text",text}]` format.
- Checkpoints can be named for mid-task progress verification.
- Warning thresholds at 80% (warning) and 100% (over-budget).
