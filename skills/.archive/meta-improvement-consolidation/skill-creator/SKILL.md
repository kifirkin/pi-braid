---
name: skill-creator
description: "Create new skills from task experience, iteratively evaluate and improve them. Use when building a skill, improving an existing one, or measuring skill performance."
---

# Skill Creator

Create skills from task experience, evaluate them, and iterate.

---

## Core Loop

1. **Understand** — What should this skill enable?
2. **Draft** — Write the SKILL.md
3. **Test** — Run test cases
4. **Evaluate** — Does it trigger correctly? Is guidance clear?
5. **Improve** — Refine based on results
6. **Repeat** — Until satisfied

---

## Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code
    ├── references/ - Documentation
    └── assets/     - Templates, examples
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase, hyphens, max 64 chars |
| `description` | Yes | When to trigger + what it does, max 1024 chars |
| `disable-model-invocation` | No | Skip loading to agent prompt |

### Writing the Description

Be specific about triggers — include contexts and user phrases:

```
# WEAK
"Build dashboards for data visualization."

# SPECIFIC
"Build fast dashboards to display internal metrics.
Use when: dashboards, data visualization, metrics,
internal data, charts, graphs, or displaying company data."
```

---

## Progressive Disclosure

Skills load in layers:
1. **Metadata** — name + description in context (~100 words)
2. **SKILL.md body** — in context when triggered (<500 lines)
3. **Bundled resources** — loaded as needed

---

## Testing

Create test cases in a structured format, run the skill on realistic prompts, compare output to expected, note what worked and what didn't.

**Questions to evaluate**:
- Does the description trigger correctly?
- Is guidance clear and actionable?
- Are edge cases covered?
- Is the output format correct?

---

## Common Issues

| Issue | Fix |
|-------|-----|
| Under-triggering | More specific contexts in description |
| Over-triggering | Narrow the description, add exclusions |
| Unclear guidance | Add examples, explain the why |
| Missing edge cases | Add sections for edge cases |
| Too verbose | Consolidate, add pointers to references |

---

Before finalizing, check:
- [ ] Description triggers correctly
- [ ] Instructions are clear and actionable
- [ ] Edge cases covered
- [ ] Output format specified
- [ ] Under 500 lines

*Optional validation checklist — embed or discard as needed.*

---

## Storage

- `~/.pi/agent/skills/` — User-level skills
- `./.pi/skills/` — Project-level skills
- Builtin skills — Packaged with pi
