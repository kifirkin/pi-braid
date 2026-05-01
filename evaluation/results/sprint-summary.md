# Overnight Sprint — Benchmark Results Summary

Generated: 2026-05-01T20:31:19.970Z

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
*No BR4 results yet*

## PB4: Compliance Behavior
*No PB4 results yet*

## Overnight Test Suite (openrouter/qwen/qwen3.5-flash)
Iterations: 35 | Passed: 24/35 (69%)
Avg duration: 35.5s

| Task | Pass Rate | Avg Duration |
|------|-----------|--------------|
| basic_tool_chain | 100% | 16.4s |
| memory_recall_and_store | 100% | 14.9s |
| enforcement_check | 60% | 33.2s |
| analytics_query | 0% | 60.0s |
| context_pressure | 100% | 31.6s |
| tool_addiction_test | 100% | 14.4s |
| self_reflection | 50% | 40.8s |
| hypothesize | 25% | 83.3s |

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