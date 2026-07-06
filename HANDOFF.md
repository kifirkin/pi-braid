<!-- status: current -->
<!-- Created: 2026-07-06 for fresh-session transfer -->
<!-- LP-1 Phase 2 complete: Harness Proposal -->

# pi-braid session handoff

This file exists for a fresh agent session to pick up cleanly.
The work is in a known-good state as of this writing.

## Current state

- **Sprint 1**: Shipped (QW-1 contrast phrases, QW-2 PLANNING mode, QW-3 COMPLETION shutdown)
- **Sprint 2**: Shipped (MI-1 MARS principle+procedure reflection, MI-2 Truth-Seeking signal)
- **Sprint 3**: Shipped — LP-1 Phase 1 (failure trace + weakness miner), D-57 closure, MI-3, LP-1 Phase 2 (Harness Proposal)
- **Extra**: 3 system-prompt behavioral-verification fixes (existence-only tests → behavioral checks)
- **Working tree**: **CLEAN**
- **Tests**: 82/82 pass (+1 new: test-harness-proposer.mjs)
- **Typecheck**: Clean

## State of the codebase

- **CI**: `npm run ci:check` → ✅ all green (check:docs + check:doc-drift + tsc + 82/82 tests)
  - Note: `check:deps` has 2 pre-existing violations (mars-reflector.ts imports from ext/ — not from this change)
- **Tests**: `npm run test` → **82 passed, 0 failed**
- **Typecheck**: `npm run typecheck` → clean
- **Doc discipline**: `npm run check:docs` → ✅ 68/68; `npm run check:doc-drift` → ✅
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

## What's shipped (Sprint 3 + extra)

### LP-1 Phase 1 ✅ SHIPPED
- Failure trace collector + weakness miner wired into heartbeat evolver
- Collects from tool-loop-detector, error-tracking, validation failures
- Clusters by type+tool, computes severity, surfaces via whisper
- Files: `src/lib/harness/` (types.ts, failure-trace-collector.ts, weakness-miner.ts, index.ts, AGENTS.md)
- Inspired by Opik's trace→test-suite pipeline

### LP-1 Phase 2 ✅ SHIPPED (this session)
- **`src/lib/harness/harness-proposer.ts`** — generates K=3 candidate edits per actionable
  WeaknessCluster using utility model in proposer role
- **`src/lib/harness/types.ts`** — added `HarnessProposal`, `CandidateEdit`, `ProposalStatus`,
  `ProposalEffort`; updated `HarnessState` with `proposals[]`, `lastProposalTurn`
- **Wired into `evolver.ts`** — generates proposals for 1 actionable cluster per heartbeat
  after mining, latency bounded to 1 LLM call
- **Test**: `test-harness-proposer.mjs` — 22 structural assertions
- **Design**: LLM response parsed by `--- CANDIDATE N ---`/`--- END CANDIDATE ---` markers
  with Label/Change/Rationale/Effort fields

### MI-3 ✅ SHIPPED
- Structured Output Catalyst for tool results (committed in Sprint 3)
- See `src/lib/utils/format-tool-result.ts`

### System-prompt behavioral-verification fixes (3 commits)
- `13994806`: prevent existence-only tests, restore deliberative thinking
- `aefefc67`: genericize behavioral-verification, extend to tools + enforcement
- `54be4493`: propagate behavioral-verification philosophy to all verification surfaces

## What's next (Sprint 4)

### LP-1 Phase 3 (remaining): Proposal Validation
- Run each candidate on held-in + held-out splits
- Acceptance rule: `Δ_in ≥ 0 ∧ Δ_out ≥ 0 ∧ max > 0` (Pareto non-regression)
- Audit trail: every transition records changed surfaces, eval outcomes, decision
- Effort: ~1-2 days

### LP-2: Bidirectional Verifier
- Forward Trace + Backward Check for cross-file coordination
- Effort: ~1.5-2 days

### LP-3: Memory Leak Prevention
- Cross-project session isolation with provenance tracking
- Effort: ~1.5 days

### SI-1: Heartbeat as Unified Event Bus
- Typed event bus for all extensions
- Effort: ~3-4 days

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