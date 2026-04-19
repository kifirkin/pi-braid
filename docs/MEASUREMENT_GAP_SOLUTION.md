# Measurement Gap: The Frontier for pi-braid Enforcement

## The Problem

All our papers (ECL, Layered Mutability, ACE, etc.) give **frameworks** — principles without algorithms. The actual frontier is:

> How do you AUTOMATICALLY measure reasoning stability, behavioral drift, and topic coherence WITHOUT human evaluation?

This matters because enforcement can't work if we don't know when to intervene.

---

## Key Finding: The Metacognition Gap

**2604.14180** (Internal Knowledge Without External Expression) reveals:

```
INTERNALLY: Model knows when it's uncertain (perplexity jump 2.39x between real/fabricated)
EXTERNALLY: Model never says "I don't know" — hedging rates DROP for OOD inputs (3.5% vs 8.3%)
```

**This is the core issue**: Models detect instability internally but don't express it. Enforcement works IF we make internal uncertainty visible.

**2604.14528** (GUARD) gives the mechanism:

```
Token-level entropy spikes → early transition points → reasoning failures
```

Small number of "critical transitions" cause errors. Local coherence maintained, global correctness lost.

**2604.14525** (Cross-Query Contradictions) gives the metrics:

```
Case Satisfiability Rate: belief state consistent?
Contradiction Density: how many contradictions?
Revision Cost: how much work to fix?
```

---

## The Measurement Stack

### Level 1: Token Entropy (GUARD-based)

We can't access logits directly (pi-coding-agent doesn't expose them). But we CAN approximate:

```typescript
// Token entropy proxy: repetition patterns
function measureEntropy(output: string): number {
    // High repetition = low entropy = confident (maybe too confident)
    // Low repetition = high entropy = uncertain
    
    const bigrams = countBigrams(output);
    const uniqueRatio = uniqueBigrams / totalBigrams;
    return uniqueRatio; // Higher = more diverse = potentially less certain
}

// Critical transitions: detect when coherence shifts
function detectTransition(prev: string, curr: string): boolean {
    const topicShift = measureTopicShift(prev, curr);
    const coherenceDrop = measureCoherence(curr) < threshold;
    return topicShift && coherenceDrop;
}
```

### Level 2: Topic Coherence (Cross-Query based)

```typescript
interface TopicState {
    anchors: Set<string>;      // From user request
    commitments: string[];      // What agent said it would do
    beliefs: Map<string, string>; // belief state
}

function measureCoherence(state: TopicState): number {
    const commitmentsMet = state.commitments.filter(c => c.inOutput);
    const beliefConsistent = checkBeliefConsistency(state.beliefs);
    
    return commitmentsMet.length / state.commitments.length * beliefConsistent;
}

function checkBeliefConsistency(beliefs: Map<string, string>): number {
    // Contradiction detection: same entity, different claims
    let contradictions = 0;
    for (const [entity, claim1] of beliefs) {
        for (const [_, claim2] of beliefs) {
            if (contradicts(claim1, claim2)) contradictions++;
        }
    }
    return 1 - (contradictions / beliefs.size);
}
```

### Level 3: Drift Detection (Combined)

```typescript
interface DriftMetrics {
    entropy: number;           // Token diversity
    coherence: number;          // Topic/state consistency
    commitmentsMet: number;     // Promise fulfillment
    contradictionDensity: number; // Belief conflicts
    revisionCost: number;       // Effort to fix
}

function measureDrift(
    request: string,
    history: TurnHistory,
    output: string
): DriftMetrics {
    return {
        entropy: measureEntropy(output),
        coherence: measureCoherence(extractState(request, history)),
        commitmentsMet: measureCommitments(request, output),
        contradictionDensity: measureContradictions(history),
        revisionCost: estimateRevisionCost(history)
    };
}

function shouldSignalDrift(metrics: DriftMetrics): boolean {
    return (
        metrics.entropy < 0.3 ||                    // Too repetitive
        metrics.coherence < 0.5 ||                   // Lost topic
        metrics.commitmentsMet < 0.3 ||              // Didn't deliver
        metrics.contradictionDensity > 0.3           // Self-contradicting
    );
}
```

---

## Integration with Enforcement

```typescript
// enforcement/stability-monitor.ts

export function createStabilityMonitor(pi: ExtensionAPI) {
    const state = new Map<string, TopicState>();
    
    // On user message: extract anchors
    pi.on("message_end", async (event, ctx) => {
        if (event.isUserMessage) {
            const anchors = extractAnchors(event.content);
            state.set(ctx.sessionId, { anchors, commitments: [], beliefs: new Map() });
        }
    });
    
    // On agent output: measure drift
    pi.on("message_end", async (event, ctx) => {
        if (event.isAgentMessage) {
            const topicState = state.get(ctx.sessionId);
            if (!topicState) return;
            
            const metrics = measureDrift(
                topicState.anchors,
                ctx.turnHistory,
                event.content
            );
            
            if (shouldSignalDrift(metrics)) {
                // Signal instability (NOT "you failed")
                pi.emit("reasoning-instability", { 
                    sessionId: ctx.sessionId,
                    metrics,
                    implicit: true  // No stakes, just signal
                });
            }
        }
    });
}
```

---

## The Metacognition Bridge

**2604.14180 insight**: Model KNOWS internally but doesn't express externally.

Our enforcement bridges this gap:

```
Model internal state:  [uncertain about "braid" topic]
                            ↓
Our measurement:        [entropy spike detected]
                            ↓
Implicit signal:        [whisper without stakes]
                            ↓
Model external:         ["Let me refocus on pi-braid architecture"]
```

The model CAN self-correct when uncertainty is surfaced — it just won't do it spontaneously.

---

## What We Can Measure Now (Lightweight)

| Metric | Algorithm | Lines |
|--------|-----------|-------|
| Topic drift | Token overlap with anchors | 10 |
| Commitment tracking | Parse intent, check output | 15 |
| Repetition | Bigram diversity | 5 |
| Self-contradiction | Entity-claim matrix | 20 |
| Entropy proxy | Repetition patterns | 5 |

**What we CAN'T measure (needs logprobs)**:
- True token-level entropy spikes (GUARD's core)
- Internal perplexity jumps (2604.14180's core)

These require model API access we don't have. But we can approximate.

---

## The Minimal Viable Measurement System

```typescript
// enforcement/lightweight-metrics.ts

export function measureReasoningStability(
    request: string,
    response: string,
    history: string[]
): { stable: boolean; reason: string } {
    // 1. Topic anchor overlap
    const anchors = extractAnchors(request);
    const overlap = measureOverlap(response, anchors);
    if (overlap < 0.5) return { stable: false, reason: "topic_drift" };
    
    // 2. Repetition (entropy proxy)
    const entropy = measureBigramEntropy(response);
    if (entropy < 0.2) return { stable: false, reason: "over_confident" };
    if (entropy > 0.8) return { stable: false, reason: "uncertain" };
    
    // 3. Self-consistency
    const contradictions = countSelfContradictions(response);
    if (contradictions > 0) return { stable: false, reason: "self_contradiction" };
    
    return { stable: true, reason: "ok" };
}

export function extractAnchors(text: string): Set<string> {
    // Nouns, technical terms, project names
    const tokens = text.toLowerCase().split(/\W+/);
    return new Set(tokens.filter(t => t.length > 4 && isTechnical(t)));
}

export function measureOverlap(text: string, anchors: Set<string>): number {
    const tokens = new Set(text.toLowerCase().split(/\W+/));
    const matches = [...anchors].filter(a => tokens.has(a));
    return matches.length / anchors.size;
}

export function measureBigramEntropy(text: string): number {
    const bigrams = text.match(/..?/g) || [];
    const freq = new Map<string, number>();
    for (const bg of bigrams) freq.set(bg, (freq.get(bg) || 0) + 1);
    const unique = freq.size;
    return unique / bigrams.length; // Higher = more diverse
}

export function countSelfContradictions(text: string): number {
    // Simple: look for negation patterns around same entities
    const claims = extractClaims(text);
    let contradictions = 0;
    for (let i = 0; i < claims.length; i++) {
        for (let j = i + 1; j < claims.length; j++) {
            if (contradicts(claims[i], claims[j])) contradictions++;
        }
    }
    return contradictions;
}
```

**~50 lines total. No LLM calls. No logprob access. Works now.**

---

## What This Enables

With lightweight measurement, enforcement becomes:

1. **Pre-emptive**: Detect drift BEFORE generating wrong output
2. **Specific**: Know WHY drift happened (topic vs repetition vs contradiction)
3. **Implicit**: Signal without stakes (per 2604.15224)

The model won't self-correct without external signals (2604.14180). We provide those signals.

---

## References

- [2604.14180](https://arxiv.org/abs/2604.14180) - Internal Knowledge Without External Expression
- [2604.14528](https://arxiv.org/abs/2604.14528) - GUARD: Dissecting Failure Dynamics in LLM Reasoning (ACL 2026)
- [2604.14525](https://arxiv.org/abs/2604.14525) - Quantifying Cross-Query Contradictions (ICLR 2026 Workshop)
- [2604.14881](https://arxiv.org/abs/2604.14881) - The Missing Knowledge Layer
