# Skills System

> How agent skills are discovered, loaded, and applied at session start.

## Overview

Skills are instruction sets that augment the agent's system prompt. Each skill is a directory containing a `SKILL.md` file. Skills are loaded at session start and injected into the prompt.

## Skill Locations

Skills are loaded from three locations:

| Location             | Path                        | Contents                           |
| -------------------- | --------------------------- | ---------------------------------- |
| **User skills**      | `~/.pi/agent/skills/`       | User-defined skills (loaded first) |
| **Project skills**   | `skills/` (project root)    | pi-braid bundled skills            |
| **Extension skills** | `skills/` in extension dirs | Extension-provided skills          |

## Skill Format

Each skill is a directory with a `SKILL.md`:

```
skills/
  software-engineer/
    SKILL.md      ← skill description + guidance
    README.md     ← optional long-form documentation
  research/
    SKILL.md
    README.md
```

### SKILL.md Format

The `SKILL.md` uses markdown with frontmatter:

```markdown
---
name: software-engineer
description: Use when writing, reviewing, or debugging code.
activate: code-review, refactoring, implementation, debugging
---

# Software Engineer

Apply these principles when working with code...

## When to Use

Use this skill when:

- Writing new code
- Reviewing existing code
- Debugging issues
- Refactoring
```

## How Skills Are Loaded

`loadSkills()` in `prompt-builder/index.ts`:

1. Scan all skill directories
2. Filter by `activate` conditions (based on task context)
3. Read `SKILL.md` content
4. Inject into system prompt

## Prompt Preview Tool

Use `prompt_preview` to see which skills are currently active:

```
prompt_preview(section=skills)
```

This shows all active skills with their descriptions and section headings.

## Adding a New Skill

1. Create `skills/<name>/SKILL.md`:

```markdown
---
name: <name>
description: One-line description.
activate: <trigger keywords>
---

# Skill Name

[skill guidance content]
```

2. Restart the session (skills are loaded at session start)

3. Verify with `prompt_preview(section=skills)`

## Skill Activation Triggers

Skills can be conditionally activated based on keywords in the task description:

```yaml
activate: code-review, refactoring, implementation, debugging
```

When any of these keywords appear in the user message, the skill is loaded.

## Existing Skills

| Skill               | Description                         |
| ------------------- | ----------------------------------- |
| `software-engineer` | Universal coding guidance           |
| `research`          | Research and fact-checking          |
| `documentation`     | Writing docs and READMEs            |
| `code-review`       | PR and code review                  |
| `debugging`         | Systematic debugging approach       |
| `process-control`   | Long-running process management     |
| `tone-quality`      | Writing quality guidance            |
| `visual-validator`  | Visual design validation            |
| `meta-improvement`  | Self-improvement and skill creation |
| `paper-writer`      | LaTeX research paper writing        |
| `agent-testing`     | Testing agent behavior              |
| `code-search`       | Code search and refactoring         |
| `pi-reference`      | pi CLI and extension reference      |

See individual skill READMEs for details.
