---
name: meta-improvement
description: "Use when a skill change has to be measured rather than assumed: run self-improving experiments and measure skill performance. Covers archive-based evolution with staged evaluation, and testing improvements against baselines. Not for authoring a skill; `skill-authoring` owns the file, its frontmatter and its trigger phrases."
triggers:
  - "self-improvement experiment"
  - "archive-based evolution"
  - "staged evaluation"
  - "skill performance"
validated: 2026-08-16
verdict: KEEP
---

# Meta-Improvement

Run self-improving experiments against an archive that keeps every variant, not just the best.

Authoring a skill is a different job: `skill-authoring` covers the file, its frontmatter, its trigger phrases, and the run that proves both. This file owns the loop that compares versions of one.

## Self-Improving Experiments

Based on: [Hyperagents (arXiv:2603.19461)](https://arxiv.org/abs/2603.19461)

### Core Mechanism

Archive-based evolution stores ALL experiment variants, not just the best. This enables lineage tracking and revisiting previous approaches.

Staged evaluation adds a quick probe before expensive full runs:

- **Probe**: ~10% of samples (~1-5 min)
- **Full**: Only if probe passes threshold (~10-60 min)
- **Skip**: Probe below threshold → skip full eval

Diversity-preserving selection penalizes over-explored nodes:

```
combined_score = probe_score × exp(-(children/8)³)
```

This prevents premature convergence on local optima.

### Config

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

## Files in Scope

<What the agent can modify>

## Constraints

<Tests, types, etc. that must pass>
```

### Manual Loop (Bash equivalents)

```bash
# Init: create archive dir and config
mkdir -p archive/variants
cp evolution-config.md archive/

# Run probe
./benchmark.sh --num_samples 3 > archive/variants/probe-1.log 2>&1

# Log result
echo "variant-1: probe=42ms full=40ms" >> archive/log.md

# Select parent: best-scoring variant with fewest children
cat archive/log.md | grep "^variant" | sort -t'=' -k2 -n | head -1

# Run full eval
./benchmark.sh --num_samples 30 > archive/variants/full-2.log 2>&1
```

### Loop Behavior

Continues until interrupted. Improvements in the primary metric are kept; worse results are discarded. Every run is annotated. Reverting the same idea repeatedly signals a dead end - try a different direction.

**Confidence threshold**: ≥2× noise floor indicates likely real improvement.

### Key Properties

- **Self-referential**: The meta-agent can modify both itself and the task agent
- **Cross-domain**: Improvements in one domain transfer to others
- **Persistent**: Archive persists across runs - cumulative learning
- **Meta-modifiable**: Even the improvement mechanism can be improved

---

## Storage

- `~/.pi/agent/skills/` - User-level skills
- `./.pi/skills/` - Project-level skills
- Builtin skills - Packaged with pi
