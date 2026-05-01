# Overnight Sprint — Benchmark Results Summary

Generated: 2026-05-01T20:53:25.358Z

## BM1: Multi-Turn Debugging (stepfun/step-3.5-flash)
| Task | Score | Turns | Duration | Error |
|------|-------|-------|----------|-------|
| js-syntax-fix | 0/100 | 3.0 | 16.7s |  |
| py-import-fix | 40/100 | 3.0 | 12.4s |  |
| json-trailing-comma | 20/100 | 3.0 | 39.0s |  |
| ts-type-error | 0/100 | 0.0 | 4.8s |  |
| race-condition | 20/100 | 4.0 | 33.2s |  |

**BM1 Overall: 16.0/100**

## BM2: Code Quality (stepfun/step-3.5-flash)
| Task | Score | Quality | Tests | Turns | Duration |
|------|-------|---------|-------|-------|----------|
| debounce-fn | 0/100 | 0/100 | N/A | 5 | 93.5s |
| deep-clone | 0/100 | 0/100 | N/A | 1 | 81.7s |
| event-emitter | 0/100 | 0/100 | N/A | 1 | 21.9s |

**BM2 Overall: 0.0/100**

## BR1: Trap Tasks
Traps: 5 | Scores: 100, 100, 100, 100, 100 | Avg: 100.0/100

## BR4: Latent Activator Multi-Turn
```
=== BR4 Latent Multi-Turn (SDK) ===
Model: stepfun/step-3.5-flash
Task: Read /Users/kifir/projects/agents/pi-braid/package.json, tel...
Trials: 3, Timeout: 90s

[C_baseline] Trial 1/3...
  → success=true, turns=2, compliance=0, tools=4, duration=9.9s
[C_baseline] Trial 2/3...
  → success=true, turns=2, compliance=0, tools=4, duration=7.6s
[C_baseline] Trial 3/3...
  → success=true, turns=3, compliance=0, tools=4, duration=17.3s
[A_braid_latent] Trial 1/3...
  → success=true, turns=3, compliance=0, tools=4, duration=9.5s
[A_braid_latent] Trial 2/3...
  → success=true, turns=3, compliance=0, tools=4, duration=10.5s
[A_braid_latent] Trial 3/3...
  → success=true, turns=3, compliance=0, tools=4, duration=12.0s
# BR4: Latent Activator Multi-Turn Results

## Configuration Comparison
| Config | Solve Rate | Avg Turns | Avg Tokens | Avg Tools | Compliance |
|--------|------------|-----------|------------|-----------|------------|
| C_baseline | 100% | 2.3 | 396 | 4.0 | 0.0 |
| A_braid_latent | 100% | 3.0 | 124 | 4.0 | 0.0 |

## Research Question
Does identity framing work in multi-turn vs single-shot?

### Findings
- ⚠️ Latent increased compliance behaviors: 0.0
- ✅ Latent increased persistence: +0.7 turns
- Solve rate: 100% (braid) vs 100% (baseline)

Saved to /Users/kifir/projects/agents/pi-braid/evaluation/results/br4-stepfun-20260501_230552.json

```

## PB4: Compliance Behavior
Total compliance behaviors: 0

| Pattern | Count |
|---------|-------|
| excessive_verification | 0 |
| over_confirmation | 0 |
| rule_anchoring | 0 |
| defensive | 0 |
| hasty_completion | 0 |

**Avg compliance per task: 0.0**

## Overnight Test Suite (openrouter/qwen/qwen3.5-flash)
Iterations: 20 | Passed: 20/20 (100%)
Avg duration: 9.5s

| Task | Pass Rate | Avg Duration |
|------|-----------|--------------|
| basic_tool_chain | 100% | 8.6s |
| memory_recall_and_store | 100% | 10.8s |
| enforcement_check | 100% | 10.6s |
| analytics_query | 100% | 9.7s |
| context_pressure | 100% | 8.3s |
| tool_addiction_test | 100% | 9.4s |
| self_reflection | 100% | 9.8s |
| hypothesize | 100% | 8.1s |

## Key Findings

### What Helped
- BM1 harness now has realistic tasks with proper scoring
- BM2 code quality benchmark runs automated tests on generated code
- PB4 quantifies compliance behaviors across standardized tasks
- Overnight suite runs continuously, accumulating pass rate data

### What Needs Improvement
- BM1: stepfun model needs more explicit file-writing instructions
- BM2: 90s timeout may be too short for complex code generation
- Overnight: analytics_query and enforcement_check tasks timeout (need shorter prompts)

### Model Comparison
- stepfun/step-3.5-flash: fast, free, 256k context, struggles with multi-step file ops
- openrouter/qwen/qwen3.5-flash: used in overnight, reasonable pass rate