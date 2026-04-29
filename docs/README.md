# pi-braid

**Repository**: `/Users/kifir/projects/agents/pi-braid/`

Metacognitive extension suite for [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent). Research-backed behavioral engineering: enforcement, planning, memory, heartbeat scheduling, RepE contrast vectors, and utility tools.

---

## Start Here

| Document | Purpose |
|---|---|
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | **Master plan** — all proposals, priorities, P0-P3 execution order |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design and layer overview |
| [MODULES.md](MODULES.md) | Module system + toggle API |
| [WHAT-IS-MISSING.md](WHAT-IS-MISSING.md) | Gap analysis and backlog |

---

## Key Features

- **Cognitive enforcement**: 3-tier signal system (L1 internal, L2 session, L3 critical), RepE contrast vectors, sycophancy detector
- **Metacognition**: Meta-learning tick adjustment, degrade-on-idle, belief-policy-engine
- **Memory**: Three-memory-stores (200 entries, Jaccard dedup), session recall, compaction v0.23
- **Heartbeat scheduling**: Proactive cognitive scheduling (2604.14178), tool addiction detection
- **Utility tools**: Codebase tree/graph, REPL, docs reader, browser CDP, web fetch, vision analysis
- **15 bundled skills**: agent-testing, code-search, documentation, healthcheck, meta-improvement, paper-writer, pi-reference, process-control, research, software-engineer, tone-quality, vcs-tools, visual-validator

---

## Development

```
npm run build     # TypeScript compile
npm run test      # 34 runtime tests
npm run typecheck # Type check only
npm run format    # Prettier format
npm run lint      # ESLint
```

---

## Top-Level Docs

| File | Purpose |
|---|---|
| [README.md](README.md) | This file |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design |
| [MODULES.md](MODULES.md) | Module system |
| [EXTENSION-HOOKS.md](EXTENSION-HOOKS.md) | How to write extensions |
| [ERRORS.md](ERRORS.md) | Error reference |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | Master implementation plan |
| [WHAT-IS-MISSING.md](WHAT-IS-MISSING.md) | Gap analysis |
| [BENCHMARKS.md](BENCHMARKS.md) | Benchmark suite |
| [SKILLS.md](SKILLS.md) | Skills system |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

## Other Docs

- [docs/extensions/](extensions/) — 43 extension documentation files
- [docs/lib/](lib/) — 22 library documentation files
- [docs/proposals/](proposals/) — 15 R&D proposals
- [.archive-old/](.archive-old/) — Historical docs (v0.5–v0.9)

---

## Maintainers

Last updated: 2026-04-29