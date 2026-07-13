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

### P3 — session batch analysis tools

**Status:** Epic A (batch) shipped. Epic B (analyze) designed. Epic C (stats) scoped.

**Goal:** Mine 3 months of session data (318M, 318 braid sessions) for insights about
prompt effectiveness, behavior patterns, and failure modes.

**Epic A — `session action="batch"` — SHIPPED (2026-07-13, commit 36a0a724).**
Grep aggregation across all sessions by project and month, with timeline and top-N sessions.
No LLM, fast. Filters: `pattern` (required), `project` (defaults to cwd), `since` (optional date),
`limit` (max sessions, default 10).
Output: human-readable text (TUI-friendly) + structured `details` (following the `think` tool
pattern: `content` for human, `details` for agent).

**Epic B — `session action="analyze"` — DESIGNED.**
Multi-session LLM analysis. Accepts `sessionPaths: string[]`, `question: string`, `sample?: number`.
Per-session: parse JSONL → extract structured events (tool calls, verification judge verdicts,
behavior modes, finalize calls, errors, whispers) → compress to 1-2K token summary.
All summaries + question → main model (max context window).
Progressive batching for large sample sizes.

**Epic C — `session action="stats"` — SCOPED.**
Session statistics overview. Total sessions, by project, date range, average size. No LLM, fast.

### P3 — scratchpad real-time cross-instance sync

**Status:** Designed. Implementation pending.

**Goal:** Enable multiple pi instances to share a project-wide scratchpad in near-real-time.
An agent in one terminal can see plan items marked done by an agent in another terminal.

**Current architecture:**
- `getOrCreateScratchpad()` in `index.ts` — caches pad on first load, never reloads from disk
- `mutateAndSave()` in `utils.ts` — debounced write via `setTimeout(0)`
- `flushPendingScratchpadWrites()` — force-flush on turn-end (called by `register-turn-end-hygiene.ts`)
- JSONL is append-only, safe for concurrent writes (no overwrite race)

**Design:**
1. **`index.ts:getOrCreateScratchpad()`** — reload from disk on every tool call, merge with local
   in-memory state. Merge strategy: disk's plan items (shared), local's notes/decisions (ephemeral).
2. **`utils.ts:mutateAndSave()`** — add immediate flush option (skip debounce) for real-time writes.
3. **Coordination protocol:** Agent A marks done → saves → Agent B reloads → sees updated plan.
   `finalize()` calls `mark_done` + `flushPendingScratchpadWrites()`.

**Key design decisions (from 2026-07-13 discussion):**
- JSONL append-only provides safe concurrent writes without locks
- Last-writer-wins per field merge strategy
- Plan items are shared (visible to all agents)
- Notes/decisions/learnings are local (per-agent ephemeral)
- No polling needed — reload-before-read is sufficient

### P3 — multi-agent coordination research (DEFERRED)

**Status:** Deferred. Research needed before implementation.

**Goal:** Research best approaches for concurrent scratchpad access, conflict resolution,
and cross-instance validation for the claim/conflict pipeline.

**Open questions:**
- Polling alternatives to reload-before-read (file watchers? inotify?)
- Concurrent validation for claim/conflict pipeline (how to prevent two agents from
  claiming the same task)
- Conflict resolution for simultaneous edits
- Best approach for cross-instance communication without a central server

### P3 — system architecture deep dive (COMPLETED 2026-07-13)

**Findings:** Complete system architecture map produced. Key learnings:

**Data flow:**
```
User Input → Input Polisher → Prompt Builder → LLM → Tool Execution → Enforcement → Output
                                   ↑                           ↓
                             Context Lifecycle           Memory System
                             (auto-compact,              (session recall,
                              proposals)                  scratchpad, memory_store)
```

**Key subsystems (all in `src/extensions/`):**
| Category | Sub-extensions | Role |
|---|---|---|
| `core/` | polyfill, agent-environment, prompt-builder, input-polisher | What LLM sees |
| `cognitive/` | metacognition, reasoning, sycophancy-detector, tool-safety, topic-drift, turn-outcome | Thinking + reasoning |
| `memory/` | three-memory-stores, memory-agent-bridge, session-recall, context-manager, context-lifecycle, scratchpad, workspace-snapshot | Remembering + persistence |
| `enforcement/` | (1 root + detection/handlers/substate) | Turn pipeline |
| `self/` | health-maintenance, error-tracking, watchdog, auto-recovery, latent-activator | Self-management |
| `heartbeat/` | heartbeat-scheduler, analytics | Background proactive |

**State management (from `src/lib/state/AGENTS.md`):**
- Per-extension, per-session: `getExtensionState(ctx, key, factory)`
- Process-global: `global-state.ts` (with explicit cache invalidation)
- Module-level `let` is banned except for documented exceptions
- The scratchpad uses `getExtensionState(ctx, "scratchpad-cache", ...)` — session-scoped

**Whisper delivery:**
- `sendTrackedMessage(pi, params, options, meta)` — the ONLY path for agent-bound messages
- `triggerTurn: true` — enforcement-critical (wakes agent)
- `triggerTurn: false` — advisory (agent sees on next turn)
- `log.*` routes to TUI when ctx is bound, to in-memory buffer when unbound

**Shipped improvements (this session, 2026-07-13):**
- [x] INTERACTION_STYLE cycle completed: "understand before you act" now includes the
  stopping condition ("then decide what to change and change it")
- [x] Behavior mode transition logging in TUI (log.info on mode change)
- [x] Verification judge regex heuristic removed — LLM evaluates tool log directly
- [x] `session action="batch"` — grep aggregation across all sessions

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