# Skill Loading Research

> **For latest project state**: See [RESEARCH-MASTER.md](RESEARCH-MASTER.md)

## Overview

Pi's skill system allows the agent to dynamically load specialized instructions (SKILL.md files) at runtime. Understanding the resolution mechanism is critical for creating and troubleshooting skills.

## Skill Resolution Path

1. **Project-local skills** — checked first when pi starts with `-e /path/to/project`
   - Path: `<project>/skills/<name>/SKILL.md`
   - Example: `pi-braid/skills/pi-reference/SKILL.md`

2. **User-global skills** — fallback when not found locally
   - Path: `~/.pi/agent/skills/<name>/SKILL.md`
   - Example: `~/.pi/agent/skills/npm-approval/SKILL.md`

3. **Skill registration** — via `pi.registerSkill()` or auto-discovered on startup

## How Skills Are Loaded

- The pi agent scans `skills/` directories at startup
- Each subdirectory containing `SKILL.md` becomes a named skill
- The `SKILL.md` file is injected into context when the skill's conditions match
- Skills can also be referenced in system prompts or loaded on-demand via tools

## Creating a New Skill

```
skills/
  my-skill/
    SKILL.md          # Required: skill instructions
    data/             # Optional: supporting files
```

### SKILL.md Structure

```markdown
# Skill Name

## When to Use
- Trigger conditions (e.g., "Use when user mentions: approve npm package")

## Instructions
- Step-by-step guidance
- Can reference relative paths in skill directory

## Tools
- List of tools this skill expects to use
```

## Best Practices

1. **Keep skills focused** — one domain per skill, avoid monolithic skills
2. **Use trigger phrases** — help the router decide when to activate
3. **Reference relative paths** — skills are portable across projects
4. **Version in VCS** — commit skills alongside the codebase they support

## Current pi-braid Skills

| Skill | Location | Purpose |
|-------|----------|---------|
| pi-reference | `skills/pi-reference/` | Pi SDK, extensions, configuration |
| software-engineer | `skills/software-engineer/` | Universal debugging/implementation protocol |
| documentation | `skills/documentation/` | Architecture docs, README generation |
| process-control | `skills/process-control/` | tmux, nohup, long-running tasks |
| healthcheck | `skills/healthcheck/` | Agent self-diagnostics |
| tone-quality | `skills/tone-quality/` | Text quality principles |
| agent-testing | `skills/agent-testing/` | Benchmarking, multi-trial tests |
| paper-writer | `skills/paper-writer/` | LaTeX research paper structure |
| vcs-tools | `skills/vcs-tools/` | Git/Pijul worktree management |
| visual-validator | `skills/visual-validator/` | Design critique for sprites/UI |
| code-search | `skills/code-search/` | grep vs ast-grep selection |
| meta-improvement | `skills/meta-improvement/` | Skill creation & evolution |
| research | `skills/research/` | Web search, fact verification |

## Troubleshooting

- **Skill not found**: Verify directory name matches skill reference exactly
- **Skill not loading**: Check that `SKILL.md` exists at the correct path
- **Outdated skill**: Pi caches skill content; restart to reload

## Open Questions

1. Does pi support skill versioning or hot-reloading?
2. Can skills declare dependencies on other skills?
3. Is there a skill registry API for listing loaded skills?

## Open Questions

1. Does pi support skill versioning or hot-reloading?
2. Can skills declare dependencies on other skills?
3. Is there a skill registry API for listing loaded skills?
4. Should skills be auto-loaded based on task type (see [RESEARCH-MASTER.md Part 7](RESEARCH-MASTER.md) — Fast/Slow Routing)?
5. Can skills inject behavior patterns that survive context rotation?

*Generated: 2026-04-22*
*Updated: 2026-04-23*
