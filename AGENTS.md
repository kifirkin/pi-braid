<!-- status: current -->

# pi-braid

Extension host for the pi coding agent: 25+ extensions across orchestration, enforcement, memory, cognitive, heartbeat, and scheduling.

## How this hierarchy works

The DOX hierarchy is a tree of AGENTS.md working contracts. Each `packages/*/AGENTS.md` below is the authoritative contract for its area. Read the one covering the paths you will touch - plus every parent AGENTS.md on the route from the root down - before your first edit. The `dox` skill (`packages/core/skills/dox/SKILL.md`) defines the framework.

This root file is an index only: it points at the contracts, it does not restate them. Child docs own the detail; go there for rules.

## Child DOX Index

- AGENTS.md (repo-wide Developer Guide: workspace map, extension loading, build/test, doc discipline, tool inventory) at `packages/core/AGENTS.md`
- AGENTS.md (core `src/` top-level architecture: extensions/lib/loader/types split) at `packages/core/src/AGENTS.md`
- AGENTS.md (contrib: standalone pi-braid-contrib extensions, 12 modules) at `packages/contrib/AGENTS.md`
- AGENTS.md (providers: LLM provider registration, Venice model list) at `packages/providers/AGENTS.md`
- AGENTS.md (skills: content-only skill pack for pi) at `packages/skills/AGENTS.md`
- Design docs and audits (core `docs/`: ROADMAP, SETUP, HISTORY, architecture proposals) at `packages/core/docs/`
