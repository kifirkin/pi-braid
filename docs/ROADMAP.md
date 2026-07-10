<!-- status: current -->

# pi-braid Improvement Roadmap

**Status:** Active items only. Shipped/historical content archived at `../pi-braid-evaluation/docs-archive/`.

## Active items

### P1 — compat subpath cleanup

- [ ] **Migrate from compat import to Models interface.**
  `llm-call.ts` currently imports from `@earendil-works/pi-ai/compat`
  (deprecated subpath). The Models holder infrastructure exists
  (`src/lib/state/global-state.ts` getModels/setModels,
  `src/lib/ai/models-init.ts` initModels). The remaining work is to
  switch `llm-call.ts` from the compat fallback to the Models instance.
  See `src/lib/ai/AGENTS.md` for the design.

### P3 — release coordination

- [ ] **Coordinate with pi-braid-contrib's release.** It depends on
  `^0.80` peers. Ensure version compatibility before tagging a new
  braid release.

## Companion documents

- [`docs/FRAGILE-HEURISTICS-INVENTORY.md`](FRAGILE-HEURISTICS-INVENTORY.md) — 76-heuristic catalog (14 A+B items remain for LLM replacement)
- [`docs/ARCHAEOLOGY-FINDINGS.md`](ARCHAEOLOGY-FINDINGS.md) — prompt evolution timeline, research findings
- `../pi-braid-evaluation/docs-archive/` — all completed audits and shipped proposals (historical reference)

## History

The full 2,500+ line roadmap was consolidated here on 2026-07-10.
Every shipped item was verified: 84/84 tests pass, typecheck clean,
doc checks clean (55/55). Historical content preserved at
`../pi-braid-evaluation/docs-archive/`.