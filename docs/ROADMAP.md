<!-- status: current -->

# pi-braid Improvement Roadmap

**Status:** Active items only. Shipped/historical content archived at `../pi-braid-evaluation/docs-archive/`.

## Active items

### P3 — this session (2026-07-13)

**Implemented:**
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