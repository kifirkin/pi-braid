# Extension Group: prompt

System prompt construction and injection defense.

## Extensions

| Extension | Files | Purpose |
|---|---|---|
| `prompt-builder/` | 3 | Full system prompt reconstruction from structured data. Overrides pi's native loading. |

Total: 3 `.ts` files.

## Key Architecture

**prompt-builder** completely overrides pi's native prompt loading. Reconstructs prompt from:
1. Custom identity (Braid agent identity)
2. Sycophancy resistance (RepE-style text vectors)
3. Available tools (via `pi.getAllTools()`)
4. Project context (AGENTS.md/CLAUDE.md)
5. Skills (via `loadSkills()` + custom `formatSkillsWithLineCounts()`)
6. L1 environmental state
7. Enforcement signals (L2 bundled)
8. Date + cwd

**Skills loading:** 13 bundled skills from `skills/` dir + 1 user skill. Registered via `resources_discover` event handler. `formatSkillsWithLineCounts()` adds line counts and section names.

**pi-native integration:** `resources_discover` handler returns `{ skillPaths: [SKILLS_DIR] }` so pi's package manager can auto-discover bundled skills.

## See Also

- [prompt-builder.md](prompt-builder.md) — full docs
