# Knowledge Conflicts for Faithful LLM Reasoning (2604.11209)

**SIGIR 2026** — Tianzhe Zhao et al.

## The Problem This Solves

Our Evidence Pool (2604.14170) + Cross-Query Contradictions (2604.14525) approach assumed:

- Conflicts between evidence sources are detectable
- Models should identify reliable evidence for correct reasoning

**This paper provides the benchmark proving this is a real, measurable problem.**

## ConflictQA Benchmark

### Types of Conflicts Studied

1. **Textual vs Textual** — Two text sources disagree
2. **KG vs KG** — Two knowledge graphs disagree
3. **Textual vs KG** — Text and knowledge graph disagree ← most common in modern RAG

### Key Findings

| Finding                                           | Evidence                                                 |
| ------------------------------------------------- | -------------------------------------------------------- |
| LLMs fail to identify reliable evidence           | Cross-source conflicts cause incorrect reasoning         |
| LLMs become sensitive to prompting choices        | Same question, different framing → different answer      |
| LLMs rely exclusively on ONE source               | Either KG or text, not both → faithful aggregation fails |
| Prompt framing matters more than evidence quality | Arbitrary selection                                      |

**Critical**: "LLMs become more sensitive to prompting choices and tend to rely exclusively on either KG or textual evidence, resulting in incorrect responses."

This means: our Evidence Pool needs explicit SOURCE TRACKING, not just conflict detection.

## XoT Framework: Two-Stage Explanation-Based Thinking

```
Stage 1: Evidence Explanation
    ↓
Identify each evidence source
Classify conflict type
    ↓
Stage 2: Reasoning over Heterogeneous Conflict
    ↓
Faithful aggregation of conflicting evidence
```

**pi-braid mapping**:

```typescript
// Current Evidence Pool (simplified):
interface Evidence {
  content: string;
  source?: string; // ← We had this, now it's CRITICAL
}

// With XoT:
// Stage 1: Source identification + conflict classification
interface EvidentialSource {
  type: "text" | "kg" | "param"; // parametric = what model "knows"
  content: string;
  timestamp: number;
  reliability?: number;
}

interface ConflictAnalysis {
  sources: EvidentialSource[];
  conflictType: "direct" | "implication" | "reliability";
  resolution: "favor_text" | "favor_kg" | "favor_param" | "acknowledge_conflict";
}

// Stage 2: Faithful reasoning
function faithfulReason(analysis: ConflictAnalysis): ReasoningResult {
  if (analysis.conflictType === "acknowledge_conflict") {
    // Don't pick arbitrarily — surface the conflict
    return {
      faithful: true,
      acknowledges: true,
      sources: analysis.sources,
    };
  }
  // Use reliability scores to resolve
  const reliableSource = analysis.sources.sort(
    (a, b) => (b.reliability ?? 0.5) - (a.reliability ?? 0.5),
  )[0];
  return { faithful: true, source: reliableSource };
}
```

## Why This Matters for pi-braid

### The pi-braid Evidence Problem

When pi-braid's context-manager compacts context:

- It may keep evidence from tool calls (textual)
- It may keep evidence from memory systems (could be KG-structured)
- It may keep parametric knowledge from system prompt

**If these conflict, how does pi-braid reason faithfully?**

Without source tracking: model picks arbitrarily based on position/formatting.  
With source tracking + XoT: model acknowledges conflict, picks based on reliability.

### The "Sensitive to Prompting" Problem

From paper: "LLMs become more sensitive to prompting choices"

This connects to **Context Over Content (2604.15224)** — stakes signaling corrupts reasoning. But there's a subtler effect:

**Prompt framing changes which evidence gets used:**

- "What does the code say?" → text evidence favored
- "What should we do?" → parametric knowledge favored
- "Consider all sources" → neither, conflict acknowledged

**pi-braid implication**: Our whispers/prompts may be inadvertently selecting which evidence the model uses.

### Minimal Implementation (<30 lines)

```typescript
// enforcement/evidence-tracker.ts

interface SourceTrackedEvidence {
  content: string;
  source: "tool_call" | "memory" | "system_prompt" | "user_message";
  reliability: number; // 0-1
  timestamp: number;
}

export function trackEvidence(
  content: string,
  source: SourceTrackedEvidence["source"],
  ctx: ExecutionContext,
): void {
  // Add to evidence pool with source tracking
  const evidence = {
    content,
    source,
    reliability: getSourceReliability(source),
    timestamp: Date.now(),
  };
  evidencePool.add(evidence);
}

export function detectCrossSourceConflict(): ConflictAnalysis | null {
  const evidence = evidencePool.getRecent();

  // Group by source
  const bySource = groupBy(evidence, "source");
  if (Object.keys(bySource).length < 2) return null;

  // Check for direct conflicts
  const texts = bySource["tool_call"] ?? [];
  const mems = bySource["memory"] ?? [];

  // Simple conflict: same entity, different claims
  const conflicts = findEntityConflicts(texts, mems);
  if (conflicts.length === 0) return null;

  return {
    sources: evidence,
    conflictType: "cross_source",
    acknowledged: true, // Faithful: acknowledge, don't pick arbitrarily
  };
}

export function faithfulReason(ctx: ExecutionContext): void {
  const conflict = detectCrossSourceConflict();
  if (conflict?.acknowledged) {
    // Surface the conflict in reasoning, don't suppress it
    ctx.signalAcknowledgedConflict(conflict.sources);
  }
}
```

## Integration with Our Architecture Stack

```
┌─────────────────────────────────────────────────────────┐
│ HEARTBEAT SCHEDULER (2604.14178)                        │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ BELIEF + POLICY ENGINE (2604.14401)                    │
│  - Policies now track source reliability               │
│  - Conflict detection → policy evaluation             │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ EVIDENCE POOL (2604.14170) ← NOW WITH XoT STAGE 1      │
│  - Source tracking (text, kg, param)                   │
│  - Conflict classification                            │
│  - Reliability scores                                 │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ MEASUREMENT LAYER                                      │
│  - Source selection bias detection                    │
│  - Prompt framing sensitivity                         │
└─────────────────────────────────────────────────────────┘
```

## Key Papers Connected

| This Paper                            | Connection                                         |
| ------------------------------------- | -------------------------------------------------- |
| 2604.14525 Cross-Query Contradictions | Metrics: contradiction density, revision cost      |
| 2604.14170 Evidence Pool              | Extended with source tracking + XoT Stage 1        |
| 2604.15224 Context Over Content       | Prompt sensitivity explains source selection bias  |
| 2604.14401 Credo                      | Policies can encode source reliability preferences |

## Action Items for Subagent

1. **Add source tracking to Evidence Pool** — every memory has a source type
2. **Implement simple conflict detection** — check for entity conflicts across sources
3. **Add `signalAcknowledgedConflict`** — faithful response to conflicts (acknowledge, don't suppress)
4. **Track prompt sensitivity** — measure if prompting changes which source gets selected

## Why This is P0 for Our Research

The implicit framing / anti-slop work assumes:

- Models produce consistent output
- Enforcement signals improve consistency

**ConflictQA proves**: Models produce INCONSISTENT output when sources conflict, and they're sensitive to prompt framing that arbitrates which source "wins."

Our enforcement needs to be FAITHFUL, not just corrective. Acknowledging conflict > arbitrary selection.

---

## Reference

Zhao, T., Chen, J., Zhang, S., Zhu, H., Lin, Q., & Liu, J. (2026). Exploring Knowledge Conflicts for Faithful LLM Reasoning: Benchmark and Method. _SIGIR 2026_. arXiv:2604.11209
