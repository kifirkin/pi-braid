---
name: hyperagents-evolution
description: "Run self-improving experiments using archive-based evolution with staged evaluation and diversity-preserving parent selection. Use when evolving agents, running improvement loops with archives, or optimizing with staged evaluation."
---

# Hyperagents-Inspired Evolution

Self-improving experiment loop combining archive-based evolution with staged evaluation.

Based on: [Hyperagents (arXiv:2603.19461)](https://arxiv.org/abs/2603.19461)

---

## Core Mechanism

Archive-based evolution stores ALL experiment variants, not just the best. This enables lineage tracking and revisiting previous approaches.

Staged evaluation adds a quick probe before expensive full runs:
- **Probe**: ~10% of samples (~1-5 min) — fast signal
- **Full**: Only if probe passes threshold (~10-60 min)
- **Skip**: Probe below threshold → skip full eval

Diversity-preserving selection penalizes over-explored nodes:
```
combined_score = probe_score × exp(-(children/8)³)
```

This prevents premature convergence on local optima.

---

## Config

Write `evolution-config.md` before starting:

```markdown
# Evolution: <goal>

## Objective
<What we're optimizing>

## Metrics
- **Primary**: <name> (<unit>, lower/higher is better)
- **Secondary**: <name>, ...

## Command Template
`./benchmark.sh --num_samples {samples}`

## Staged Eval
- Probe size: 10%
- Threshold: 0.4
- <Adjust based on noise and runtime>

## Files in Scope
<What the agent can modify>

## Constraints
<Tests, types, etc. that must pass>
```

---

## Manual Loop (Bash equivalents)

```bash
# Init: create archive dir and config
mkdir -p archive/variants
cp evolution-config.md archive/

# Run probe
./benchmark.sh --num_samples 3 > archive/variants/probe-1.log 2>&1

# Log result
echo "variant-1: probe=42ms full=40ms" >> archive/log.md

# Select parent (diversity penalty)
# Use best-scoring variant with fewest children:
cat archive/log.md | grep "^variant" | sort -t'=' -k2 -n | head -1

# Run full eval
./benchmark.sh --num_samples 30 > archive/variants/full-2.log 2>&1
```

---

## Loop Behavior

The loop continues until interrupted. Improvements in the primary metric are kept; worse results are discarded. Every run is annotated: what was tried, what worked, what failed. Reverting the same idea repeatedly signals a dead end — try a different direction.

**Confidence threshold**: ≥2× noise floor indicates likely real improvement.

---

## Key Properties

- **Self-referential**: The meta-agent can modify both itself and the task agent
- **Cross-domain**: Improvements in one domain transfer to others
- **Persistent**: Archive persists across runs — cumulative learning
- **Meta-modifiable**: Even the improvement mechanism can be improved
