<!-- status: current -->
<!-- Created: 2026-07-06 for fresh-session transfer -->
<!-- Sprint 1 complete: contrast phrases restored, PLANNING broadened, COMPLETION shutdown -->

# pi-braid session handoff

This file exists for a fresh agent session to pick up cleanly.
The work is in a known-good state as of this writing.

## Last commit

```
52503f34   Sprint 1: contrast phrases restored, PLANNING mode broadened, COMPLETION shutdown detection
```

Working tree is **CLEAN**. All commits pushed to `origin/main`.

## State of the codebase

- **CI**: `npm run ci:check` → ✅ all green (check:docs + check:doc-drift + check:deps + tsc + 81/81 tests)
- **Tests**: `npm run test` → **81 passed, 0 failed**
- **Typecheck**: `npm run typecheck` → clean
- **Doc discipline**: `npm run check:docs` → ✅ 66/66; `npm run check:doc-drift` → ✅
- **Working tree**: **CLEAN**. 0 uncommitted, 0 untracked.

## What just shipped (Sprint 1, 3 quick wins)

### QW-1: Restore contrast phrase library
- **New file**: `src/extensions/core/prompt-builder/contrast-phrases.ts`
- 4 phrases: TRUTH_FIRST, ANTI_SYCOPHANCY, EPISTEMIC_STABILITY, KNOWLEDGE_BOUNDARY
- Wired into `prompt-builder/index.ts` as a `linesSection` after interaction style
- Backed by RepE (2310.01405) and BeHonest (2406.13261)
- **Why**: Collateral damage from Jun 29 purge — was in the same file as the intentionally-deleted value statements

### QW-2: Wire PLANNING mode to real enforcement signal
- **Modified**: `turn-end-handler.ts`, `signals.ts`, `context-hygiene-state.ts`
- Replaced startup-only detection (first 3 turns) with `toolsSinceLastPlan` counter
- Incremented on work tool calls (edit/write) without scratchpad use
- Resets when scratchpad is used; works at any turn
- **Why**: PLANNING mode existed but was essentially dormant after turn 3

### QW-3: Add COMPLETION detection on session shutdown
- **Modified**: `register-session-shutdown.ts`
- Checks `totalToolCalls > 0 && lastFinalizeNudge === -100` at shutdown
- Logs signal for future event bus wiring
- **Why**: Catches "work done without marking complete" at session boundary

### Supporting files
- `ARCHAEOLOGY-FINDINGS.md` — 457-line, 11-section archaeology report
- `docs/proposals/IMPROVEMENT-PROPOSALS.md` — 11 proposals across 4 tiers

## What's next (Sprint 2)

### MI-1: Upgrade MARS to full principle+procedure reflection
- Current `mars-reflector.ts` (210 lines) is a statistical tool-usage analyzer, not a real MARS implementation
- Needs: rename to `tool-usage-analyzer.ts`, create new `mars-reflector.ts` with MARS paper's two reflection types
- Papers: MARS (2601.11974), ACE (2510.04618)
- Effort: ~4-6 hours

### MI-2: Add Truth-Seeking signal to CONTRAST mode detection
- TRUTH-SEEKING is the default mode but has no dedicated trigger signal
- Wire `verify_claim` / `conflict_qa` tool calls to briefly surface TRUTH-SEEKING mode explicitly
- Effort: ~2 hours

### LP-1: Self-Harness Loop (longer-term)
- Automated harness improvement via Weakness Mining → Proposal → Pareto validation
- Paper shows 53-60% relative improvement on held-out tasks
- Effort: ~2-3 days

## Key reference docs

| Document | What it contains |
|----------|-----------------|
| `ARCHAEOLOGY-FINDINGS.md` | Full prompt evolution timeline, lost features, research findings, session archaeology |
| `docs/proposals/IMPROVEMENT-PROPOSALS.md` | 11 prioritized proposals with file paths, effort estimates, verification criteria |
| `docs/ROADMAP.md` | Current actionable roadmap (all P0 shipped, P1/P2/P3 remaining) |
| `AGENTS.md` (root) | Binding work contract; read first |
| `src/extensions/core/prompt-builder/identity.ts` | All 8 invariants + interaction style |
| `src/extensions/core/prompt-builder/behavior-modes.ts` | 8 behavior modes (all wired) |
| `src/extensions/enforcement/signals.ts` | `determineContrastMode()` — the 6 priority tiers |

## Conventions

- **Don't add module-level `let`** for stateful data. Use `getExtensionState(ctx, key, factory)`.
- **Mark every `.md`** with `<!-- status: current | forward-looking | aspirational | historical -->`.
- **Prefer implementing over removing.** Only remove truly dead code.
- **Prefer grep/find/ls tools over bash** for file exploration (faster, respects .gitignore).

## Quick-start commands

```bash
npm run check:docs && npm run check:doc-drift  # sanity-check discipline
npm run typecheck && npm run test               # verify everything works
memory action=recall_search query="braid"       # surface past insights
scratchpad action=continue                      # resume goal + plan
```