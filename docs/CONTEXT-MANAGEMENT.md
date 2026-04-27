# Context Management Improvements

> Research-driven analysis of pi-braid's context management system, identifying root causes of context growth and proposing concrete improvements based on published research.

## Problem Statement

Context grows over long sessions, causing agent performance to degrade. The agent becomes slower, less focused, and eventually produces worse results as the conversation history fills with noise.

**Symptoms:**
- Context hit rate drops after ~30 turns
- Agent starts repeating itself
- Error rate increases in long sessions
- New tasks inherit irrelevant context from previous sessions

## Root Cause Analysis

### What pi-braid Has

pi-braid already has a sophisticated context management system:

| Component | Location | What It Does |
|-----------|-----------|---------------|
| **S-MMU Context Lifecycle** | `context-lifecycle/` | R-CCAM loop: retrieval, cognition, control, action, memory |
| **Context Manager** | `context-manager/` | Pruning, compression, rotation, navigation |
| **Three Memory Stores** | `three-memory-stores/` | Episodes, heuristics, tool reliability |
| **Evidence Pool** | `lib/evidence-pool.ts` | Belief tracking, conflict detection, provenance |
| **Heartbeat Scheduler** | `heartbeat-scheduler/` | Proactive monitoring |

### Why It's Not Enough

The existing mechanisms have fundamental limitations:

**1. Count-based thresholds, not density-based**

`context-manager/` uses hard token/message limits:
```typescript
MAX_MESSAGES = 200
COMPRESSION_THRESHOLD = 0.7  // 70% of limit
COMPRESS_WHEN_OVER = 100  // tokens over limit
```

This means context is compressed *after* it grows large, not *before* it becomes noisy. A 50-message context with high signal is better than a 10-message context with mostly boilerplate. Count thresholds miss this.

**2. No information density monitoring**

The heartbeat's `contextHygieneModule` (before this sprint) did almost nothing — it suggested `context_audit` every 20 turns without actually evaluating context quality.

**3. No provenance on memory injections**

Evidence and memories are injected into context without source/TTL tags. The agent can't distinguish fresh context from memory, leading to:
- **Memory contamination**: Memories from previous projects influence current work (HaluMem, 2511.03506)
- **Stale evidence**: Old evidence used as if fresh
- **No confidence calibration**: Agent doesn't know how old or reliable injected memories are

**4. Compression is structural, not semantic**

Current compression removes messages by count, not by meaning. Important context can be dropped while noisy boilerplate remains.

## Research Findings

### SimpleMem (2601.02553) — Semantic Compression

Key finding: **30x token reduction** with structured semantic compression while maintaining task performance.

```
Approach:
1. Identify semantic units (code blocks, tool results, reasoning)
2. Compress by meaning, not count
3. Preserve: problem statements, key decisions, critical failures
4. Drop: repeated error messages, verbose tool outputs, boilerplate
```

**Implementation in pi-braid**: The `recommendCompressionStrategy()` in `context-density.ts` recommends "semantic" compression when density is high but context is large.

### GenericAgent (2604.17091) — Information Density

Key finding: **Information density, not context length, determines performance.**

```
Insight: A 50-message context with 60% signal > 10-message context with 20% signal.
Implication: Monitor density, not just length.
```

**Implementation in pi-braid**: `evaluateContextDensity()` in `context-density.ts` computes signal/noise ratio per-message.

### Experience Compression Spectrum (2604.15877) — Adaptive Levels

Key finding: Different compression strategies work at different temporal scales.

```
Short-term (current session):
  - Prune repeated tool results
  - Collapse sequential failed commands
  - Summarize verbose outputs

Medium-term (recent history):
  - Convert reasoning chains to conclusions
  - Collapse loop iterations
  - Preserve: key decisions, critical failures

Long-term (episodic):
  - Convert to semantic summaries
  - Store in three-memory-stores
  - Inject with provenance tags
```

### HaluMem (2511.03506) — Memory Contamination

Key finding: Language models exhibit **memory hallucinations** — fluent but inaccurate claims about past interactions. These propagate between sessions when memories are injected without provenance.

**Implementation in pi-braid**:
- `Evidence.project` field tracks creation project
- `formatEvidenceWithProvenance()` tags injections with `[EVIDENCE source project=X ttl=Y ago]`
- `Evidence.project` on three-memory-stores episodes

### Memento (2511.03506) — External Memory

Key finding: External memory with retrieval outperforms in-context for long tasks. Semantic retrieval over episodic summaries outperforms retrieval over raw history.

**Implementation in pi-braid**: `three-memory-stores/` + `session-recall/` already implement this, but retrieval could be enhanced with semantic embeddings.

## Implemented Improvements (This Sprint)

### 1. Context Density Monitoring

**File**: `src/lib/context-density.ts`

```typescript
const density = evaluateContextDensity(ctx);
// density.density: 0-1 (signal / total)
// density.signalMessages: high-signal message count
// density.noisyMessages: boilerplate/duplicate count
// density.tokenRatio: tokens / limit ratio
// density.duplicates: near-duplicate messages
```

**Signals detected:**
- Repeated boilerplate (tracebacks, import statements, HTTP headers)
- Near-duplicate messages (hash-based detection)
- Token ratio vs density mismatch

### 2. Density-Aware Heartbeat

**File**: `src/extensions/heartbeat/heartbeat-scheduler/index.ts`

Enhanced `contextHygieneModule` now:
- Evaluates density every 5-10 turns (adaptive)
- Warns when density < 0.4 (noisy context)
- Suggests semantic compression when high-density + large context
- Projects turns-to-limit at current growth rate
- Detects duplicate spirals

### 3. Evidence Provenance

**File**: `src/lib/evidence-pool.ts`

```typescript
// Evidence now tagged with project source
export function addEvidence(..., ctx: ExtensionContext) {
  evidence: {
    ...,
    project: ctx.cwd ?? "unknown",  // NEW: provenance
  }
}

// Injected evidence tagged for agent visibility
export function formatEvidenceWithProvenance(evidence) {
  // Returns: "[EVIDENCE memory project=/path/to/proj 5m ago] claim text..."
}
```

### 4. Memory Provenance

**File**: `src/extensions/memory/three-memory-stores/index.ts`

Episodes tagged with project path. Retrieved memories display provenance:
```
[MEMORY project=/path/to/proj ttl=30m ago] ✅ [success] Implement feature X
   Solution: Used pattern Y with approach Z...
   Tools: grep → read → edit → bash
   Similarity: 78%
```

## Implemented ✅

| Item | Status | Implementation |
|------|--------|----------------|
| Context density monitoring | ✅ v0.28.0 | `src/lib/context-density.ts`: signal/noise eval, density %, strategy recommendation |
| Density-aware heartbeat | ✅ v0.28.0 | `contextHygieneModule`: density-aware warnings, turns-to-limit projection, duplicate detection |
| Evidence provenance | ✅ v0.28.0 | `Evidence.project` field + `formatEvidenceWithProvenance()` (HaluMem) |
| Density-aware S-MMU policies | ✅ v0.28.1 | `generateDensitySignals()` + `evaluatePolicies()` — emit density signals into lifecycle |
| Cross-session memory isolation | ✅ v0.28.1 | `Episode.project` + `Evidence.project` — cross-project filtering in queryEvidence + retrieveEpisodes |
| Memory provenance display | ✅ v0.28.1 | `[MEMORY project=X ttl=Ym ago]` prefix in search results |

## Remaining Work

### P1 (High Priority)

- [x] Density-aware compression proposals — `evaluatePolicies()` + heartbeat integration
- [x] Cross-session memory isolation — project field filtering (HaluMem)
- [x] **Adaptive compression levels** — ✅ v0.30.0: `determineCompressionLevel()` short/medium/long
  - Short-term: Prune repeated tool results after 3+ failures
  - Medium-term: Summarize reasoning chains into conclusions
  - Long-term: Convert to episodic summaries in three-memory-stores

### P2 (Medium Priority)
- [x] **Semantic compression prototype** — ✅ v0.31.0: `semanticCompress()` in `context-manager/semantic-compress.ts`
  - ⚠️ **NOTE:** Currently in wrong event handler (`"context"` — per-streaming, no return value effect)
  - **FIX:** Move to `session_before_compact` where return value is respected
- [ ] **Semantic compression in session_before_compact** — Move `semanticCompress()` from `"context"` handler to pre-compaction hook
- [ ] **Remove "context" event handler** — It fires per-streaming-message, not pre-compaction. Return value is ignored. Migrate logic to `session_before_compact`
- [ ] **Density metrics dashboard** — `getMetrics()` output includes contextDensity, lastDensityTurn (✅ v0.31.0 implementation)
- [ ] **Episodic extraction** — Convert high-value reasoning chains to episodic memories in three-memory-stores for cross-session retention
- [ ] **Memory eviction policies** — TTL + recency weighting for long-term store (currently unbounded)
- [ ] **Remove `(ctx as any).turnCount` usages** — Track turns via `message_end` events instead (unstable API)

### P3 (Research Findings)
- [x] **PI API research** — `docs/PI-API-RESEARCH.md`: event types, ExtensionContext properties, compaction lifecycle, session_before_compact patterns, known issues

## Architecture Decision

**Q: Should compression be triggered by the agent or automatically?**

A: Both, but differently:
- **Automatic**: Heartbeat fires when density < 0.4 or token ratio > 0.6. No agent intervention needed.
- **Agent-invoked**: `context_compress()` tool suggests compression strategy based on density. Agent decides whether to proceed.
- **Proactive**: Agent sees context density in heartbeat nudges and can invoke compression before being told to.

This matches the GenericAgent finding: **monitor density, not just length**. The agent should always know its context health.

## Key Metrics to Track

| Metric | Measurement | Target |
|--------|-------------|--------|
| Context density | signal / (signal + noise) | > 0.6 |
| Memory contamination rate | Memory hallucinations / total memory injections | < 5% |
| Compression effectiveness | Post-compression density / pre-compression density | > 1.2x |
| Turns-to-overflow projection | (tokenLimit - tokens) / tokensPerTurn | > 10 turns warning |

## References

- SimpleMem (2601.02553): Semantic Compression for Language Models
- GenericAgent (2604.17091): Information Density Determines Performance
- Experience Compression Spectrum (2604.15877): Adaptive Cross-Level Compression
- HaluMem (2511.03506): Memory Hallucinations in Language Models
- Memento (2511.03506): External Memory for Long-Term Language Model Conversation
