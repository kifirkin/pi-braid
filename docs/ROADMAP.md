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