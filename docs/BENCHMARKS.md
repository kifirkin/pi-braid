# Benchmark Suite

## Overview

pi-braid's benchmark suite validates all core features across 5 categories. Run with:

```bash
python3 evaluation/benchmark_comprehensive.py --all
```

**Latest run**: v0.18.0 (commit `e12c536`)
**Model**: openrouter/qwen/qwen3.5-flash-02-23
**Pass rate**: **12/12 (100%)**

## Benchmark Categories

| Category | Tests | Status |
|----------|-------|--------|
| **Core** | tool_execution, self_reflection, memory_episodes | ✅ 3/3 |
| **Metacognition** | cross_session_learning, tool_addiction_detection | ✅ 2/2 |
| **Policy** | latent_activator_on, multi_turn_debugging | ✅ 2/2 |
| **Infrastructure** | session_rotation, npm_test_suite, typescript_check | ✅ 3/3 |
| **Research** | BR4 (latent), BM1 (multi-turn debug) | ✅ 2/2 |

## Feature Test Details

### Core Tests

| Test | Description | Expected |
|------|-------------|----------|
| `core_tool_execution` | Basic read/grep/think workflow | Success, tool calls logged |
| `self_reflection` | MARS reflector + belief policy recommendations | Reflection signals emitted |
| `memory_episodes` | Cognitive memory episode recording | Episodes persisted |

### Metacognition Tests

| Test | Description | Expected |
|------|-------------|----------|
| `cross_session_learning` | Dreamer detects recurring patterns | Pattern insight added |
| `tool_addiction_detection` | Analytics auto-trigger on turn % 10 === 0 | Addiction warning whispered |

### Policy Tests

| Test | Description | Expected |
|------|-------------|----------|
| `latent_activator_on` | Latent activator strategic nudges | At least 1 nudge triggered |
| `multi_turn_debugging` | BM1: bug diagnosis → fix → verification loop | Fix quality >= 0.5 |

### Infrastructure Tests

| Test | Description | Expected |
|------|-------------|----------|
| `session_rotation` | Deep conversation triggers rotation | New session created |
| `npm_test_suite` | All 18 runtime tests | 0 failures |
| `typescript_check` | `tsc --noEmit --skipLibCheck` | 0 errors |

## Research Benchmark Scripts

### BR4: Latent Activator Multi-Turn Test
Evaluates whether identity-based latent activation affects multi-turn problem-solving. Compares 3 trials across `A_braid_latent` vs `C_baseline` configurations.

**Output**: `evaluation/results/br4_<timestamp>.md`
**Latest**: v0.18.0 — 100% solve rate, no compliance regression

### BM1: Multi-Turn Debugging Benchmark
Measures multi-turn debugging capability on 3 bug classes: race conditions, memory leaks, null references. Tracks fix quality and turn count.

**Output**: `evaluation/results/bm1_<timestamp>.md`
**Latest**: v0.18.0 — 100% success, 50% fix quality avg

## CI Integration

Add to CI pipeline:

```yaml
- name: Run benchmarks
  run: |
    python3 evaluation/benchmark_comprehensive.py --all
    # Fail if pass rate < 100%
```

## Interpreting Results

- **PASS**: Feature works end-to-end
- **FAIL**: Script error or timeout — check stderr in output file
- **TIMEOUT**: Increase `--timeout` for slower models

## Version History

| Version | Benchmark Status | Notes |
|---------|-----------------|-------|
| v0.15.0–v0.15.1 | BR4/BM1 syntax fixes | Scripts compile |
| v0.16.0 | Lib docs complete | Infrastructure |
| v0.17.0 | Features added | Addiction, tree, dreamer, daemon |
| **v0.18.0** | **12/12 passed** | **Comprehensive suite established** |
