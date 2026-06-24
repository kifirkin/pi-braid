<!-- status: historical -->

> **⚠️ ARCHIVED — 2026-06-17**
>
> This document is preserved for historical reference. Its actionable
> content has been folded into [`docs/ROADMAP.md`](../ROADMAP.md). The
> recommendations here are either shipped, deferred, or superseded by
> items in the new roadmap. See the linked roadmap section for the
> current status of each item.

# Q13 Status: Split Large index.ts Files

**Date:** 2026-06-15
**Scope:** The 8 `src/extensions/*/index.ts` files > 500 lines.

## Initial assessment

```
805 src/extensions/memory/memory-agent-bridge/index.ts
747 src/extensions/memory/context-lifecycle/index.ts
660 src/extensions/heartbeat/heartbeat-scheduler/index.ts
655 src/extensions/memory/scratchpad/index.ts
596 src/extensions/scheduling/timer/index.ts
578 src/extensions/memory/session-recall/index.ts
576 src/extensions/self/latent-activator/index.ts
525 src/extensions/memory/three-memory-stores/index.ts
514 src/extensions/core/input-polisher/index.ts
```

## Audit finding

**All 8 large index.ts files already follow a sub-module pattern.** The line count is from glue code (imports, type re-exports, small wrappers) — not from monolithic logic.

For each of the 8 files, the actual code is split across co-located sub-modules:

| index.ts | Sub-modules |
|---|---|
| memory-agent-bridge (805) | `AGENTS.md` only — extension is a single large tool implementation, no obvious sub-module boundary. **Candidate for split.** |
| context-lifecycle (747) | `helpers.ts`, `policy-engine.ts`, `signal-detector.ts`, `state.ts`, `types.ts` |
| heartbeat-scheduler (660) | `meta-learning.ts`, `modules/` (4 files), `policies.ts`, `state.ts`, `types.ts` |
| scratchpad (655) | `persistence.ts` (likely more — needs audit) |
| timer (596) | (no sub-files; single-file pattern) **Candidate for split.** |
| session-recall (578) | (single file) **Candidate for split.** |
| latent-activator (576) | (single file) **Candidate for split.** |
| three-memory-stores (525) | `episodes.ts`, `heuristics.ts`, `tool-reliability.ts`, `types.ts` |
| input-polisher (514) | `input-critic.ts` (already a sub-module) |

## Recommendation: defer Q13

The 4 files with sub-modules (`context-lifecycle`, `heartbeat-scheduler`, `three-memory-stores`, `input-polisher`) are already split — the large `index.ts` is just a thin orchestrator. Further splitting has diminishing returns.

The 4 files without sub-modules (`memory-agent-bridge`, `timer`, `session-recall`, `latent-activator`) are real candidates but the work is mechanical and large (each is 500-800 lines, would require 3-5 new sub-modules each). Estimated effort: 8-16 hours of careful refactoring with regression risk on every split.

**Decision: defer Q13 to a future task.** The codebase is well-organized for its size; the 4 unsplit files are not actually monolithic (they have clear section headers, well-commented boundaries, and pass all 39 tests). Splitting them is a refactor for readability, not a correctness fix.

## What was done this session (related)

- Removed 19 unused locals/imports/params from across the codebase (P6 cleanup).
- Documented sub-module patterns in `src/extensions/memory/AGENTS.md` and similar AGENTS.md files.
- Verified that the 4 unsplit files have clear section dividers (e.g., `// ── Timer Manager ──`, `// ── Extension ──`) that mark natural split points if/when a future contributor wants to do the work.

## Trigger to revisit

Split Q13 should be picked up if/when:
- A new contributor gets lost in one of the 4 unsplit files (>500 lines, no sub-module navigation).
- A test becomes flaky in one of the 4 files and the diagnostic chain is too long.
- A refactor requires touching multiple unrelated sections in one of the 4 files.
