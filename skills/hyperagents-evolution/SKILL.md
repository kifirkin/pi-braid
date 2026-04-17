---
name: hyperagents-evolution
description: "Run self-improving experiments using Hyperagents-inspired patterns: archive-based evolution, staged evaluation, and diversity-preserving parent selection. Use when asked to 'evolve agents', 'run evolution experiments', 'improve in a loop with archives', or 'optimize with staged evaluation'."
---

# Hyperagents-Inspired Evolution

Self-improving experiment loop combining archive-based evolution with staged evaluation.

Based on: [Hyperagents (arXiv:2603.19461)](https://arxiv.org/abs/2603.19461)

## Core Patterns

### 1. Archive-Based Evolution
Store ALL experiment variants, not just the best. This enables:
- Lineage tracking (parent → child relationships)
- Diversity-preserving selection
- Ability to revisit and build on previous approaches

### 2. Staged Evaluation
Quick probe before expensive full evaluation:
- **Probe**: Run on 10% of samples (~1-5 min)
- **Full**: Only if probe looks promising (~10-60 min)
- **Skip**: If probe score < threshold, skip full eval

### 3. Diversity-Preserving Selection
Not just "pick the best" - penalize over-explored nodes:
```
combined_score = score_probability × child_penalty
child_penalty = exp(-(child_count/8)³)
```

This prevents premature convergence on local optima.

## Setup

1. Analyze the problem and write `evolution-config.md`
2. Initialize archive: `init_evolution()`
3. Run baseline: `run_variant()` → `log_variant()`
4. Start evolution loop

### `evolution-config.md`

```markdown
# Evolution: <goal>

## Objective
<What we're optimizing>

## Metrics
- **Primary**: <name> (<unit>, lower/higher is better)
- **Secondary**: <name>, ...

## Command Template
`./benchmark.sh --num_samples {samples}`

## Staged Eval Config
- Probe size: 10%
- Threshold: 0.4
- <Adjust based on noise and runtime>

## Archive Config
- Selection method: score_child_prop
- Storage: ./evolution-archive

## Files in Scope
<What the agent can modify>

## Constraints
<Tests, types, etc. that must pass>
```

## Tools

- **`init_evolution`** - Initialize archive with config
- **`run_variant`** - Run a single experiment variant (probe + optional full)
- **`log_variant`** - Record result in archive
- **`select_parent`** - Select next parent using specified method
- **`show_archive`** - Display archive summary and lineage
- **`run_evolution_loop`** - Run full evolution loop

## Loop Rules

**LOOP FOREVER** until interrupted.

- **Primary metric is king** - improved → keep, worse → discard
- **Annotate every run** - what was tried, what worked, what failed
- **Watch confidence** - ≥2× noise floor = likely real improvement
- **Don't thrash** - if reverting same idea repeatedly, try something different
- **Diversity matters** - score_child_prop prevents local optima

## Example Session

```
> Run evolution on the tokenizer for 20 variants

[1] init_evolution({
  goal: "Optimize tokenizer performance",
  command: "./benchmark.sh --num_samples {samples}",
  primaryMetric: "latency_ms",
  lowerIsBetter: true,
  probeSize: 0.1,
  threshold: 0.5
})

[2] show_archive()
# Archive: 0 variants

[3] run_variant({ description: "Initial baseline" })
# Running probe (10 samples)...
# Probe: latency_ms=45ms
# Running full (100 samples)...
# Full: latency_ms=42ms

[4] log_variant({
  primaryMetric: 42,
  secondaryMetrics: { throughput: 1000 },
  changes: ["tokenizer.py - Added fast path"]
})

[5] select_parent({ method: "score_child_prop" })
# Selected: init-1 (score=42, children=0)

[6] run_variant({ parentId: "init-1", description: "Try BPE instead of char-level" })
...
```

## Key Insights from Hyperagents

1. **Self-referential improvement**: The meta-agent can modify itself AND the task agent
2. **Cross-domain transfer**: Improvements in one domain can transfer to others
3. **Persistent memory**: Archive persists across runs, enabling cumulative learning
4. **Meta-level modification**: Even the improvement mechanism itself can be improved

For pi, this means:
- Archives can store successful patterns/heuristics
- Parent selection can use diversity, not just score
- Probes save compute on unpromising directions
