# lib/metacognitive-state.ts

**Purpose**: Lightweight confidence and knowledge-gap tracking — extracts the core metacognitive signals from the dead Metacognition class. Session-scoped via `extension-state.ts`.

## Key Functions

| Function | Description |
|----------|-------------|
| `getMetacognitiveState(ctx)` | Get or create state object |
| `updateConfidence(ctx, delta)` | Adjust confidence by +/- delta |
| `addKnowledgeGap(ctx, gap)` | Record that something is unknown |
| `addStrength(ctx, strength)` | Record something agent is good at |
| `addWeakness(ctx, weakness)` | Record something agent should improve |
| `getConfidenceLevel(confidenceScore)` | Map numeric score to text: `low`/`medium`/`high`/`very_high` |

## State

```typescript
{
  confidence: number,       // 0—1, default 0.8
  knowledgeGaps: string[],
  strengths: string[],
  weaknesses: string[],
  lastReviewAt?: number,
}
```

## Key Patterns

- **Session-scoped**: Uses `getExtensionState(ctx, "metacognitive", ...)`. No global fallback needed — all callers have ctx access.
- **Legacy extraction**: Extracted from the old Metacognition class which had ~20 methods for unrelated concerns (recommendations, error handling, etc.). This module only keeps the confidence/knowledge tracking.
- **Confidence text mapping**: Scores below 0.3 = `low`, 0.3–0.7 = `medium`, 0.7–0.95 = `high`, >0.95 = `very_high`.
