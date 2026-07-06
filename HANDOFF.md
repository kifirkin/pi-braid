<!-- status: current -->
<!-- Created: 2026-07-06 for fresh-session transfer -->
<!-- Sprint 2 complete: MARS principle+procedure reflection, Truth-Seeking signal -->

# pi-braid session handoff

This file exists for a fresh agent session to pick up cleanly.
The work is in a known-good state as of this writing.

## Current state

- **Sprint 1**: Shipped (QW-1 contrast phrases, QW-2 PLANNING mode, QW-3 COMPLETION shutdown)
- **Sprint 2**: Shipped (MI-1 MARS principle+procedure reflection, MI-2 Truth-Seeking signal)
- **Working tree**: CLEAN
- **Tests**: 81/81 pass
- **Typecheck**: Clean

Working tree is **CLEAN**. All commits pushed to `origin/main`.

## State of the codebase

- **CI**: `npm run ci:check` → ✅ all green (check:docs + check:doc-drift + check:deps + tsc + 81/81 tests)
- **Tests**: `npm run test` → **81 passed, 0 failed**
- **Typecheck**: `npm run typecheck` → clean
- **Doc discipline**: `npm run check:docs` → ✅ 66/66; `npm run check:doc-drift` → ✅
- **Working tree**: **CLEAN**. 0 uncommitted, 0 untracked.

## What just shipped (Sprint 2, 2 MI items)

### MI-1: MARS upgrade to principle+procedure reflection
- **Renamed**: `mars-reflector.ts` → `tool-usage-analyzer.ts` (accurate name for the statistical tool-usage analyzer)
- **New file**: `src/lib/reasoning/mars-reflector.ts` — implements MARS paper (2601.11974) two reflection types:
  - **Principle reflection**: After task completion, extracts general rules ("before editing, call think()", "after changes, run verify()") and stores as heuristics via `addPrinciple()`
  - **Procedure reflection**: After successful task, captures concrete steps ("Procedure for code-change: 1. Understand, 2. Plan, 3. Edit, 4. Verify") and stores as episodes via `addEpisode()`
- **Wired**: `mars-handler.ts` now calls `reflectOnTaskCompletion()` on finalize or every 10 turns
- **Storage**: Principles go to `three-memory-stores` heuristics (evolver.ts boosts/discounts over time); procedures go to episodic memory
- **Papers**: MARS (2601.11974), ACE (2510.04618)

### MI-2: Truth-Seeking signal for CONTRAST mode detection
- **Added**: `truth_seeking_trigger` signal key in `signals.ts`
- **Detection**: `turn-end-handler.ts` sets the signal when `verify_claim`/`conflict_qa` is used
- **Surfacing**: `determineContrastMode()` checks this signal at priority 7 (before the default), confirming TRUTH-SEEKING mode explicitly when verification tools are used
- **Why**: Affirms the correct epistemic stance — the agent is being truth-seeking by verifying claims

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

### LP-1: Self-Harness Loop (longer-term)
- Automated harness improvement via Weakness Mining → Proposal → Pareto validation
- Paper shows 53-60% relative improvement on held-out tasks
- Effort: ~2-3 days

### MI-3: Structured Output Catalyst for Tool Results
- Based on MDA (2601.21996) finding that repetitive structural data catalyzes induction head formation
- Add `formatToolResult` function that wraps tool output in consistent structured format
- Effort: ~3-4 hours (see `docs/proposals/IMPROVEMENT-PROPOSALS.md`)

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