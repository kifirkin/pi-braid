# New Papers: April 19 Afternoon Research

## CRITICAL: Evo-MedAgent (2604.14475)

**Title**: Beyond One-Shot Diagnosis with Agents That Remember, Reflect, and Improve

**Finding**: Self-evolving memory with THREE complementary stores. This is the concrete implementation we needed for MARS.

### The Three Stores (Concrete Implementation)

```
1. Retrospective Clinical Episodes
   - Retrieve problem-solving experiences from similar past cases
   - Case-based reasoning with retrieval + similarity matching
   - "What did I do for a similar problem?"

2. Adaptive Procedural Heuristics
   - Priority-tagged diagnostic rules that evolve via reflection
   - Like a physician refining internal criteria
   - "Rule: prioritize chest X-ray if patient age > 50 AND symptoms include chest pain"

3. Tool Reliability Controller
   - Tracks per-tool trustworthiness
   - "Tool X succeeds 80% of the time for task Y"
   - Enables adaptive tool selection
```

### Results

- MCQ accuracy: 0.68 → 0.79 (GPT-5-mini)
- MCQ accuracy: 0.76 → 0.87 (Gemini-3 Flash)
- **No training required** — test-time adaptation
- Overhead: one retrieval pass + one reflection call

### Why This Matters for pi-braid

The MARS paper (2601.11974) is abstract. Evo-MedAgent gives the CONCRETE architecture:

```typescript
// Evo-MedAgent-inspired memory stores for pi-braid

interface RetrospectiveEpisodes {
    episodes: Array<{
        task: string;
        solution: string;
        outcome: "success" | "failure";
        similarity: number;
    }>;

    retrieve(query: string): Episode[] {
        return this.episodes
            .filter(e => semanticSimilarity(query, e.task) > 0.7)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, 3);
    }
}

interface ProceduralHeuristics {
    rules: Array<{
        condition: string;
        action: string;
        priority: number;
        successRate: number;
    }>;

    evolve(outcome: Outcome): void {
        // Increase priority of rules that led to success
        // Decrease priority of rules that led to failure
        // Add new rules from reflection
    }
}

interface ToolReliability {
    toolStats: Map<string, { attempts: number; successes: number }>;

    getReliability(tool: string, task: string): number {
        const stats = this.toolStats.get(`${tool}:${task}`);
        return stats ? stats.successes / stats.attempts : 0.5;
    }

    selectBestTool(task: string): string {
        return [...this.toolStats.entries()]
            .filter(([key]) => key.includes(task))
            .sort((a, b) => this.getReliability(a[0], task) - this.getReliability(b[0], task))[0]?.[0]
            ?? "default";
    }
}
```

### Connection to Our Research

| Evo-MedAgent Component | Our Research Thread | Connection                                      |
| ---------------------- | ------------------- | ----------------------------------------------- |
| Retrospective Episodes | measurement         | Episode tracking + outcome correlation          |
| Adaptive Heuristics    | cognitive-control   | Procedural rules evolve via reflection          |
| Tool Reliability       | agent-architecture  | Track tool success rates for adaptive selection |
| Reflection call        | MARS                | Single reflection call per case                 |

---

## HIGH: RUMS (2604.14473)

**Title**: Response-Aware User Memory Selection for LLM Personalization

**Finding**: Memory selection via **mutual information** between memory and model outputs, not semantic similarity. 95% reduction in computational cost.

### Key Insight

Current: Select memory based on similarity to query  
Problem: Similar query ≠ useful memory

RUMS: Select memory based on **mutual information with response**

- "Which memories SHIFT the response distribution?"
- "Which memories reduce uncertainty in the output?"

```typescript
// RUMS-inspired memory selection for pi-braid

interface RUMSMemorySelector {
    // Instead of: semantic similarity to query
    // Use: mutual information with response

    select(memories: Memory[], query: string): Memory[] {
        // Step 1: Generate candidate response with each memory
        const responses = memories.map(m =>
            generateWithMemory(query, m)
        );

        // Step 2: Measure response entropy (uncertainty)
        const entropies = responses.map(r => measureEntropy(r));

        // Step 3: Select memories that minimize response entropy
        // (reduce uncertainty, sharpen predictions)
        return memories
            .map((m, i) => ({ memory: m, entropy: entropies[i] }))
            .sort((a, b) => a.entropy - b.entropy)
            .slice(0, 5)  // Top 5 uncertainty reducers
            .map(r => r.memory);
    }
}
```

### Why This Matters for pi-braid

Our evidence pool currently selects by relevance/recency. RUMS suggests selecting by **response impact** — which memories actually change what the model says.

---

## MEDIUM: Mind DeepResearch (2604.14518)

**Title**: Efficient Multi-Agent Deep Research Framework

**Finding**: Three-agent architecture with specialized training.

### Architecture

```
Manager Agent
    ↓
Planning Agent → DeepSearch Agent → Report Agent
```

### Four-Stage Training

1. SFT cold-start
2. Search-RL
3. Report-RL
4. Preference alignment

### Relevance to pi-braid

This gives a template for multi-agent coordination:

- Manager = orchestrator
- Planning = goal decomposition
- DeepSearch = retrieval/execution
- Report = synthesis

---

## MEDIUM: AIBuildAI (2604.14455)

**Title**: AI Agent for Automatically Building AI Models

**Finding**: Hierarchical agent architecture.

### Architecture

```
Manager Agent
    ↓
Designer → Coder → Tuner
```

### Results

- MLE-Bench: 63.1% medal rate
- Outperforms experienced AI engineers
- First place on benchmark

### Relevance to pi-braid

Similar to Mind DeepResearch — gives concrete architecture for multi-agent systems.

---

## MEDIUM: NuHF Claw (2604.14440)

**Title**: Risk-Constrained Cognitive Agent Framework for Nuclear Control

**Finding**: Cognitively grounded workload + situational awareness estimation.

### Key Concept

```
Cognitive State Inference
    ↓
Probabilistic Safety Assessment
    ↓
Real-time Intervention
    ↓
Human Authority Preserved
```

### Relevance to pi-braid

Cognitive state inference ≈ our stability monitoring.  
Real-time intervention ≈ our heartbeat scheduler.  
Human authority preserved ≈ implicit framing (not explicit control).

---

## Synthesis: The Architecture Converges

From all our research, the architecture for pi-braid's next generation is:

```
┌─────────────────────────────────────────────────────────────┐
│ HEARTBEAT SCHEDULER (2604.14178)                          │
│  - Proactive cognitive module scheduling                   │
│  - Meta-learning from interaction history                  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ THREE MEMORY STORES (inspired by Evo-MedAgent)             │
│  ┌─────────────────┬──────────────────┬─────────────────┐ │
│  │ Retrospective    │ Adaptive          │ Tool            │ │
│  │ Episodes         │ Heuristics        │ Reliability     │ │
│  │ (case retrieval) │ (evolving rules)  │ Controller      │ │
│  └─────────────────┴──────────────────┴─────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ BELIEF + POLICY ENGINE (2604.14401 Credo)                 │
│  - Declarative policies over beliefs                      │
│  - Semantic control plane                                 │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ EVIDENCE POOL (2604.14170) + RUMS (2604.14473)           │
│  - Source tracking + mutual information selection          │
│  - Confidence + relevance signals                         │
└─────────────────────────────────────────────────────────────┘
```

---

## What This Enables

| Component        | Paper        | Implementation                     |
| ---------------- | ------------ | ---------------------------------- |
| Heartbeat        | 2604.14178   | When to trigger reflection         |
| Episodes         | Evo-MedAgent | Case retrieval from history        |
| Heuristics       | Evo-MedAgent | Evolving rules from outcomes       |
| Tool Reliability | Evo-MedAgent | Per-tool success tracking          |
| Memory Selection | RUMS         | Mutual information, not similarity |
| Policies         | Credo        | Declarative belief-based control   |

---

## Action Items

1. **Implement three memory stores** — Evo-MedAgent gives the architecture
2. **RUMS-style memory selection** — mutual information instead of semantic similarity
3. **Tool reliability tracking** — per-tool success rates for adaptive selection
4. **Connect to heartbeat scheduler** — when to call reflection

---

## References

- [2604.14475](https://arxiv.org/abs/2604.14475) - Evo-MedAgent
- [2604.14473](https://arxiv.org/abs/2604.14473) - RUMS
- [2604.14518](https://arxiv.org/abs/2604.14518) - Mind DeepResearch
- [2604.14455](https://arxiv.org/abs/2604.14455) - AIBuildAI
- [2604.14440](https://arxiv.org/abs/2604.14440) - NuHF Claw
