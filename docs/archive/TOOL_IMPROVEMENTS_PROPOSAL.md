# PI-BRAID Tool Improvements Proposal

**Date:** 2026-04-17  
**Status:** Proposed  
**Based on:** R-CCAM research (2511.17673), STEM Agent (2603.22359), MemEvolve (2512.18746)

---

## Philosophy

**Tools = Knowledge Decompression**

Each tool should support the cognitive loop:
```
Retrieval → Cognition → Control → Action → Memory
```

Tools are not just utilities - they're cognitive scaffolds that expand model capabilities.

---

## Priority 1: think() Tool v2

### Current State
```typescript
interface ThinkInput {
  observation: string;
  decision: string;
  reason: string;
}
```

### Issues
- No depth control (quick vs deep thinking)
- No chain linking (parent_id for reasoning chains)
- No structured templates for different task types
- No confidence/alternatives tracking
- No connection to memory_recall

### Proposed v2
```typescript
interface ThinkInput {
  // Required
  observation: string;      // What you observed/discovered
  decision: string;        // What you decided
  
  // Depth control (from Ares research: 52.7% token reduction)
  // "Reserve high effort for difficult steps, lower for simple steps"
  depth?: 'minimal' | 'low' | 'medium' | 'high' | 'max';
  
  // Structured thinking type (from Hi-CoT research: 6.2% accuracy improvement)
  // "Alternating between planning and execution beats flat reasoning"
  type?: 'observation' | 'planning' | 'execution' | 'reflection' | 'conclusion';
  
  // Failure handling (from Structured Reflection research)
  // "Reflection must diagnose failure + propose fix, not just 'think more'"
  on_failure?: {
    diagnose: boolean;       // What went wrong?
    propose_fix: boolean;   // What to do instead?
  };
  
  // Chain linking
  parent_id?: string;      // Link to parent thought for chains
  thought_id?: string;     // Returned for child linking
  
  // Meta
  tags?: string[];
  
  // Multi-hypothesis support
  confidence?: number;      // 0-1 confidence level
  alternatives?: string[];  // Alternative decisions considered
  expected_outcome?: string; // What success looks like
}

interface ThinkResult {
  thought_id: string;       // For chaining
  depth_used: string;       // actual depth used
  chain_position: 'root' | 'child' | 'leaf';
  parent_id?: string;
  
  // Integration hints
  related_memories?: string[];   // From memory recall
  suggested_next?: string;       // Next tool to call
  
  // Quality signals
  confidence: number;
  alternatives_considered?: number;
}
```

### Benefits
- **Depth control**: Quick for simple tasks, deep for complex analysis
- **Chains**: Parent-child linking for multi-step reasoning
- **Structured types**: Template hints for different thinking patterns
- **Confidence tracking**: Enable multi-hypothesis reasoning
- **Integration**: Auto-suggest next tools, link to memories

---

## Priority 2: hypothesize() Tool v2

### Current State
Basic hypothesis generation from problem + evidence.

### Proposed v2
```typescript
interface HypothesizeInput {
  problem: string;
  evidence?: string;
  max_hypotheses?: number;    // default: 3
  
  // Output format
  format?: 'ranked' | 'tree' | 'list';  // default: 'ranked'
  
  // Verification tracking
  verification_plan?: string;   // How to test each hypothesis
  
  // Context
  context?: string;           // Additional context
}

interface HypothesisResult {
  hypotheses: Array<{
    id: string;
    text: string;
    plausibility: number;      // 0-1
    
    // Evidence tracking
    evidence_for: string[];
    evidence_against: string[];
    
    // Verification
    tests: string[];           // How to verify
    verification_plan?: string;
    
    // Structure
    parent_id?: string;        // For tree format
    children?: string[];       // Sub-hypotheses
  }>;
  
  // Recommendation
  recommended_first?: string;   // Hypothesis ID to try first
  recommended_tests?: string[];  // Most promising tests
  
  // Quality
  total_considered: number;
  confidence: number;
}
```

### Benefits
- **Ranked output**: Most plausible first
- **Evidence tracking**: Why each hypothesis is plausible/unlikely
- **Verification plans**: How to test each
- **Tree format**: Complex multi-level hypotheses

---

## Priority 3: memory_recall() Tool v2

### Current State
Semantic text search with basic filtering.

### Proposed v2
```typescript
interface MemoryRecallInput {
  query: string;
  
  // Filters
  memory_type?: 'insight' | 'pattern' | 'error' | 'episodic' | 'semantic' | 'procedural';
  limit?: number;              // default: 5
  min_relevance?: number;     // 0-1 threshold
  
  // Time filters
  since?: string;             // ISO date
  until?: string;
  
  // Tags
  tags?: string[];
  
  // Context-aware ranking
  current_context?: string;   // Help rank by relevance to current task
  
  // Linking
  related_to?: string[];       // Memory IDs to find related
}

interface MemoryRecallResult {
  memories: Array<{
    id: string;
    content: string;
    memory_type: string;
    
    // Quality signals
    relevance: number;          // 0-1 to query
    recency: number;            // 0-1 (newer = higher)
    importance: number;         // 0-1 (user-specified)
    
    // Structure
    tags: string[];
    linked_memories?: string[];
    
    // Why retrieved
    relevance_reason?: string;   // "Matches debug pattern"
    
    // Consolidation
    consolidate_with?: string[]; // Similar memories to merge
  }>;
  
  // Summary
  total_found: number;
  returned_count: number;
  consolidation_suggestions?: string[][];
}
```

### Benefits
- **Type filtering**: Only recall relevant memory types
- **Relevance scoring**: Why each memory was retrieved
- **Context-aware**: Rank by current task relevance
- **Consolidation detection**: Flag similar memories

---

## Priority 4: memory_store() Tool v2

### Current State
Basic storage with type + tags.

### Proposed v2
```typescript
interface MemoryStoreInput {
  content: string;
  memory_type: 'insight' | 'pattern' | 'error' | 'episodic' | 'semantic' | 'procedural';
  
  // Importance (for eviction)
  importance?: number;          // 0-1, affects TTL
  
  // Lifecycle
  ttl_ms?: number;            // Auto-expire after N ms
  expires_at?: string;          // ISO date
  
  // Consolidation
  consolidate_with?: string[]; // IDs of similar memories to merge
  
  // Linking
  linked_memories?: string[];  // Related memory IDs
  parent_id?: string;          // For episodic chains
  
  // Context
  context?: string;            // When/why stored
  source?: string;             // Where from
}

interface MemoryStoreResult {
  id: string;
  
  // Consolidation
  consolidated_with?: string[];  // If merged
  consolidate_suggestions?: string[]; // Other similar IDs
  
  // Quality
  estimated_utility?: number;     // Predicted usefulness
  
  // Warnings
  similar_existing?: string[];    // Flag potential duplicates
  ttl_set?: number;               // If TTL was applied
}
```

### Benefits
- **TTL support**: Ephemeral knowledge auto-expires
- **Consolidation**: Merge similar memories
- **Linking**: Explicit relationships
- **Eviction hints**: Importance affects retention

---

## Cross-Cutting: Standard Tool Results

All cognitive tools should return:

```typescript
interface StandardToolResult {
  id: string;
  
  // Quality signals
  confidence: number;                    // 0-1
  alternatives_considered?: number;
  
  // Integration hints
  suggested_next_tool?: string;
  related_memories?: string[];
  
  // Chain tracking (for closed-loop)
  tracking_id?: string;
  chain_position?: 'root' | 'child' | 'leaf';
}
```

---

## Cross-Cutting: Closed-Loop Outcome Tracking

```typescript
interface OutcomeTracker {
  // Start tracking a task
  start_tracking(task_id: string, goal: string): tracking_id;
  
  // Record each step
  record_outcome(tracking_id: string, tool: string, result: string): void;
  
  // Close with result
  close_tracking(tracking_id: string, success: boolean): {
    path_taken: string[];
    what_worked: string[];
    what_failed: string[];
    learnings: string[];
  };
  
  // Retrieve learnings for similar tasks
  get_learnings(task_type: string): string[];
}
```

---

## Implementation Priority

| Tool | Priority | Impact | Complexity | Status |
|------|----------|--------|------------|--------|
| think() v2 | HIGH | High | Medium | Proposed |
| hypothesize() v2 | HIGH | High | Medium | Proposed |
| memory_recall() v2 | HIGH | High | Medium | Proposed |
| memory_store() v2 | MEDIUM | Medium | Low | Proposed |
| Standard results | MEDIUM | Medium | Low | Proposed |
| Outcome tracking | MEDIUM | High | High | Proposed |

---

## Research Foundation

### Architecture Papers
- **R-CCAM** (2511.17673): 5-phase loop (Retrieval→Cognition→Control→Action→Memory)
- **STEM Agent** (2603.22359): Skills maturation, tool differentiation
- **MemEvolve** (2512.18746): Self-evolving memory, sub-linear growth
- **ElephantBroker** (2603.25097): 5-source retrieval, relevance scoring

### Structured Thinking Papers
- **Ares** (2603.07915): Per-step adaptive reasoning effort - **52.7% token reduction** with minimal accuracy loss. Key: "Reserve high effort for difficult steps, lower for simple steps"
- **Draft-Thinking** (2603.00578): Efficient reasoning - **82.6% token reduction** on MATH500 with only 2.6% accuracy drop. Models can internalize efficient reasoning patterns
- **Hi-CoT** (2604.00130): Hierarchical Chain-of-Thought - **6.2% accuracy improvement**, **13.9% shorter traces**. Key: Alternating planning + execution beats flat reasoning
- **Network-of-Thought** (2603.20730): Graph topology - NoT > ToT on multi-hop (91% vs 88%), CoT best for sequential (89.5%). Reasoning topology should match task
- **Structured Reflection** (2509.18847): Explicit failure diagnosis + fix - Large gains in multi-turn tool-call success. Key: Reflection must be "diagnose + propose fix", not just "think more"
- **Heartbeat-Driven** (2604.14178): Proactive cognitive scheduling - Agents should proactively schedule thinking activities, not just react to failures

### Key Insights for think() Tool v2

| Research | Implication |
|----------|------------|
| Ares | Add `depth` parameter: minimal → max effort per step |
| Draft-Thinking | Compact thinking templates that models can internalize |
| Hi-CoT | Separate `planning` type from `execution` type |
| Structured Reflection | Add `on_failure` with diagnose + propose_fix |
| Network-of-Thought | Support graph reasoning for complex problems |
| Heartbeat | Proactive cognitive module scheduling |

---

## Next Steps

1. Implement think() v2 with depth control + chains
2. Add relevance scoring to memory_recall()
3. Add TTL/consolidation to memory_store()
4. Add standard result format to all cognitive tools
5. Implement outcome tracking for closed-loop learning