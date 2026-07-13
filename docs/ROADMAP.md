<!-- status: current -->

# pi-braid Improvement Roadmap

**Status:** Active items only. Shipped/historical content archived at `../pi-braid-evaluation/docs-archive/`.

## Active items

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
  
- [x] **Sub-item 2: Max-power model for automatic operations — SHIPPED.**
  **Changes made (2026-07-11):**
  1. **Created `tryModelChain()` shared helper** in `model-resolver.ts`
     — accepts lazy resolver callbacks, short-circuits on first success.
     Handles API key resolution and null models transparently.
     (`src/lib/ai/model-resolver.ts`)
  2. **Wired into verification judge** via `judge-utils.ts:callLlm()` —
     utility → session → max-power (fallback-only, max-power only on
     error). Prevents flooding on MESSAGE_END.
     (`src/extensions/enforcement/judge-utils.ts`)
  3. **Wired into verify, hypothesize, think, backward-checker** —
     max-power FIRST → utility → session. These are accuracy-critical
     and explicitly invoked, so defaulting to the expensive model is
     appropriate.
     (`src/extensions/cognitive/metacognition/handlers/verify.ts`,
     `hypothesize.ts`, `think.ts`,
     `src/lib/verification/backward-checker.ts`)
  4. **Wired into claim-tracker** — utility → session → max-power
     (fallback-only, runs every turn).
     (`src/lib/store/claim-tracker.ts`)
  5. **Excluded from session-recall** (token-heavy, 180s timeout) and
     **input-polisher** (not accuracy-critical).
  
  **Strategy per caller:**
  - max-power FIRST: verify, hypothesize, think, backward-checker
  - fallback-only: judge-utils (verification judge), claim-tracker
  - excluded: session-recall, input-polisher
  
- [x] **Sub-item 3: Finalize enforcements baked into the tool itself.**
  **CLOSED: Event-driven approach superseded.** Instead of waiting for pi-core
  to expose an `emit()` API, enforcement checks are baked directly into the
  finalize handler's execute function. Implemented 2026-07-13:
  
  1. **Unresolved conflicts check** — warns if `getUnresolvedConflicts()`
     returns > 0 entries, suggesting the agent resolve them before finalizing.
     Advisory, not blocking (conflicts may be acceptable).
  2. **Stronger unpersisted learnings warning** — explicitly warns that
     learnings "will be lost on shutdown" instead of a passive suggestion.
  
  **Also added (register-message-end.ts):**
  3. **Text-only response after work detection** — when the agent responds
     with text only (no tool calls) after 2+ turns of edits/writes without
     calling finalize, sends an enforcement whisper suggesting finalize.
     Catches the "wrapped up but forgot to finalize" pattern.
     Uses a 10-turn cooldown via lastFinalizeNudge.

### P3 — session navigation enforcement for long-running tasks

**Status:** Investigation complete, hypothesize fix shipped. Implementation pending.

**Goal:** Enforce session navigation (context_tag, context_archive, finalize)
at phase boundaries — investigation→implementation, research→verification —
so the agent never loses work between phases.

**Current state (2026-07-11):**
- [x] **Investigation**: Read 15+ source files across enforcement, context-lifecycle,
  metacognition, scratchpad, session-recall. Full analysis in session transcript.
- [x] **hypothesize fix**: `tryModelChain` now treats empty text as failure (continues
  to next resolver). hypothesize.ts gracefully degrades instead of throwing.

**Key gaps identified:**
1. Phase transitions are proposed (custom entries), not enforced (whispers)
2. No auto-tagging of position before phase changes
3. No detection of investigation→implementation transition
4. No finalize enforcement after verify_claim + structured response
5. SessionPhase type exists in scratchpad but never auto-set
6. No initial request complexity analysis to gate enforcement

**Planned changes (Tier 1 — quick wins, 0 new LLM calls):**
- [x] Upgrade topic-shift proposals to enforcement whispers with triggerTurn
- [x] Auto-set SessionPhase from tool patterns (reuse topic classification)
- [x] Auto-tag position before phase transitions (context_navigate action="tag")

**Planned changes (Tier 2 — moderate, heuristic-only):**
- [x] Phase-aware enforcement: detect investigation→implementation transition
- [x] Finalize enforcement after verify_claim + structured markdown response

**Planned changes (Tier 3 — significant, 1 new LLM call per session):**
- [x] Initial request complexity classifier (CRITICS.initialRequestComplexity)
- [x] Auto-navigate back to investigation checkpoint after implementation
- [x] Escalation for ignored proposals (mirror compaction escalation pattern)

### Cross-session features

- [x] **Cross-session tag persistence**: Tags created via `context_navigate(action="tag")` are
  persisted to `~/.pi/agent/braid/tags/<slug>.json` and surfaced on SESSION_START.
  Tags survive process restarts and compaction.

## Companion documents

- [`docs/HISTORY.md`](HISTORY.md) — consolidated history including fragile heuristics, archaeology, proposals, and D-57
- `../pi-braid-evaluation/docs-archive/` — all completed audits and shipped proposals (historical reference)

## History

The full 2,500+ line roadmap was consolidated here on 2026-07-10.
Every shipped item was verified: 84/84 tests pass, typecheck clean,
doc checks clean (55/55). Historical content preserved at
`../pi-braid-evaluation/docs-archive/`.

## Archived items

### P1 — compat subpath cleanup (archived 2026-07-13)

**Status:** Won't fix. The compat import from `@earendil-works/pi-ai/compat`
works correctly and the migration path is fully documented in the source
(`src/lib/ai/llm-call.ts` module-level comment). The migration requires
cross-repo changes to pi-braid-providers (registering custom providers on the
Models instance via `createProvider()` + `setProvider()`), which risks breaking
custom provider registrations (a0venice, openrouter-custom). The documented
migration path serves as sufficient documentation for any future maintainer.
The code comment at `src/lib/ai/llm-call.ts:31-53` describes the exact steps.