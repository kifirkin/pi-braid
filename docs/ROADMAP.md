<!-- status: current -->

# pi-braid Improvement Roadmap

**Status:** Active items only. Shipped/historical content archived at `../pi-braid-evaluation/docs-archive/`.

## Active items

### P3 — this session (2026-07-13)

**Implemented:**
- [x] **Whisper dedup fix (option #1)** — per-signal dedup for the
  `[braid-whisper - enforcement]` discoverability bundle. The old bundle-
  text dedup missed on content variations (e.g., `openPlans` count changing
  after a `/reload`). New `getShownSignals()` plus `DiscoverySignalType`
  union dedupes on TYPE (stable across content changes). Tests added
  (8 subtests). Audit of other whisper families (option #4) still pending.
- [x] **Post-compaction auto-resume** — `e6466868`. Moved re-orientation whisper
  back to `session_compact` with `triggerTurn: true` after discovering `compaction_end`
  is emitted via `this._emit()` (internal listeners only, not extensions).
- [x] **Auto-resume suppression for /compact** — `6f549d57`. `autoResumeAfterCompaction`
  flag set by `context_compress` tool, checked in `session_compact` handler. If user
  types `/compact`, flag is unset → whisper suppressed.
- [x] **Backward-checker ctx.signal** — `3aa5ba4d`. Replaced fixed 30s timeout with
  ctx.signal so ESC/shutdown aborts the check cleanly.
- [x] **Instance block expansion** — `d46d870a`, `6e39dfaa`. Shows other Pi instances
  in same cwd with PID, elapsed time, terminal, and "← current" marker.
- [x] **INTERACTION_STYLE cycle completed** — `56df3c7d`. "understand before you act"
  now includes the stopping condition ("then decide what to change and change it"),
  preventing the infinite analysis loop caused by commit 13994806.
- [x] **Finalize enforcements** — `1beb8ae0`. Three enforcements baked into the
  finalize tool: unresolved conflicts check (advisory), stronger unpersisted learnings
  warning (explicit "will be lost on shutdown"), and text-only response after work
  detection in register-message-end.ts (whisper suggesting finalize).
- [x] **CONCRETE_IDENTIFIERS invariant** — `2ae8fa59`. Prevents grounding failures
  by requiring concrete names (commands, paths, functions, event types) to be quoted
  from source. Never guess a concrete identifier.
- [x] **Remove behavior-modes system** — `2ae8fa59`. Deleted behavior-modes.ts,
  determineContrastMode, contrastMode signals. Distilled PLAN_BEFORE_ACT and
  TOOL_RELIABILITY directives into static identity invariants.
- [x] **Remove meaningless tests** — `2ae8fa59`. Deleted test-prompt-builder-directive.mjs
  (regex-matched source code strings — tests trivia, not behavior).

**Dismissed with reasons:**
- [x] **Whisper on `compaction_end`** — `compaction_end` is emitted via `this._emit()`
  (internal/TUI only), not `_extensionRunner.emit()`. Extensions never receive it.
  Reverted to `session_compact` with `triggerTurn: true`.
- [x] **Timer-based auto-resume** — Causes max call stack errors. Replaced with
  synchronous flag + event-driven approach.
- [x] **Dynamic behavior modes** — Added complexity (7 modes, signal routing, listener,
  state machine) for directives that are mostly evergreen. Distilled into static
  identity invariants.
- [x] **test-prompt-builder-directive.mjs** — Regex-matching source code strings tests
  nothing real. Removed.

### P3 — session analysis tools

**Status:** Epic A (batch) shipped. Epic B (analyze) shipped. Epic C (stats) shipped.

**Goal:** Mine 3 months of session data (318M, 318 braid sessions) for insights about
prompt effectiveness, behavior patterns, and failure modes.

**Epic A — `session action="batch"` — SHIPPED (2026-07-13, commit 36a0a724).**
Grep aggregation across all sessions by project and month, with timeline and top-N sessions.
No LLM, fast. Filters: `pattern` (required), `project` (defaults to cwd), `since` (optional date),
`limit` (max sessions, default 10).
Output: human-readable text (TUI-friendly) + structured `details` (following the `think` tool
pattern: `content` for human, `details` for agent).

**Epic B — `session action="analyze"` — SHIPPED (2026-07-14, commit 69dbb6bf).**
Multi-session LLM analysis. Accepts `sessionPaths: string[]`, `question: string`, `sample?: number`.
Per-session: parse JSONL → extract structured events (tool calls, verify, finalize, errors,
thinking, messages) via `analyze.ts` → compress to 1-2K token structured summary.
All summaries + question → main model with context-window windowing.
Progressive batching for large sample sizes. Output: human-readable text + structured details.

**Epic C — `session action="stats"` — SHIPPED (2026-07-14, commit 9b8e1d28).**
Session statistics overview. Total sessions, by project, date range, average size, top sessions by size. No LLM, fast. Supports filters: project, since, until, limit.

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

### P3 — braid-whisper hint investigation (BACKLOG)

**Status:** Not started.

**Problem:** The `[braid-whisper - prompt-builder] [hint]` whisper fires every `/reload`
and delivers generic/meaningless hints like "When working on 'session_outcome': Use memory
for other -> Read files to understand current state -> Use think for other".

**Root cause (identified):** Hints are consolidated from past session outcomes in
`~/.pi/agent/braid/consolidated-hints.jsonl` (20 entries). The `deliverRelevantHints()`
function in `src/lib/cognitive/hints.ts` runs on every `before_agent_start` (i.e., every
`/reload`). The utility model (if available) or a heuristic fallback scores hints against
the current task. The "session_outcome" hint has `project: "unknown"` and a generic
strategy that matches too broadly.

**Needs:**
- Investigate why hints fire on every `/reload` (should be once-per-session?)
- Determine if the utility model scoring is actually running or if it's the heuristic
  fallback producing false positives
- Consider: suppress hints on `/reload`, only deliver on fresh session start
- Consider: remove hints entirely if they provide no measurable value

### P3 — system prompt visibility investigation (BACKLOG)

**Status:** Not started.

**Problem:** The fully constructed system prompt is not visible anywhere. It is built
by `prompt-builder` (sections: identity, guidelines, skills, context, append) and
returned via `event.reply({ systemPrompt })` to pi-core, which sends it directly to
the LLM. It is NOT stored in session files (no `"role":"system"` entry in JSONL)
and NOT exposed via the RPC protocol's event stream.

**Current visibility options:**
- `--mode json` `agent_end` event has `messages[]` but no system prompt
- `--mode rpc` has no `system_prompt` event type
- Session JSONL files have no `"role":"system"` entry
- The prompt-builder `render()` functions produce the sections but they're assembled
  and returned to pi-core, never logged or dumped

**Needs:**
- Add a debug endpoint or whisper that dumps the assembled system prompt
- Or: add a `--debug-prompt` CLI flag that prints the system prompt before starting
- Or: store the system prompt in the session file as a `system` entry
- Primary use case: reflecting on the full prompt to debug prompt-builder changes

### P3 — verification judge false positive fix (BACKLOG, 2026-07-16)

**Status:** Root cause identified. Fix design ready. Deeper investigation planned.

**Problem:** The LLM-based verification judge fires false positives when the
agent's verification evidence (test runs, typechecks, builds) scrolls out of
the turnHistory window. The judge receives a tool log truncated to 50 entries,
300 chars per output, 8 outputs per turn. When verification commands happened
more than ~5 turns ago, they're missing from the window and the judge fixates
on the most recent tool calls (e.g., scratchpad planning).

**Root cause:** LLM recency bias in the judge. The judge's tool log window is
too narrow — it misses verification evidence that's more than a few turns old.
Confirmed by archaeology: the judge fired at 98% confidence claiming "no
verification evidence" despite `npm test` (58/58) and `npm run typecheck`
being in the tool log, just scrolled out of the 50-entry window.

**Immediate fix (small effort, high impact):**
- Add git history (`git log --oneline -5`) to the judge context. If the judge
  sees a commit that touches the changed files, that's stronger evidence than
  any tool output. The agent already commits and pushes — the git log is the
  ground truth.
- Location: `src/extensions/enforcement/verification-judge.ts` — add git
  history to the `JudgeContext` and `buildVerificationPrompt()`.

**Deeper investigation (roadmap):**
- Multi-round analysis: if the tool log is too long for a single window, the
  judge should request more context in a second round (focused on gaps)
- Chunked analysis: split tool log into chunks, analyze each, then aggregate
- Hybrid: git history + tool log excerpts + last-N-turn sliding window
- Track: how often does the judge actually fire? What's the false positive rate?

**Related: compaction summary format loses speaker attribution.**
When compaction happens, the output is a flat narrative. Questions, statements,
and decisions from different speakers are merged without attribution markers.
This caused the agent to misattribute its own question ("Want me to implement
one of these fixes?") as the user's question after compaction.

There are 3 compaction paths, each with different control:
1. **`context_compress` tool** (agent-initiated, via `/compact` or agent call) —
   agent controls the `summary` parameter. Fix: write summaries with explicit
   speaker labels (`<user>...</user>` / `<agent>...</agent>` blocks).
2. **Auto-compact** (pi-core, context threshold reached) — pi-core generates
   the summary. Braid cannot control the format.
3. **Overflow force-compact** (pi-core, critical context) — same as #2.

For paths 2 and 3, braid could listen to `session_compact` and emit a
supplementary whisper that re-contextualizes the compaction with proper
speaker attribution. This would overlay the missing structure onto
pi-core's native compact message.

### P3 — full Braid critical review (BACKLOG)

**Status:** Not started. High priority.

**Scope:** Full honest deep maximum critical review of Braid itself. Every subsystem,
skill, doc, and convention. Identify:
- Dead code, unused exports, orphaned modules
- Stale/wrong documentation (skills, AGENTS.md, ROADMAP, CHANGELOG)
- Over-engineered or under-engineered components
- Missing test coverage
- Architectural debt or unnecessary complexity
- Skill gaps (missing or misleading SKILL.md files)
- Duplicate or conflicting conventions
- Performance bottlenecks
- Security hardening opportunities

**Method:** Subagent-assisted. Spawn subagents to explore each subsystem,
cross-reference against docs, and report findings. Human reviews the findings
and prioritizes fixes.

### P3 — enforcement whisper deduplication (PARTIALLY FIXED 2026-07-16)

**Status:** Fix #1 (per-signal dedup) implemented. Audit of other whisper
families (fix #4) pending.

**Problem:** The `[braid-whisper - enforcement]` discoverability whisper
(`src/extensions/enforcement/handlers/register-session-start-discoverability.ts`)
appears to duplicate in the same `pi` session. The bundle includes up to 7
signals (scratchpad, episodes, semantic, prior sessions, resume, cross-session
tags, context hygiene tip) — when ANY signal content changes (e.g., the
`${openPlans} open plan items` count, `parts.join(", ")` from the resume file,
tag names list, goal text), the full bundle string changes and the
`globalThis["__braid_discoverability_shown"]` dedup misses.

Symptoms observed:
- Whisper visible immediately after `pi` startup with `0 open plan items`
- Same whisper visible again after `/reload` if the scratchpad was modified
  between reloads (count changes → bundle string changes → dedup miss)
- Same whisper visible if the bundle fires BOTH on SESSION_START AND on some
  re-emitting path (need to confirm with timing log)
- Same pattern likely affects other `[braid-whisper - <source>]` families:
  heartbeat analytics, three-memory-stores recall, tool-loop nudges,
  enforcement turning-point advisories

**Root cause hypotheses:**
1. Bundle dedup is exact-string-match on the joined signal text. Any dynamic
   content (counts, dates, slice(0,80) of goal text) bypasses dedup.
2. The `globalThis` Set key is namespaced by plugin but not by signal content.
   A per-signal dedup would catch individual repeats better.
3. The SESSION_START coordinator fires once per pi runtime (2026-07-02 fix),
   but the Background phase is fire-and-forget — if the handler throws or
   yields before the dedup check, a retry path could re-fire (need timing log).

**Fix #1 shipped (2026-07-16, commit f4fdb40a followup):**
- Added `DiscoverySignalType` union + `getShownSignals()/isSignalShown()/markSignalShown()`
  helpers in `src/lib/state/global-state.ts`. Process-global via `globalThis`,
  survives `/reload`.
- Refactored `register-session-start-discoverability.ts` to tag each signal
  with a TYPE (`scratchpad_prior`, `memory_prior`, `sessions_prior`, `resume`,
  `tags_prior`, `context_hygiene_tip`). Only UNSEEN TYPES are bundled and shown.
- Added test `test-discovery-per-signal-dedup.mjs` (8 subtests) verifying
  behavior. All 41 tests pass.
- Bundle-text dedup (`getShownDiscoveryBundles`) kept for backward compat.

**Remaining (option 4 from the proposed fixes):**
- Audit other `[braid-whisper - <source>]` families for the same pattern.
  Known candidates:
  - Heartbeat cadence (whisper might re-fire after recovery from suppressed mode)
  - Three-memory-stores recall (re-fire on /reload or tool guard)
  - Tool-loop detector (escalation chain could re-emit same level)
  - Enforcement turning-point advisers (per-source dedup checks vs errors)
- Verify timing: add log to confirm SESSION_START does NOT fire multiple
  times per session (separate from dedup hypothesis).

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