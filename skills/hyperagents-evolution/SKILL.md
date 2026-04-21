---
name: hyperagents-evolution
description: "Run self-improving experiments using archive-based evolution with staged evaluation and diversity-preserving parent selection. Use when evolving agents, running improvement loops with archives, or optimizing with staged evaluation."
---

# Hyperagents-Inspired Evolution

Self-improving experiment loop combining archive-based evolution with staged evaluation.

Based on: [Hyperagents (arXiv:2603.19461)](https://arxiv.org/abs/2603.19461)

---

## Core Mechanism

Archive-based evolution differs from hill-climbing by storing ALL experiment variants, not just the best. This enables lineage tracking and the ability to revisit previous approaches.

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

## Tools

| Tool | Purpose |
|------|---------|
| `init_evolution` | Initialize archive with config |
| `run_variant` | Run probe + optional full eval |
| `log_variant` | Record result in archive |
| `select_parent` | Select next parent (uses diversity penalty) |
| `show_archive` | Display lineage and scores |
| `run_evolution_loop` | Full automated loop |

---

## Loop Behavior

The loop continues until interrupted. Improvements in the primary metric are kept; worse results are discarded. Every run is annotated: what was tried, what worked, what failed. The diversity penalty means reverting the same idea repeatedly signals a dead end — try a different direction.

**Confidence threshold**: ≥2× noise floor indicates likely real improvement.

**For pi specifically**: Archives store successful patterns and heuristics. Parent selection uses diversity scoring. Probes save compute on unpromising directions.

---

## Example Session

```
> init_evolution({
  goal: "Optimize tokenizer performance",
  command: "./benchmark.sh --num_samples {samples}",
  primaryMetric: "latency_ms",
  lowerIsBetter: true,
  probeSize: 0.1,
  threshold: 0.5
})

> run_variant({ description: "Initial baseline" })
# Probe: latency_ms=45ms → Full: latency_ms=42ms

> log_variant({
  primaryMetric: 42,
  secondaryMetrics: { throughput: 1000 },
  changes: ["tokenizer.py - Added fast path"]
})

> select_parent({ method: "score_child_prop" })
# Selected: init-1 (score=42, children=0)

> run_variant({ parentId: "init-1", description: "Try BPE instead of char-level" })
# ...
```

---

## Key Properties

- **Self-referential**: The meta-agent can modify both itself and the task agent
- **Cross-domain**: Improvements in one domain transfer to others
- **Persistent**: Archive persists across runs — cumulative learning
- **Meta-modifiable**: Even the improvement mechanism can be improved
