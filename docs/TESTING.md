# Testing Guide

## Running Tests

```bash
# Run all tests
node test/runtime/test-all.mjs

# Run specific test
node test/runtime/test-<name>.mjs

# Run with verbose output
node test/runtime/test-<name>.mjs --verbose
```

## Test Files (22)

| Test | Purpose | Key Coverage |
|------|---------|--------------|
| `test-all.mjs` | Run all tests | Master runner |
| `test-integration.mjs` | Integration tests | Multi-extension interactions |
| `test-verification.mjs` | verify_claim, verify_decomposition | Claim verification logic |
| `test-finalize-bcr.mjs` | Finalize boundary conditions | Auto-finalize, tasks remaining |
| `quick-benchmark.mjs` | Benchmark harness | Timing, RPC mode |
| `test-memory-stores.mjs` | Three memory stores | Episodes, heuristics, tool stats |
| `test-goal-state-persistence.mjs` | Goal persistence | Memory across sessions |
| `test-metacognition-handlers.mjs` | Metacognition handlers | Cognition_evaluate |
| `test-cognition-evaluator.mjs` | Cognition evaluator | Heuristic evaluation |
| `test-context-manager-handlers.mjs` | Context manager handlers | Pruning, compaction |
| `test-harness.mjs` | Test harness | Self-testing the harness |
| `test-nudge-dedup.mjs` | Nudge deduplication | Duplicate suppression |
| `test-web-fetch-headers.mjs` | Web fetch headers | Header safety |
| `test-conflict-qa.mjs` | Conflict QA | Question generation |
| `test-evidence-pool.mjs` | Evidence pool | Evidence tracking |
| `test-browser-screenshot.mjs` | Browser screenshot | Screenshot pipeline |
| `test-heartbeat.mjs` | Heartbeat scheduler | Heartbeat timing |
| `test-pdf-safety.mjs` | PDF safety | PDF validation |
| `test-reasoning-metrics.mjs` | Reasoning metrics | Metric tracking |
| `test-error-classifier.mjs` | Error classifier | Error categorization |
| `verify-async.mjs` | Async extension state | Async state factory |
| `test-topic-drift.mjs` | Topic drift | Drift detection |

## Writing New Tests

```javascript
// test/runtime/test-my-feature.mjs
import { test, describe } from "node:test";
import { deepEqual } from "node:assert";

// Agent RPC harness pattern:
async function runAgent(message) {
  // Start agent, send message, collect events
}

// Test pattern:
test("my feature", async () => {
  const result = await runAgent("test message");
  deepEqual(result.toolCalls, ["expected-tool"]);
});
```

## Test Harness Pattern (from agent-testing SKILL.md)

```javascript
// Python harness for benchmarks
// See skills/agent-testing/SKILL.md for full pattern
```

## Coverage Notes

- Enforcement: 17 tests in v0.13.0
- Memory stores: 21 tests
- Total: ~85 tests across all test files
- No test coverage: enforcement handlers, heartbeat recaller/dreamer, context-lifecycle policies
