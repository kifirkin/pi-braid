# pi-braid Evaluation Suite

Research benchmarks and test harnesses for pi-braid agent performance.

## Benchmarks

### BM1: Multi-Turn Debugging (`bm1_multi_turn_debug.py`)

Research benchmark for multi-turn debugging capability.

**Design**: Bug-fixing task with phases: Read → Propose → Test (fail) → Debug → Fix → Pass

**Metrics**: Diagnosis accuracy, Fix quality, Over-fix avoidance, Multi-turn persistence

**Tasks**: Race conditions, memory leaks, null references in Python/JavaScript

**Usage**:

```bash
python3 bm1_multi_turn_debug.py --model openrouter/qwen/qwen3.5-flash-02-23
python3 bm1_multi_turn_debug.py --task bug-race-condition --timeout 120
```

### BM2: Code Quality (`bm2_code_quality.py`)

Assesses code quality beyond pass/fail.

**Metrics**: eslint score, Cyclomatic complexity, Edge case coverage, Documentation, Idiomatic usage

**Usage**:

```bash
python3 bm2_code_quality.py --code "function foo() {}" --language javascript
```

### BR4: Latent Activator Multi-Turn (`br4_latent_multi_turn.py`)

Research question: Does identity framing work in multi-turn vs single-shot?

**Configs**: A (pi-braid + latent), C (baseline/no extensions)

**Metrics**: Solve rate, Token usage, Compliance behaviors, Multi-turn persistence

**Usage**:

```bash
python3 br4_latent_multi_turn.py --task "debug this code..." --trials 3
```

### pi_rpc_benchmark.py

Core RPC harness for running pi in RPC mode and collecting structured metrics.

**Usage**:

```bash
python3 pi_rpc_benchmark.py --prompt "task" --extensions /path/to/braid --trials 3 --compare
```

### run_benchmarks.py

Master runner that executes all benchmarks and generates consolidated reports.

**Usage**:

```bash
python3 run_benchmarks.py --all
python3 run_benchmarks.py --quick           # Fast sanity check
python3 run_benchmarks.py --bm1            # Multi-turn debugging
python3 run_benchmarks.py --br4 --task "..."  # Latent activator
```

## Environment Variables

```bash
PI_MODEL=openrouter/qwen/qwen3.5-flash-02-23    # Model to use
PI_EXTENSIONS=/path/to/pi-braid                  # Extensions path
```

## Output

Results are saved to:

- `results/summary_*.md` — Consolidated markdown report
- `results/raw_*.json` — Raw benchmark data

## Research Notes

### BM1 Design Rationale

Current benchmarks are single-shot. pi-braid is designed for multi-turn.
BM1 tests whether the agent can:

1. Track state across turns (multi-turn persistence)
2. Learn from test failures (adaptation)
3. Avoid over-fixing (proportionality)

### BR4 Design Rationale

The implicit-framing research showed identity framing +4pp effectiveness vs single-shot.
BR4 tests whether this extends to multi-turn scenarios where state must be maintained.

### Compliance Behavior Detection

Patterns that indicate directive-following vs identity-driven behavior:

- `excessive_verification`: "verify again", "check again"
- `over_confirmation`: "I need to confirm", "Let me verify"
- `rule_anchoring`: "According to the guidelines", "As per the prompt"
- `defensive`: "Sorry", "apologies", "excuse me"

Lower compliance behavior count suggests more identity-driven (authentic) responses.
