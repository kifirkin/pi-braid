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

### P3 — investigation: verification judge false positive on finalize

- [ ] **Analyze enforcement whisper verification judge false-positive pattern.**
  The verification judge fires after `finalize()`, flagging the agent's
  text response as "unverified" because the verification evidence lives
  in the tool call log, not in the response text. This is a recurring
  false positive.

### P3 — investigation: finalization practices + scratchpad auto-cleanup

- [ ] **Design better finalization practices.** Current issues:
  
  1. **Scratchpad not cleaned on finalize** — `finalize` records an episode
     and triggers consolidation, but doesn't clear done items from the
     scratchpad. Stale plan items accumulate until someone notices. The
     fix: `finalize` should call `handleClearDone(pad)` on the scratchpad
     state after recording to memory. It already has access to the
     scratchpad extension state (reads `taskStore` for auto-proceed).
  
  2. **Max-power model for automatic operations** — Finalize, consolidation,
     MARS reflection, SOP extraction, and memory consolidation are
     automatic system operations that run once per task, not once per turn.
     They should use the max-power model (expensive, thorough, high quality)
     because:
     - They produce episodes and SOPs stored in memory and reused across
       sessions — quality directly impacts future retrieval
     - They run ~1/task, not ~10/turn — cost is amortized
     - The agent's per-turn tool calls (think, verify, scratchpad) are the
       hot path and should use the session model (cheap, fast)
  
     Currently, `finalize` uses the session model via `callLlm` (which
     resolves to the session model). The `recordToMemory` function uses
     `addEpisode` and `addPrinciple` which are local operations, but
     `extractStrategicSOP` and `extractFunctionalSOP` are trivial
     implementations that don't use LLM at all.
  
  3. **Event-driven scratchpad cleanup** — Instead of finalize calling
     scratchpad internals directly (tight coupling), emit a
     `TaskCompletedEvent` on the event bus. The scratchpad extension
     listens and auto-archives done items. This is the cleaner
     architectural fix.
  
  **Scope**: finalize tool, scratchpad handler, event bus types,
  max-power model routing in callLlm
  
  **Proposal**: `docs/proposals/finalization-practices.md`
  
  **Root cause**: The verification judge checks the *text response* for
  verification claims, but the agent's verification is done via tool
  calls (`npm run test`, `npm run typecheck`) whose results are in the
  tool execution trace, not in the closing text.
  
  **Possible solutions to investigate**:
  1. Verification judge should check the tool call log for
     `verify`/`bash` with test commands rather than the text response
  2. Agent should include a verification evidence block in the text
     response after finalize
  3. Suppress verification judge on finalize-d turns (the tool is
     designed for this)
  4. Make verification judge a configurable behavior mode
  
  **Scope**: enforcement whisper, verification judge, finalize tool

## Companion documents

- [`docs/HISTORY.md`](HISTORY.md) — consolidated history including fragile heuristics, archaeology, proposals, and D-57
- `../pi-braid-evaluation/docs-archive/` — all completed audits and shipped proposals (historical reference)

## History

The full 2,500+ line roadmap was consolidated here on 2026-07-10.
Every shipped item was verified: 84/84 tests pass, typecheck clean,
doc checks clean (55/55). Historical content preserved at
`../pi-braid-evaluation/docs-archive/`.