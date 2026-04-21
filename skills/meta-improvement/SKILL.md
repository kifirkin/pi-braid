---
name: meta-improvement
description: "Create new skills, run self-improving experiments, and measure skill performance. Covers: writing SKILL.md, building skills iteratively, archive-based evolution with staged evaluation, and testing improvements against baselines."
---

# Meta-Improvement

Build skills from experience and run self-improving experiments.

---

## Part 1: Skill Creation

### Core Loop

1. **Understand** — What should this skill enable?
2. **Draft** — Write the SKILL.md
3. **Test** — Run test cases
4. **Evaluate** — Does it trigger correctly? Is guidance clear?
5. **Improve** — Refine based on results
6. **Repeat** — Until satisfied

### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/
    ├── references/
    └── assets/
```

### Frontmatter

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase, hyphens, max 64 chars |
| `description` | Yes | When to trigger + what it does, max 1024 chars |
| `disable-model-invocation` | No | Skip loading to agent prompt |

### Writing the Description

Be specific about triggers — include contexts and user phrases:

```
# WEAK
"Build dashboards."

# SPECIFIC
"Build dashboards to display metrics.
Use when: dashboards, data visualization, metrics,
internal data, charts, graphs, or displaying company data."
```

### Progressive Disclosure

Skills load in layers:
1. **Metadata** — name + description (~100 words)
2. **SKILL.md body** — in context when triggered (<500 lines)
3. **Bundled resources** — loaded as needed

### Testing

Create test cases, run the skill on realistic prompts, compare output to expected.

### Common Issues

| Issue | Fix |
|-------|-----|
| Under-triggering | More specific contexts in description |
| Over-triggering | Narrow description, add exclusions |
| Unclear guidance | Add examples, explain the why |
| Missing edge cases | Add sections for edge cases |

---

## Part 2: Self-Improving Experiments

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

Continues until interrupted. Improvements in the primary metric are kept; worse results are discarded. Every run is annotated. Reverting the same idea repeatedly signals a dead end — try a different direction.

**Confidence threshold**: ≥2× noise floor indicates likely real improvement.

### Key Properties

- **Self-referential**: The meta-agent can modify both itself and the task agent
- **Cross-domain**: Improvements in one domain transfer to others
- **Persistent**: Archive persists across runs — cumulative learning
- **Meta-modifiable**: Even the improvement mechanism can be improved

---

## Storage

- `~/.pi/agent/skills/` — User-level skills
- `./.pi/skills/` — Project-level skills
- Builtin skills — Packaged with pi