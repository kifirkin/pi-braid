# lib/topic-drift-detector.ts

**Purpose**: Detects when the conversation has drifted from its original task context. Uses a "whisper" pattern — non-intrusive hints rather than blocking.

## Drift Detection Triggers

| Trigger             | Description                                   |
| ------------------- | --------------------------------------------- |
| Semantic mismatch   | Conversation topics diverge from task context |
| Structural mismatch | User asks about unrelated content             |
| Tool usage drift    | Agent uses tools unrelated to task context    |
| Temporal drift      | Drift after unrelated user message            |

## Key Functions

| Function                                        | Description                                             |
| ----------------------------------------------- | ------------------------------------------------------- |
| `detectDrift(ctx, taskContext, currentContext)` | Compare current against task baseline                   |
| `getDriftScore()`                               | Numeric drift score (0 = on track, 1 = fully drifted)   |
| `resetBaseline(ctx, newTask)`                   | Reset task context when user shifts tasks intentionally |

## Whisper Pattern

When drift is detected:

```
[SUBTLE] Topic drift detected. Original task: {task}. Current: {current}.
Consider refocusing or updating task context.
```

## Key Patterns

- **Non-blocking**: Drift detection whispers rather than blocks — the agent chooses whether to act.
- **Multi-signal**: Combines semantic overlap, tool relevance, and structural analysis for robust detection.
- **Explicit reset**: `resetBaseline` allows intentional topic shifts without false drift warnings.
