# PI-BRAID Tool Improvements Validation Protocol

**Based on:** Utility model feedback on test design  
**Date:** 2026-04-17  
**Purpose:** Design empirical validation before implementation

---

## I. GROUND TRUTH FRAMEWORK

### Problem
Testing metacognitive self-assessment is circular without external scoring.

### Solution: External Evaluation Layer

```typescript
interface ExternalEvaluator {
  // Score task completion objectively
  score_completion(result: any, expected: any): number; // 0-1
  
  // Score reasoning quality
  score_reasoning(trace: ThinkResult[]): {
    logical_soundness: number;      // 0-1
    completeness: number;           // 0-1
    coherence: number;              // 0-1
  };
  
  // Compare self-assessment to reality
  calibrate(self_confidence: number, actual_score: number): {
    calibration_error: number;
    direction: 'over' | 'under' | 'calibrated';
  };
}
```

### Calibration Metric
```
Calibration Error = |self_confidence - actual_score| / actual_score
```
- Target: < 10% calibration error
- Above 20%: metacognitive signal is miscalibrated

---

## II. BASELINE & CONTROL DESIGN

### Required Comparison
| System | Condition | What to Measure |
|--------|-----------|-----------------|
| **Baseline** | Current think() | Accuracy, latency, token use, failure modes |
| **Control** | Modified with depth=None | Same metrics |
| **Treatment** | Modified with depth=high | Same metrics |

### Metrics Matrix
```
                    Accuracy    Latency    Token Use    Failure Rate
Baseline (current)     X           X           X              X
Control (no depth)      X           X           X              X  
Treatment (depth=high)  X           X           X              X
```

### Statistical Requirements
- Minimum 50 tasks per condition (power analysis)
- Random selection of tasks from real-world distribution
- Blind evaluation where possible

---

## III. STRESS TEST DESIGN

### Boundary Conditions

| Condition | What to Test | Success Criteria |
|-----------|--------------|------------------|
| **Depth=minimal** | Does agent still solve? | >80% accuracy |
| **Depth=max** | Does it ever stop? | Completes in <5x expected time |
| **Ambiguous prompt** | Graceful degradation | Reports uncertainty, no hallucination |
| **Adversarial prompt** | Prompt injection attempt | Rejects, logs, continues safely |
| **Multi-turn Round 2+** | Error accumulation | <5% degradation per round |
| **Empty context** | Cold start | Falls back to parametric, no crashes |

### Adversarial Prompt Set
From benchmark integrity research:
- NL disguised attacks
- Roleplay attempts
- Hypothetical framing
- Authority spoofing

### Failure Mode Taxonomy
```typescript
type FailureMode = 
  | 'hallucination'      // Confident but wrong
  | 'underconfidence'   // Uncertain even when correct
  | 'infinite_loop'      // Depth causes non-termination
  | 'context_explosion'  // Token bloat
  | 'security_breach'   // Prompt injection succeeds
  | 'cascade_failure'    // One error amplifies
```

---

## IV. QUALITY-EFFICIENCY PARETO FRONTIER

### Measurement Protocol

1. **Vary depth across 5 levels**: minimal, low, medium, high, max
2. **For each level, measure**: token_count, accuracy_score, latency_ms
3. **Plot Pareto frontier**: accuracy(y) vs token_count(x)

### Expected Output
```
Token Reduction % →
|
|        *
|      *     *     ← Pareto optimal
|    *             *
|   *                 ← Trade-off zone
|________________________
Accuracy % (threshold at 95%)
```

### Acceptance Criteria
- Pareto frontier must intersect 95% accuracy threshold
- At intersection point, token reduction must be >40%
- Below 90% accuracy: system is not production-ready

---

## V. A/B EVALUATION PROTOCOL

### Sample Selection
```
Real-World Prompt Distribution:
- Simple (answerable in 1 turn): 40%
- Medium (requires 2-5 turns): 40%
- Complex (requires >5 turns): 20%
```

### Automated Evaluation
```typescript
interface LLMJudge {
  evaluate(
    prompt: string,
    response: string,
    rubric: Rubric
  ): {
    score: number;
    reasoning: string;
    confidence: number;
  };
}

interface Rubric {
  criteria: string[];
  weights: number[];
  adversarial_checks: string[];
}
```

### Human Review Sampling
- 10% of outputs get human review
- Focus on: failure cases, edge cases, adversarial attempts

---

## VI. TEST IMPLEMENTATION PLAN

### Phase 1: Baseline Capture
1. Run 100 representative tasks with current think()
2. Capture: accuracy, tokens, latency, failure modes
3. Compute calibration baseline: self_confidence vs actual_score

### Phase 2: Control Validation
1. Implement think() v2 with depth=None
2. Run same 100 tasks
3. Verify no regression from baseline

### Phase 3: Depth Sweep
1. Test depth across 5 levels
2. Generate Pareto frontier
3. Identify optimal depth settings per task type

### Phase 4: Stress Tests
1. Run adversarial prompt set
2. Measure multi-turn degradation
3. Verify graceful degradation

### Phase 5: Integration
1. Add telemetry
2. Test with real workflows
3. Validate end-to-end improvements

---

## VII. METRICS DASHBOARD

### Real-time Metrics
```typescript
interface MetricsDashboard {
  // Efficiency
  tokens_per_task: number;
  latency_p50: number;
  latency_p95: number;
  
  // Quality  
  accuracy: number;
  calibration_error: number;
  
  // Safety
  security_incidents: number;
  prompt_injection_escaped: number;
  
  // Evolution
  performance_trend: number;  // vs previous period
  error_patterns: string[];
}
```

### Alerts
| Metric | Threshold | Action |
|--------|-----------|--------|
| Calibration error | >20% | Recalibrate metacognition |
| Token bloat | >2x baseline | Review depth settings |
| Accuracy drop | >5% | Rollback or investigate |
| Security incident | >0 | Immediate escalation |

---

## VIII. SUCCESS CRITERIA

### Must Pass
- [ ] Baseline established (100 tasks, all metrics)
- [ ] Control shows no regression
- [ ] Depth=high achieves >95% accuracy
- [ ] Token reduction at 95% accuracy threshold >40%
- [ ] Calibration error <15% for high-confidence predictions
- [ ] Adversarial prompts rejected >90%
- [ ] Multi-turn Round 2 degradation <5%

### Should Pass
- [ ] Pareto frontier is smooth (no erratic jumps)
- [ ] Stress tests show graceful degradation
- [ ] Telemetry captures all required signals

### Nice to Have
- [ ] Human review confirms automated evaluation
- [ ] Cross-task type calibration consistent
- [ ] Cross-model calibration consistent

---

## IX. TOOL-SPECIFIC TESTS

### think() v2 Specifics

```typescript
// Test: Does depth parameter work?
const test_depth_control = async () => {
  const depths = ['minimal', 'low', 'medium', 'high', 'max'];
  const results = [];
  
  for (const depth of depths) {
    const result = await run_with_think({
      task: COMPLEX_TASK,
      depth
    });
    results.push({
      depth,
      tokens: result.token_count,
      accuracy: result.accuracy,
      latency: result.latency
    });
  }
  
  // Assert: Higher depth = higher accuracy (diminishing returns)
  // Assert: Token cost scales sub-linearly with depth
};

// Test: Does metacognitive check work?
const test_metacognition = async () => {
  const evaluator = new ExternalEvaluator();
  
  // Run 50 tasks
  for (const task of TASKS) {
    const result = await run_with_think({
      task,
      metacognitive_check: true
    });
    
    const actual = evaluator.score_completion(result, task.expected);
    const error = evaluator.calibrate(result.confidence, actual);
    
    // Assert: Error < 15% for 80% of tasks
    // Assert: Direction is consistent (not systematically over/under)
  }
};
```

### memory_recall() v2 Specifics

```typescript
// Test: Does relevance scoring work?
const test_relevance_scoring = async () => {
  const results = await memory_recall({
    query: 'debugging prompt injection',
    current_context: 'testing adversarial prompts'
  });
  
  // Assert: Top results relate to security/benchmark
  // Assert: Relevance scores decrease monotonically
  
  // Compare to recall without context
  const results_no_context = await memory_recall({
    query: 'debugging prompt injection'
  });
  
  // Assert: Results with context are more relevant (human evaluation)
};
```

### outcome_tracker Specifics

```typescript
// Test: Does tracking improve future performance?
const test_outcome_tracking = async () => {
  const tracker = new OutcomeTracker();
  
  // Phase 1: Run 50 tasks without tracking
  const baseline = await run_tasks(50);
  
  // Phase 2: Run 50 tasks with tracking
  tracker.start();
  const with_tracking = await run_tasks(50);
  
  // Phase 3: Retrieve learnings for similar task type
  const learnings = tracker.get_learnings('code_generation');
  
  // Assert: with_tracking accuracy > baseline
  // Assert: learnings are specific and actionable
};
```

---

## X. NEXT STEPS

1. **Implement ExternalEvaluator** (ground truth layer)
2. **Build metrics capture** into current system
3. **Run baseline capture** (100 tasks)
4. **Design adversarial prompt set** from benchmark integrity research
5. **Implement think() v2** incrementally, testing at each phase