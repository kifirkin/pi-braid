# Looped Architecture Research → pi-braid Harness Improvements

**Date**: 2026-04-23
**Scope**: Research-backed improvements to pi-braid agent harness
**Method**: Map looped transformer/agent research to pi-braid's existing extension architecture

---

## 1. pi-braid Current Architecture Audit

### Existing Extensions (Reasoning-Related)

| Extension             | Function                                                     | Gap                                              |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `reasoning`           | Malformed tool detection, step counting, completion reminder | No adaptive depth, no refinement loop            |
| `metacognition`       | `think`, `hypothesize`, `finalize` tools; metrics tracking   | Single-shot reasoning, no iterative verification |
| `planner`             | Goal/plan management with dependencies                       | No budget awareness, no dynamic replanning       |
| `enforcement`         | Judge/whisper/nudge system                                   | Reactive only, no proactive verification loop    |
| `heartbeat-scheduler` | Periodic task execution                                      | No adaptive scheduling based on task state       |
| `feedback`            | Feedback loop from user/environment                          | No self-generated feedback                       |
| `rate-limiter`        | Rate limiting for API calls                                  | Static limits, no adaptive pacing                |
| `latent-activator`    | Behavior activation (detective, etc.)                        | Manual activation, no automatic routing          |

### Key Observation

pi-braid has **all the pieces** but they're **not connected as a loop**. The agent:

1. Thinks once (`think` tool)
2. Plans once (`plan` tool)
3. Executes
4. Gets reactive enforcement (if something looks wrong)

There's no **recursive refinement cycle**: think → act → verify → reflect → replan → repeat.

---

## 2. Research → Concrete Improvements

### Improvement 1: Recursive Verification Loop (Agentic Verifier)

**Source**: "Enhancing Large Language Model Agent via Multi-Turn Thinking and Tooling Verification" (2604.10980)

**What the paper found**:

- Multi-turn verification outperforms single-pass reasoning
- Three verification types: syntax, semantic, result
- Verification is itself a reasoning step that can be iterated
- LLM verification ≈ human quality for some tasks

**pi-braid gap**: The `finalize` tool runs once at the end. There's no structured verification loop before finalization.

**Implementation**: Add a `verify` tool to metacognition that:

```typescript
verify({
  target: "code|reasoning|plan|result",
  criteria: string[],
  depth: "quick|standard|deep",
})
```

The tool:

1. Takes the last output (code, reasoning, plan)
2. Checks it against criteria
3. Returns: {passed: boolean, issues: string[], confidence: number}
4. If issues found and confidence < threshold → trigger re-reasoning

**Integration with existing**:

- Hook into `finalize` tool: run `verify` before allowing finalization
- Use the utility model for verification (cheaper than main model)
- Track verification metrics in metacognition state

**Effort**: Medium (~100 lines in metacognition extension)
**Risk**: Low (additive, doesn't change existing behavior)

---

### Improvement 2: Budget-Aware Planning (BAVT)

**Source**: "Budget-Aware Value Estimation in LLM Agent Tree Search" (2604.13408)

**What the paper found**:

- Agents waste tokens on low-value exploration
- Budget-aware value estimation: estimate expected utility / token cost
- Prune branches where estimated value < cost
- Maintains 92% success rate with 66% fewer tokens

**pi-braid gap**: The planner creates goals/plans without considering token budget. The rate-limiter is static (X calls per minute), not task-aware.

**Implementation**: Add a `budget` field to goal/plan creation:

```typescript
plan({
  description: "...",
  budget: { maxTokens: 5000, maxCalls: 10 },
  valueEstimate: "high|medium|low",
});
```

The planner extension:

1. Tracks cumulative token usage per plan
2. Warns when approaching budget (80%, 90%, 95%)
3. Suggests simplification or early exit
4. Can abort low-value branches

**Integration with existing**:

- Extend `planner` goal schema with budget fields
- Hook into API calls to track actual usage
- Use rate-limiter as enforcement, not just throttling

**Effort**: Medium (~150 lines in planner + rate-limiter)
**Risk**: Low (additive, can be disabled)

---

### Improvement 3: Fast/Slow System Routing (ODAR)

**Source**: "ODAR: Optimal Depth Allocation Routing for Efficient Multi-Turn Agent Inference" (2604.08890)

**What the paper found**:

- Not all tasks need deep reasoning
- Route simple tasks to fast system (fewer loops), complex to slow
- Saves 30-60% tokens on simple tasks
- Uses input complexity features (length, keyword density, task type)

**pi-braid gap**: The `latent-activator` manually activates behaviors (detective, etc.). There's no automatic routing based on task complexity.

**Implementation**: Add an `auto-route` mechanism to latent-activator:

```typescript
// Before processing user message:
const complexity = estimateComplexity(message); // 0-1 score
const depth = complexity > 0.7 ? "deep" : complexity > 0.3 ? "standard" : "quick";

// Set reasoning depth
think({ depth, autoRouted: true });

// For simple tasks, skip planning and go direct
if (depth === "quick") {
  // Bypass planner, use direct reasoning
}
```

**Integration with existing**:

- Extend `latent-activator` with complexity estimation
- Use prompt-builder to inject depth hint into system prompt
- Track routing decisions in analytics

**Effort**: Low-Medium (~80 lines)
**Risk**: Low (can fall back to full reasoning)

---

### Improvement 4: Exploratory Reasoning (Poly-EPO)

**Source**: "Enhancing Agentic LLMs via Exploratory Policy Optimization" (2604.17094)

**What the paper found**:

- Diverse reasoning paths improve robustness
- Three strategies: Prototypical, Uncertainty-Guided, Error-Conductive
- Each generates different "views" of the same problem
- Fused results outperform any single path

**pi-braid gap**: The `hypothesize` tool generates multiple hypotheses but doesn't explore multiple reasoning paths for the SAME hypothesis.

**Implementation**: Add a `explore_paths` tool to metacognition:

```typescript
explore_paths({
  problem: "...",
  strategies: ["prototypical", "uncertainty-guided", "error-conductive"],
  maxPaths: 3,
});
```

This is different from `hypothesize`:

- `hypothesize` = "what are possible root causes?"
- `explore_paths` = "solve this problem using different approaches and compare"

**Integration with existing**:

- Use utility model for path exploration (cheaper)
- Fuse results via voting or confidence weighting
- Track which strategy works best per task type

**Effort**: Medium (~120 lines)
**Risk**: Medium (cost: 2-3× tokens for exploration)

---

### Improvement 5: Memory Condensation (Decocted Experience)

**Source**: "Decocted Experience: Distilling Long Trajectories into Compact Memory for LLM Agents" (2604.03213)

**What the paper found**:

- Long trajectories overwhelm context window
- Memory condensation: abstract key insights, discard details
- Three methods: Exemplar Mining (state-action pairs), Transition Tree (non-Markov states), Socratic Compression (Q&A pairs)
- Context window used 64-81% more efficiently

**pi-braid gap**: `session-recall` injects past insights raw. No condensation. For long sessions, this bloats the prompt.

**Implementation**: Add a `condense` step to session-recall:

```typescript
// Before injecting past insights:
const condensed = await condenseInsights(insights, {
  method: "exemplar|transition-tree|socratic",
  maxTokens: 1000,
});
```

**Integration with existing**:

- Extend `session-recall` with condensation options
- Use utility model for compression
- Track condensation quality (do insights still help?)

**Effort**: Medium (~100 lines)
**Risk**: Low (additive, raw insights still available)

---

### Improvement 6: Process Supervision (Loop, Think, Generalize)

**Source**: "Loop, Think, & Generalize: Recurrent-Depth Transformers Enable Systematic Generalization" (2604.07822)

**What the paper found**:

- Supervise intermediate loop states, not just final output
- Enables depth extrapolation (train on N loops, test on N+k)
- Each loop iteration refines the representation

**pi-braid gap**: No supervision of intermediate reasoning steps. The agent generates a chain of thought but doesn't verify each link.

**Implementation**: Add a `step_check` mechanism to reasoning:

```typescript
// After each reasoning step:
step_check({
  step: "just-completed-step",
  nextStep: "planned-next-step",
  consistency: "does this follow logically?",
});
```

This runs automatically (not as a tool call) via the reasoning extension.

**Integration with existing**:

- Extend `reasoning` extension with step-checking
- Use lightweight heuristics (keyword matching, logical connectors)
- Escalate to `verify` tool for suspicious steps

**Effort**: Medium (~100 lines)
**Risk**: Low (heuristic-based, cheap to run)

---

## 3. Implementation Priority

| Priority | Improvement                              | Effort     | Impact | Status         |
| -------- | ---------------------------------------- | ---------- | ------ | -------------- |
| 1        | **Recursive Verification** (verify tool) | Medium     | High   | ✅ IMPLEMENTED |
| 2        | **Budget-Aware Planning**                | Medium     | High   | Pending        |
| 3        | **Fast/Slow Routing (ODAR)**             | Low-Medium | Medium | ✅ IMPLEMENTED |
| 4        | **Memory Condensation**                  | Medium     | Medium | Pending        |
| 5        | **Process Supervision**                  | Medium     | Medium | Pending        |
| 6        | **Exploratory Reasoning**                | Medium     | High   | Pending        |

---

## 4. Integration Architecture

The improvements form a **reasoning loop**:

```
User Input
    ↓
[Fast/Slow Router] ──quick──→ [Direct Response]
    │ complex
    ↓
[Planner] ──budget-aware──→ [Goal Tree]
    ↓
[Exploratory Reasoning] ──multi-path──→ [Candidate Solutions]
    ↓
[Recursive Verification] ──verify──→ [Validated Solution]
    ↓
[Process Supervision] ──step-check──→ [Consistent Chain]
    ↓
[Memory Condensation] ──store──→ [Compact Insights]
    ↓
[Finalize]
```

Each box is an existing or proposed pi-braid extension. The loop can iterate:

- Verification fails → back to reasoning
- Budget exceeded → simplify or abort
- Inconsistency found → re-explore

---

## 5. Verification Plan

After implementing each improvement:

```bash
# Test with the benchmark
python3 evaluation/benchmark_multi_turn.py --config braid-full --trials 3

# Test with a complex multi-step task
python3 evaluation/benchmark_multi_turn.py --config braid-full --problems flatten_deep --trials 5

# Check for regression (should still pass)
python3 evaluation/benchmark_multi_turn.py --config no-bash --trials 3
```

Track:

- Task completion rate
- Average tokens per task
- Number of reasoning steps
- Verification pass rate

---

## 6. What NOT to Implement

Based on the research audit:

1. **Full multi-agent systems** (for now): Single-agent with recursive reasoning ≈ multi-agent for many tasks. The "Single Agent as Effective as Multi-Agent" paper (2604.08734) shows this.

2. **Complex training regimes**: Poly-EPO's RL training is out of scope for a harness. Use utility model for exploration instead.

3. **Environmental curiosity**: The exploration gap research (2604.08820) is interesting but niche. Most coding tasks don't need open-ended exploration.

4. **Role conditioning** (Three Roles One Model): The 73% improvement is training-based, not harness-level.

---

## References

- 2604.10980 — Agentic Verifier (multi-turn verification)
- 2604.13408 — BAVT (budget-aware tree search)
- 2604.08890 — ODAR (fast/slow routing)
- 2604.17094 — Poly-EPO (exploratory reasoning)
- 2604.03213 — Decocted Experience (memory condensation)
- 2604.07822 — Loop, Think, Generalize (process supervision)
- 2604.08734 — Single Agent = Multi-Agent
