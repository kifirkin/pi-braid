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

- [x] **Investigated: pi-braid-contrib compatibility.**
  pi-braid-contrib v0.1.0 depends on `>=0.80.0` for pi-core packages
  (pi-coding-agent, pi-ai, pi-tui). pi-braid v0.3.0 also depends on
  `>=0.80.0`. Both are compatible with the same pi-core version range.
  No conflicts — a new braid release can proceed independently.
  Tagging: coordinate version bumps but no peer-dep changes needed.

### P3 — investigation: verification judge false positive on finalize

- [x] **Fixed: verification judge false-positive pattern.**
  Root cause: The judge fired after `finalize()` and checked the text
  response for verification evidence, but the agent's verification was
  done via tool calls (npm test, npm typecheck). The judge's context
  included the tool execution log but the system prompt didn't instruct
  it to check tool log output for verification commands.
  
  **Changes made (2026-07-10):**
  1. **Improved judge system prompt** — Added explicit instruction:
     "Verification evidence is in the TOOL EXECUTION LOG, not just the
     text response. Look for \`npm test\`, \`npm run typecheck\`,
     \`npm run build\`, \`tsc\`, \`jest\`, \`vitest\`, or output containing
     PASS, FAIL, error TS, tests passed, typecheck clean."
     Updated examples to show a pass case where verification is in the
     tool log, not the response text.
     (`src/extensions/enforcement/verification-judge.ts`)
  2. **Granular hasVerification check** — Replaced `userHasBash` (checks
     if bash was ever used) with `checkToolOutputsForVerification()`
     which scans turn history tool outputs for test/typecheck indicators
     using 12 regex patterns. Returns true only when actual verification
     output is detected.
     (`src/extensions/enforcement/handlers/register-message-end.ts`)
  
  **Not investigated:** Option 2 (agent includes evidence block in
  response), Option 3 (suppress on finalize turns), Option 4
  (configurable behavior). The prompt fix addresses the root cause.

### P3 — investigation: finalization practices + scratchpad auto-cleanup

- [x] **Sub-item 1: Scratchpad cleanup on finalize — FIXED.**
  `finalize` now calls `handleClearDone()` on the scratchpad after
  recording to memory on successful completion. Two changes:
  
  1. **Fixed `findNextWork` (was dead code).** It was accessing
     `getExtensionState(ctx, "scratchpad", ...)` which doesn't exist
     (scratchpad stores under key `"scratchpad-cache"`), and then
     checked `.taskStore.tasks` which doesn't exist on `TaskScratchpad`
     (the type uses `plan[]` with `doneTurn === 0` for pending items).
     Now uses the correct state key and `pad.plan` for pending items.
     `autoProceed` now works correctly.
     (`src/extensions/cognitive/metacognition/handlers/finalize.ts`)
  
  2. **Added `clearScratchpadDone()`** — fire-and-forget function that
     calls `handleClearDone()` after successful finalize. Clears done
     items from the scratchpad so they don't accumulate.
     (`src/extensions/cognitive/metacognition/handlers/finalize.ts`)
  
- [ ] **Sub-item 2: Max-power model for automatic operations.**
  **Investigation findings:**
  - `resolveMaxPowerModel()` already exists in `model-resolver.ts` and
    is used by `consolidated-input-critic.ts` and
    `consolidated-topic-critic.ts` as Tier 3 fallback.
  - The ROADMAP's claim that "finalize uses the session model via
    callLlm" is partially outdated: `finalize.ts` itself doesn't call
    LLM directly. LLM calls happen in the consolidation pipeline
    (heartbeat-triggered via `processConsolidationTick`) and the
    verification judge (MESSAGE_END-triggered via `runVerificationJudge`).
  - The verification judge uses `getJudgeModel()` which falls back to
    `resolveUtilityModel()` → session model. Adding max-power routing
    to the verification judge would require a try-model chain similar
    to `consolidated-input-critic.ts`.
  - **Deferred:** This is a tuning optimization, not a bug fix. The
    max-power infrastructure is in place; wiring it into the judge
    requires a design decision about model tier ordering.
  
- [ ] **Sub-item 3: Event-driven scratchpad cleanup.**
  **Investigation findings:**
  - pi-core's `ExtensionAPI` does not expose a public `emit()` method
    for extensions to broadcast custom events. The `onEvent` helper
    wraps `pi.on()` for receiving events, but there's no equivalent
    `emitEvent` for sending.
  - The direct-call approach (sub-item 1 fix) is the pragmatic solution
    given the current event system. It's no different from how finalize
    already calls `addEpisode()` and `addPrinciple()` from the
    three-memory-stores module.
  - **Future work:** If pi-core adds `pi.events.emit()` or a similar
    broadcast mechanism, migrate the scratchpad cleanup to an
    event-driven model. Until then, the direct call is the correct
    pattern.
  
  **Scope**: finalize tool, scratchpad handler, event bus types,
  max-power model routing in callLlm
  
  **Proposal**: `docs/proposals/finalization-practices.md` (deferred)

## Companion documents

- [`docs/HISTORY.md`](HISTORY.md) — consolidated history including fragile heuristics, archaeology, proposals, and D-57
- `../pi-braid-evaluation/docs-archive/` — all completed audits and shipped proposals (historical reference)

## History

The full 2,500+ line roadmap was consolidated here on 2026-07-10.
Every shipped item was verified: 84/84 tests pass, typecheck clean,
doc checks clean (55/55). Historical content preserved at
`../pi-braid-evaluation/docs-archive/`.