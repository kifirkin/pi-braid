# lib/reasoning-metrics.ts

**Purpose**: Lightweight reasoning stability metrics that approximate reasoning quality WITHOUT logprobs or model internals.

## Three Metrics

| Metric            | Description                         | Calculation                                                     |
| ----------------- | ----------------------------------- | --------------------------------------------------------------- |
| **Overlap**       | Did the response stay on topic?     | Jaccard similarity between request anchors and response tokens  |
| **Entropy**       | Is output repetitive or chaotic?    | Bigram Shannon entropy normalized to [0, 1]                     |
| **Contradiction** | Did the response contradict itself? | Count of self-contradictory phrases (negation + same predicate) |

## Key Functions

| Function                              | Description                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `measureStability(request, response)` | Full stability check → `{ stable, reason, metrics }`                                    |
| `extractAnchors(text)`                | Extract key terms (nouns, verbs, numbers) as semantic anchors                           |
| `measureOverlap(text, anchors)`       | Fraction of anchors present in response text                                            |
| `measureBigramEntropy(text)`          | Shannon entropy of bigram distribution (0=chaotic, 1=repetitive)                        |
| `countSelfContradictions(text)`       | Count phrases like "but", "however", "on the other hand" that follow negated predicates |

## Usage

```typescript
const result = measureStability(userRequest, agentResponse);
if (!result.stable) {
  // result.reason describes what's wrong
  // result.metrics.overlap, .entropy, .contradictions
}
```

## Key Patterns

- **Anchor extraction**: Uses simple heuristics (uppercase words, numbers, 4+ char words) — no POS tagging needed.
- **Entropy interpretation**: Low entropy (<0.3) = chaotic/disorganized; High entropy (>0.7) = repetitive/templated. The sweet spot is 0.3–0.7.
- **Contradiction heuristic**: Simple pattern matching — not a deep semantic check. Catches obvious cases only.
