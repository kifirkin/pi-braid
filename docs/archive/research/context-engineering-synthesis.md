# Thread Synthesis: Context Engineering

**Date**: 2026-04-19  
**Research Question**: How do we manage context without losing knowledge through compaction?

---

## Core Papers

### Batch Context (2511.04108)
**Finding**: 76% token reduction via pattern induction

**Key technique**: When processing multiple related queries, induce patterns from the first few examples, then compress subsequent queries by referencing the pattern instead of repeating details.

**Minimal implementation**:
```typescript
// Batch queries that share a pattern
function batchCompress(queries: string[]): string[] {
    const pattern = inducePattern(queries.slice(0, 3));
    return queries.map(q => compressByPattern(q, pattern));
}
```

### ACE: Awareness-Consciousness-Evolution (2510.04618)
**Finding**: Treating state as "evolving playbooks" prevents knowledge erosion

**Key insight**: Standard compression (summarize + discard) loses knowledge atoms. ACE preserves them by tracking which insights are "load-bearing" vs "ephemeral."

**Implementation**:
```typescript
// Knowledge atoms are marked explicitly
interface KnowledgeAtom {
    id: string;
    content: string;
    loadBearing: boolean;  // True = don't discard
    lastUsed: number;
    connections: string[];  // Other atoms this connects to
}

// On compaction: preserve load-bearing atoms, collapse ephemeral
function aceCompact(context: Context, atoms: KnowledgeAtom[]): Context {
    const preserved = atoms.filter(a => a.loadBearing || isRecent(a));
    const collapsed = atoms.filter(a => !a.loadBearing && !isRecent(a))
        .map(a => summarize(a));  // Replace with brief reference
    return [...preserved, ...collapsed];
}
```

### Evidence Pool (2604.14170)
**Finding**: Persistent evidence with confidence + relevance signals beats stateless retrieval

**Key architecture**:
```
Evidence Pool
    ↓
Deficiency Analysis (gaps + conflicts)
    ↓
Query Refinement (iterative)
    ↓
Stable evidence aggregation
```

**pi-braid connection**: Session-recall needs source tracking + confidence scores

### MemoSight (2604.14889)
**Finding**: Type-aware compression — 66% KV reduction, 1.56x speedup

**Key technique**: Different content types need different compression strategies:
- tool_calls: preserve exact
- code: preserve structure, compress whitespace
- whispers: signal_only (keep signal, remove explanation)
- reasoning: anchor (keep anchors, compress detail)
- user_messages: intent (keep intent, remove politeness)

**Minimal implementation**:
```typescript
const COMPRESSION_STRATEGY = {
    "tool_calls": "preserve",
    "code": "structure",
    "whispers": "signal_only",
    "reasoning": "anchor",
    "user_messages": "intent"
};

function compress(content: string, type: keyof typeof COMPRESSION_STRATEGY): string {
    const strategy = COMPRESSION_STRATEGY[type];
    // Apply strategy...
}
```

---

## What's Applicable to pi-braid

### Immediate (can implement now)

1. **Type-aware compression in context-manager**
   - Different compression for different content types
   - Tool calls = preserve (exact)
   - Reasoning = anchor (keep conclusions)

2. **Evidence pool for session-recall**
   - Add confidence + relevance signals
   - Track source (memory, web, code, docs)

### Medium-term (needs Task 2 session state)

3. **ACE knowledge atom tracking**
   - Mark insights as load-bearing
   - Track connections between atoms
   - Preserve on compaction

### Long-term (needs more research)

4. **Batch context for related queries**
   - Detect when user is asking related questions
   - Compress by pattern instead of discarding

---

## What's NOT Applicable

- **SkipKV async I/O**: pi-coding-agent doesn't expose KV cache management
- **MemoSight multi-token prediction**: Internal model optimization, not harness-level

---

## Implementation Priority

| Component | Effort | Impact | Priority |
|----------|--------|--------|----------|
| Type-aware compression | Low | Medium | P1 |
| Evidence pool (basic) | Medium | High | P1 |
| ACE knowledge atoms | High | Medium | P2 |
| Batch context | Medium | Low | P3 |

---

## Connection to Other Threads

- **cognitive-control**: Evidence pool feeds into heartbeat scheduler decisions
- **knowledge-conflicts**: Source tracking in evidence pool enables conflict detection
- **measurement**: Compression metrics measure knowledge preservation
