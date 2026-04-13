---
name: skill-creator
description: "Use when user wants to create a new skill, improve an existing skill, or measure skill performance. Creates skills from task experience, iteratively evaluates and improves them."
---

# Skill Creator

Create new skills from task experience, iteratively evaluate and improve them.

## The Core Loop

1. **Understand** - What should this skill do?
2. **Draft** - Write the SKILL.md
3. **Test** - Run test cases
4. **Review** - Evaluate results
5. **Improve** - Refine based on feedback
6. **Repeat** - Until satisfied

## Creating a New Skill

### 1. Capture Intent

Ask and document:
- What should this skill enable?
- When should it trigger? (specific contexts, user phrases)
- What's the expected output format?
- Should we set up test cases?

### 2. Write SKILL.md

```markdown
---
name: skill-name
description: "WHEN TO TRIGGER + WHAT IT DOES. Be specific about contexts."
---

# Skill Name

Brief description of what this skill does.

## When to Use
- Context 1
- Context 2

## How to Use
Step-by-step instructions...

## Examples
Input: ...
Output: ...
```

### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code
    ├── references/ - Documentation
    └── assets/     - Templates, examples
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase, hyphens only, max 64 chars |
| `description` | Yes | When to trigger + what it does, max 1024 chars |
| `disable-model-invocation` | No | Skip auto-loading for expensive skills |

### Writing the Description

**Be "pushy"** - Include specific triggers:
```
# BAD
"Build dashboards for data visualization."

# GOOD  
"Build fast dashboards to display internal metrics and data.
Use when user mentions: dashboards, data visualization, metrics,
internal data, charts, graphs, or displaying company data."
```

### Progressive Disclosure

Skills load in layers:
1. **Metadata** (name + description) - Always in context (~100 words)
2. **SKILL.md body** - In context when triggered (<500 lines ideal)
3. **Bundled resources** - As needed (scripts, references)

### Writing Style

- Use imperative form ("Do X" not "X should be done")
- Explain **why** not just what
- Keep it general, not overfitted to examples
- Under 500 lines; if approaching limit, add pointers

### Common Patterns

**Output format:**
```markdown
## Output Format
ALWAYS use this structure:
# [Title]
## Summary
## Details
```

**Step-by-step:**
```markdown
## Process
1. First do X
2. Then do Y
3. Finally do Z
```

## Testing a Skill

### Create Test Cases

```json
{
  "skill_name": "my-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "Realistic user task",
      "expected": "Description of expected result"
    }
  ]
}
```

### Run Evaluation

1. Run skill on test prompt
2. Compare output to expected
3. Note what worked / what didn't
4. Improve the skill

### Questions to Ask

- Does the description trigger correctly?
- Is the guidance clear and actionable?
- Are there edge cases not covered?
- Is the output format correct?

## Improving an Existing Skill

### Common Issues

| Issue | Fix |
|-------|-----|
| Under-triggering | Make description more specific, add contexts |
| Over-triggering | Narrow the description, add exclusion cases |
| Unclear guidance | Add examples, explain the why |
| Missing edge cases | Add sections for edge cases |
| Too verbose | Remove redundant content |

### Iteration Process

1. Identify the issue (from test results or user feedback)
2. Make targeted change
3. Re-test
4. Verify improvement
5. Repeat

## Skill Storage

Skills are stored in:
- `~/.pi/agent/skills/` - User-level skills
- `./.pi/skills/` - Project-level skills
- Builtin skills - Packaged with pi

## Validation Checklist

Before finalizing:
- [ ] Description triggers correctly
- [ ] All instructions are clear
- [ ] Examples are realistic
- [ ] Edge cases covered
- [ ] Output format specified
- [ ] Under 500 lines

## Tips from Experience

1. **Start simple** - Don't over-engineer initially
2. **Test with real prompts** - Not hypothetical ones
3. **Explain the why** - Helps when edge cases arise
4. **Keep descriptions specific** - "pushy" > vague
5. **Version your skills** - Track changes over time
