# PI-BRAID Metacognition Ablation Study

**Purpose:** Empirically validate think() tool improvements  
**Based on:** Live testing + utility model feedback  
**Date:** 2026-04-17

---

## I. ABLATION MATRIX

| Condition    | depth | utility_model | Variables Changed |
| ------------ | ----- | ------------- | ----------------- |
| **baseline** | -     | false         | Control           |
| **A**        | quick | false         | +depth only       |
| **B**        | deep  | false         | +deep only        |
| **C**        | quick | true          | +utility only     |
| **D**        | deep  | true          | +depth + utility  |

### Hypotheses

| Comparison    | What It Tests                    |
| ------------- | -------------------------------- |
| A vs baseline | Does depth parameter alone help? |
| B vs baseline | Does deep reasoning alone help?  |
| C vs baseline | Does utility model alone help?   |
| D vs baseline | Does combined approach help?     |
| D vs (A+B+C)  | Is there synergy?                |

### Marginal Contributions

```
depth_contribution = (A + B) / 2 - baseline
utility_contribution = C - baseline
synergy = D - (A + B + C - baseline)
```

---

## II. METRICS TO TRACK

### Primary Metrics

| Metric         | Formula                     | Target   |
| -------------- | --------------------------- | -------- |
| **Accuracy**   | Correct completions / Total | >95%     |
| **Token Cost** | Total tokens per task       | Minimize |
| **Latency**    | Wall-clock time             | Minimize |

### Secondary Metrics

| Metric                  | Formula                   | Target   |
| ----------------------- | ------------------------- | -------- |
| **Brier Score**         | (confidence - accuracy)²  | <0.1     |
| **Tool Efficiency**     | Task success / Tool calls | Maximize |
| **Reasoning Stability** | Variance across runs      | Minimize |

### Calibration Metrics

| Metric                | Formula                    | Target              |
| --------------------- | -------------------------- | ------------------- | --- | ---- |
| **ECE**               | Expected Calibration Error | <0.1                |
| **Calibration Error** |                            | confidence - actual |     | <15% |

---

## III. TEST TASKS

### Task Distribution

| Type    | Count | Expected Tool Calls | Examples                |
| ------- | ----- | ------------------- | ----------------------- |
| Simple  | 40%   | 0-1                 | Read file, find pattern |
| Medium  | 40%   | 2-4                 | Edit + test + verify    |
| Complex | 20%   | 5+                  | Multi-file refactor     |

### Sample Tasks (50 total)

```typescript
const tasks = [
  // Simple (20)
  { id: "s1", type: "simple", expected_tool_calls: 0, prompt: "What files exist in src?" },
  { id: "s2", type: "simple", expected_tool_calls: 1, prompt: "Read the package.json" },

  // Medium (20)
  {
    id: "m1",
    type: "medium",
    expected_tool_calls: 2,
    prompt: "Find all TypeScript files and count lines",
  },
  {
    id: "m2",
    type: "medium",
    expected_tool_calls: 3,
    prompt: "Add error handling to this function",
  },

  // Complex (10)
  {
    id: "c1",
    type: "complex",
    expected_tool_calls: 5,
    prompt: "Refactor this module to use dependency injection",
  },
];
```

---

## IV. IMPLEMENTATION

### Instrumentation Required

```typescript
// Track per think() call
interface ThinkMetrics {
  thought_id: string;
  depth: "quick" | "deep" | null;
  utility_used: boolean;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  parent_id?: string;
}

// Track per task
interface TaskMetrics {
  task_id: string;
  condition: string;
  think_calls: number;
  total_tokens: number;
  total_latency_ms: number;
  tool_calls: number;
  success: boolean;
  accuracy?: number;
}
```

### Ablation Runner

```typescript
async function runAblation(tasks: Task[], conditions: Condition[]) {
  const results: Map<string, TaskMetrics[]> = new Map();

  for (const condition of conditions) {
    const conditionResults = [];

    for (const task of tasks) {
      // Reset state
      clearMetrics();

      // Run with condition
      const result = await runTask(task, condition);
      conditionResults.push(aggregateMetrics(result));
    }

    results.set(condition.name, conditionResults);
  }

  return computeStatistics(results);
}
```

---

## V. ANALYSIS

### Statistical Tests

```typescript
function analyzeResults(results: Map<string, TaskMetrics[]>) {
  const comparisons = [
    { name: "A vs baseline", a: "A", b: "baseline" },
    { name: "B vs baseline", a: "B", b: "baseline" },
    { name: "C vs baseline", a: "C", b: "baseline" },
    { name: "D vs baseline", a: "D", b: "baseline" },
    { name: "Synergy", a: "D", b: "ABC_avg" },
  ];

  for (const { name, a, b } of comparisons) {
    const metricsA = results.get(a);
    const metricsB = results.get(b);

    // T-test for accuracy
    const tTest = computeTTest(
      metricsA.map((m) => m.accuracy),
      metricsB.map((m) => m.accuracy),
    );

    // Effect size (Cohen's d)
    const effectSize = computeCohenD(metricsA, metricsB);

    // Token reduction significance
    const tokenReduction = 1 - avgTokens(metricsA) / avgTokens(metricsB);

    console.log(`${name}: t=${tTest.p}, d=${effectSize}, tokens=${tokenReduction}%`);
  }
}
```

### Decision Criteria

| Finding                         | Interpretation         | Action                     |
| ------------------------------- | ---------------------- | -------------------------- |
| D significantly better than all | Full implementation    | Implement D                |
| A or B better than C            | Depth alone sufficient | Skip utility model         |
| C better than A/B               | Utility model critical | Invest in critique quality |
| No significant difference       | No benefit             | Reconsider metacognition   |

---

## VI. EXPECTED OUTCOMES

### Based on Research

| Research                         | Expected Effect                       |
| -------------------------------- | ------------------------------------- |
| CROP (80.6% reduction)           | depth=quick reduces tokens by 50-80%  |
| Draft-Thinking (82.6% reduction) | Models internalize efficient patterns |
| MetaCrit (quality improvement)   | Utility model catches errors          |
| SMART (24% tool reduction)       | Confidence improves routing           |

### Realistic Expectations

- **Token reduction:** 30-60% (not 80% - overhead exists)
- **Accuracy:** >95% at all depths (CROP validation)
- **Utility model benefit:** Small but measurable on complex tasks
- **Calibration improvement:** 10-20% reduction in calibration error

---

## VII. TIMELINE

| Phase        | Duration | Tasks                                    |
| ------------ | -------- | ---------------------------------------- |
| **Setup**    | 1 day    | Implement instrumentation, define tasks  |
| **Baseline** | 2 hours  | Run 50 tasks with baseline               |
| **Ablation** | 1 day    | Run all 4 conditions × 50 tasks          |
| **Analysis** | 4 hours  | Statistical analysis, visualization      |
| **Decision** | 2 hours  | Interpret results, decide implementation |

**Total:** ~2 days

---

## VIII. STATUS

### Complete

- [x] Live test with think() tool
- [x] Utility model integration works
- [x] Methodological issues identified

### In Progress

- [ ] Design this ablation study

### Next Steps

1. Implement instrumentation
2. Define 50 test tasks
3. Run baseline
4. Run ablation
5. Analyze results

---

## IX. RELATION TO TOOL IMPROVEMENTS PROPOSAL

This ablation validates:

- **think() depth parameter** (H1 from research)
- **ask_utility_model integration** (H2 from research)
- **Confidence calibration** (H3 from research)

Results inform which features to implement in think() v2.
