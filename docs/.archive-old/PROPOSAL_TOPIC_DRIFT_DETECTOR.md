# Topic Drift Detector for Enforcement

## Problem

pi-braid produces fluent but off-topic output (well-formatted paper on mathematical "braid" instead of "pi-braid architecture"). Current enforcement reacts to violations _after_ they occur. No mechanism detects drift _before_ confident wrong output.

## Architecture

### Detection Layers

**1. Semantic Drift Detection (cheap)**

- Maintain a set of "active topic anchors" from user request
- Before generating: measure cosine similarity of intended output vs anchors
- Threshold: if similarity < 0.6, flag as drift

**2. Structural Drift Detection (cheaper)**

- Track output _type_ expectations: code, analysis, proposal, implementation
- If output format diverges significantly from expected type, flag
- E.g., user asks for "implementation plan" → model produces "academic paper" → flag

**3. Confidence Drift Detection (from 2604.14881)**

- Measure hedging language frequency over turn history
- If hedging decreases while coherence decreases → instability signal
- ECL-style: low uncertainty + low accuracy = drift

### Integration Points

```
User Request
    ↓
extractTopicAnchors(request) → Set<string>
    ↓
enforcement.on("before_generation", (ctx) => {
    const anchors = getTopicAnchors(ctx);
    const similarity = measureSimilarity(ctx.intendedOutput, anchors);
    if (similarity < THRESHOLD) {
        ctx.signalDrift({ anchors, similarity });
    }
});
    ↓
signalDrift → implicit whisper ("You seem to be drifting from the request")
```

### Minimal Implementation (<50 lines for core)

```typescript
// enforcement/topic-drift.ts

const TOPIC_ANCHORS = new Map<string, Set<string>>(); // sessionId → anchors

export function extractAnchors(request: string): Set<string> {
  // Extract nouns, technical terms, project names from request
  const tokens = request.toLowerCase().split(/\W+/);
  return new Set(tokens.filter((t) => t.length > 3));
}

export function measureSimilarity(output: string, anchors: Set<string>): number {
  const outputTokens = new Set(output.toLowerCase().split(/\W+/));
  const intersection = [...anchors].filter((a) => outputTokens.has(a));
  return intersection.length / anchors.size;
}

export function detectTopicDrift(
  sessionId: string,
  request: string,
  output: string,
  threshold = 0.6,
): { drifted: boolean; similarity: number; missing: string[] } {
  const anchors = TOPIC_ANCHORS.get(sessionId) ?? extractAnchors(request);
  TOPIC_ANCHORS.set(sessionId, anchors);

  const similarity = measureSimilarity(output, anchors);
  const missing = [...anchors].filter((a) => !output.toLowerCase().includes(a));

  return {
    drifted: similarity < threshold,
    similarity,
    missing,
  };
}

export function clearAnchors(sessionId: string): void {
  TOPIC_ANCHORS.delete(sessionId);
}
```

### Whisper Format (implicit, no stakes)

Instead of: "You must stay on topic or you'll be reset"

Use: "Your response seems to cover different ground than the request mentioned"

## Decisions for Subagent

1. **Threshold**: 0.6 or tunable? Suggest 0.5 as conservative default
2. **Anchor persistence**: Clear on new user request, not on every turn
3. **Response to drift**: Silent signal (implicit whisper) vs no-op? Suggest silent
4. **Test case**: Can we construct a test that reproduces the "braid paper" failure?

## Not in Scope

- LLM-based semantic similarity (expensive)
- Multi-turn coherence tracking
- User intent classification

## Success Criteria

- [ ] Detects "braid paper" failure mode
- [ ] Does not false-positive on legitimate topic evolution
- [ ] Whisper format contains no stakes language
- [ ] <50 lines core logic
