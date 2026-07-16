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

### P3 — verification judge false positive fix (SHIPPED, 2026-07-16)

**Status:** Immediate fix shipped. Deeper investigation deferred.

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

**Deeper investigation (roadmap, deferred):**
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

### P3 — pi-core compatibility refactoring (2026-07-16)

**Status:** Planned. Root cause analysis complete.

**Goal:** Make braid resilient to pi-core updates and leverage new pi-core features
(deferred tool loading) to reduce prompt bloat.

#### Problem: 20+ tools registered eagerly

braid registers all 20+ tools on every session. The model sees every tool
definition in the system prompt, even tools it rarely uses (context management,
memory, session analysis). This wastes prompt tokens and creates noise.

pi-core 0.80.7+ introduced `pi.setActiveTools()` for deferred/dynamic tool
loading. Models with native support (Anthropic 4.5+, OpenAI GPT-5.4+) preserve
the cached prompt prefix and load definitions at the tool-result position.
Other models use a fallback that still reduces initial prompt size.

**Proposed active set:**
- **Always active** (10): `think`, `verify`, `hypothesize`, `finalize`,
  `scratchpad`, `topic_drift`, `workspace_snapshot`, `timer`, `behavior`, `sleep`
- **Deferred** (10+): `context_inspect`, `context_compress`, `context_navigate`,
  `memory`, `memory_store`, `conflict_qa`, `explore_paths`, `session`,
  `prompt_inspect`, `error`, `health_maintenance`, `web_fetch`, `batch_web_fetch`

**Implementation plan:**
1. Categorize all tools into active vs deferred groups
2. Create a loader mechanism (e.g., `search_tools` or group activation via
   pi.setActiveTools())
3. Activate tool groups on demand (e.g., using `context_inspect` activates
   `context_compress` + `context_navigate`)
4. Test with both native deferred-loading models and fallback models

#### Problem: Polyfill fragility (`as any` pattern)

The `polyfill/index.ts` accesses `(modelRegistry as any).runtime` to get the
`ModelRuntime` instance. This is a private field access — it breaks when
pi-core renames or restructures internal fields. The 0.80.8 fix was exactly
this: `ModelSelectorComponent`'s 4th param changed from `ModelRegistry` to
`ModelRuntime`.

**Implementation plan:**
1. Extract version detection from `instance-composition.ts` into
   `src/lib/state/pi-version.ts` (reusable, testable)
2. Build a `VersionGate` that maps pi-core version → polyfills needed;
   falls back to a warning log for unknown versions
3. Replace `(modelRegistry as any).runtime` with version-gated access
4. Add `/braid-status` command showing: pi-core version, active polyfills,
   active tool count, deferred tool count

#### 0.80.8 → 0.80.9 diff analysis (2026-07-16)

**Verdict: No breaking changes.** The pi-core types diff shows:
- `extension-api.d.ts` — unchanged (no API surface changes)
- `extension-context.d.ts` — unchanged (no context changes)
- `extension-events.d.ts` — unchanged (no event changes)
- `model-config.d.ts` — adds `deferredToolsMode: "kimi"` field in 5 places
  (purely additive, optional)
- `agent-session-runtime.d.ts` — no diff
- `model-resolver.d.ts` — no diff
- `index.d.ts` (public exports) — no diff

Only change: `deferredToolsMode` type for Kimi K3 deferred tool loading.
Completely optional — braid doesn't use it. No action needed for 0.80.9.

### P3 — contrib extraction (2026-07-16)

**Status:** Planned. Extraction plan documented.

**Goal:** Extract generic tools from braid into
[pi-braid-contrib](https://github.com/earendil-works/pi-braid-contrib)
so they're available to non-braid pi users.

**Principle:** Generic tools belong in contrib. Braid-specific tools (those
that depend on braid's internal state, enforcement, or metacognitive
infrastructure) stay in braid. The boundary: *"would this tool be useful
 to a pi user who doesn't run braid?"*

#### Tier 1: Extract now

| Tool | File | Dependencies to resolve |
|------|------|------------------------|
| `workspace_snapshot` | `src/extensions/memory/workspace-snapshot/index.ts` | `lib/state/workspace-snapshot.ts` (434 lines, inline), `bidirectional-verifier.ts` (simplify to caller-passed file list), `logger.ts` (contrib has own), `braid-paths.ts` (use `~/.pi/agent/braid/snapshots/` directly), `extension-state.ts` (replace with simple Map) |
| `timer` | `src/extensions/scheduling/timer/index.ts` | `extension-state.ts` (session-scoped state — replace with simple session-scoped Map), `logger.ts` (contrib logger) |

#### Tier 2: Extract after refactoring

| Tool | Prerequisite |
|------|-------------|
| `behavior` | Split enforcement dependency out |
| `web_fetch` / `batch_web_fetch` | `lib/ai/model-resolver.ts` (vision model), `logger.ts` |

#### Tier 3: Keep in braid (braid-specific)

`think`, `verify`, `hypothesize`, `finalize`, `scratchpad`, `memory`,
`memory_store`, `conflict_qa`, `explore_paths`, `session`,
`context_inspect`, `context_compress`, `context_navigate`, `prompt_inspect`,
`topic_drift`, `error`, `health_maintenance`

#### Workspace snapshot — detailed extraction plan

**Current architecture (in braid):**
```
workspace-snapshot/index.ts
  ├── import { captureSnapshot, ... } from lib/state/workspace-snapshot.ts
  │   ├── import { BRAID_DIR } from lib/config/braid-paths.ts
  │   ├── import { createLogger } from lib/core/logger.ts
  │   ├── import { callScratchpadTool, ... } from lib/state/extension-state.ts
  │   └── import { ExtensionContext } from @earendil-works/pi-coding-agent
  └── import { getVerifierState } from lib/store/bidirectional-verifier.ts
```

**Target architecture (in contrib):**
```
workspace-snapshot/index.ts
  ├── import { createLogger } from ../logger.ts (contrib's own logger)
  ├── import { ExtensionContext } from @earendil-works/pi-coding-agent
  └── (inline snapshot logic, or extract to workspace-snapshot/lib.ts)
```

**Changes needed:**
1. Replace `braid-paths.ts` → hardcoded `~/.pi/agent/braid/snapshots/`
2. Replace `bidirectional-verifier.ts` → caller-passed `files[]` parameter
3. Replace `extension-state.ts` → simple Map keyed on session ID
4. Replace `createLogger` → contrib's logger
5. Inline workspace-snapshot.ts core logic (434 lines)

## Companion documents

- [`docs/HISTORY.md`](HISTORY.md) — consolidated history including fragile heuristics, archaeology, proposals, and D-57
- `../pi-braid-evaluation/docs-archive/` — all completed audits and shipped proposals (historical reference)

## History

The full 2,500+ line roadmap was consolidated here on 2026-07-10.
Every shipped item was verified: 84/84 tests pass, typecheck clean,
doc checks clean (55/55). Historical content preserved at
`../pi-braid-evaluation/docs-archive/`.

## Archived items

### P3 — context hygiene & system prompt refinement (2026-07-16)

**Status:** Investigation phase. Root cause analysis needed.

**Problem space:** Context grows unboundedly. The agent has tools to manage
it (compact, navigate, inspect, prune) but lacks clear guidelines on when
to use which. Tool descriptions and system prompt guidelines are redundant
in places, missing in others. The result: the agent rarely uses these tools
proactively, and context bloat drives up token costs and judge false positives.

#### Sub-problem 1: Tool descriptions vs system prompt guidelines overlap

The system prompt has two layers that describe tools:
1. **`toolsSection()`** — lists every tool with a `promptSnippet` / first sentence
   of description, plus generic guidelines ("Prefer clear, direct responses")
2. **Each tool's own `description`** — visible to the model when it decides
   which tool to call

These layers are redundant. The tool description already says what it does.
The system prompt's tool list should be a *pointer* (name + one-liner), not
a re-description. The guidelines should cover *when to use which tool*
(e.g., "Use context_navigate for exploration, context_compress to free space").

**Action:**
- Review pi-core's own tool descriptions and system prompt tool listing
  pattern (pi's `_rebuildSystemPrompt` + `system-prompt.js`)
- Audit braid's `toolsSection()` against pi-core's pattern
- Move usage guidance out of tool descriptions into a dedicated
  "Context management strategy" guideline block
- Eliminate redundancy between tool `description` and `promptSnippet`

#### Sub-problem 2: Context navigation vs compaction — could navigate replace compact?

`context_navigate` (log → tag → checkout) lets the agent move through history.
`context_compress` (compact → archive → deep_clean) frees token space.

These are complementary: navigate is *exploration* (see what happened),
compress is *reclamation* (free space for new work). But the agent often
reaches for compress when it really needs navigate, and vice versa.

**Question:** Could `context_navigate(action='checkout')` with a good tag
structure replace the need for compaction entirely? If the agent can always
jump back to a known-good state, does it need to destroy history?

**Constraints:**
- pi-core auto-compacts at context threshold regardless of braid's preferences
- Overflow force-compact is non-negotiable (pi-core needs the space)
- But the agent-initiated `context_compress` could be de-emphasized in favor
  of `context_navigate` + better tagging discipline

**Action:**
- Design a tagging discipline that makes navigate-as-primary viable
- Add a guideline: "Tag milestones with context_navigate(action='tag').
  Use context_compress only when pi-core warns about context limits."
- Test: can the agent complete a full session using only navigate without
  ever hitting the auto-compact threshold?

#### Sub-problem 3: Lightweight tool-pruning via whisper

braid already has:
- `context_inspect` (audit context health)
- `context_compress` (remove obsolete/duplicate entries)
- `pruning.ts` (remove duplicate tool outputs based on content hash)
- Heartbeat whisper (context usage percentage)

What's missing: a lightweight whisper that tells the agent *which specific
redundant content* to prune, not just that context is high. The agent should
be able to act on the whisper directly.

**Proposal:**
- Add a context-hygiene whisper that fires at 50%/70%/85% context usage
- The whisper includes: current context %, top 3 prune candidates from
  context_inspect, and a suggested action ("context_compress(action='compact',
  keep=10)" or "context_navigate(action='tag', name='before-cleanup')")
- The whisper uses `triggerTurn: false` (advisory, not interruptive)
- Integrate with existing heartbeat cadence to avoid duplication

**Action:**
- Add context-hygiene whisper to heartbeat-scheduler
- Include: context %, prune candidate count, suggested tool call
- Test: does the agent act on the whisper? Does it reduce context bloat?

#### Sub-problem 4: Session resume flooding

`pi --session <session_id>` (or `pi --resume`) triggers a full SESSION_START
event, which fires the discoverability whisper bundle (scratchpad, memory,
sessions, resume, tags, context hygiene). This creates a flood of context
at resume time — the agent sees the same discoverability bundle it already
saw before the session was interrupted.

**Root cause:** The discoverability handler fires on SESSION_START, which
runs on both fresh start AND resume. The per-signal dedup (`isSignalShown()`)
uses `globalThis` — process-global state that survives /reload but NOT
process restart. Between `pi --session` invocations, the process dies and
`globalThis` resets, so all signals appear "new" again.

**Proposed fixes:**
1. Persist `shownSignals` to disk (append-only JSONL, same pattern as
   scratchpad) so they survive process restart
2. On resume, skip the discoverability bundle entirely (the agent already
   knows the environment from the previous session)
3. Or: reduce the bundle to a single line on resume ("Resuming session. Use
   scratchpad to see prior state.")

**Action:**
- Investigate: how does `pi --session` trigger SESSION_START vs fresh start?
- Implement fix: persist shown signals, or skip bundle on resume

### P3 — compaction speaker attribution (2026-07-16)

**Status:** Design phase. Not implemented.

**Problem:** When compaction happens, the output is a flat narrative.
Questions, statements, and decisions from different speakers (user vs agent)
are merged without attribution markers. This causes the agent to misattribute
its own questions as the user's after compaction — a confusion that compounds
over multiple compaction cycles.

**Three compaction paths, three levels of control:**

1. **`context_compress` tool** (agent-initiated, via agent call or `/compact`) —
   agent controls the `summary` parameter. Fix: write summaries with explicit
   speaker labels (`<user>...</user>` / `<agent>...</agent>` blocks).
2. **Auto-compact** (pi-core, context threshold reached) — pi-core generates
   the summary. Braid cannot control the format.
3. **Overflow force-compact** (pi-core, critical context) — same as #2.

**For paths 2 and 3:** braid can listen to `session_compact` and emit a
supplementary whisper that re-contextualizes the compaction with proper
speaker attribution, overlaying the missing structure onto pi-core's native
compact message.

**Action:**
1. Update `context_compress` tool to write summaries with speaker labels
2. Add `session_compact` listener that emits a re-attribution whisper
3. Test with all three compaction paths

### P3 — input polisher extraction & identity improvement (2026-07-16)

**Status:** Investigation phase.

#### Extraction to contrib

The input polisher (`src/extensions/core/input-polisher/`) is a standalone
extension that hooks the `input` event. It has no dependency on braid's
enforcement or metacognitive systems. It's a strong candidate for contrib.

**Dependencies to resolve:**
- `lib/ai/llm-call.ts` — LLM call for polishing (contrib can use pi's own
  `callLlm` or reimplement a simpler version)
- `lib/ai/model-resolver.ts` — utility model resolution (can be replaced with
  direct `ctx.model` access for the simpler contrib version)
- `lib/ai/language-hint.ts` — language detection (lightweight, can inline)
- `lib/state/extension-state.ts` — session-scoped state (replace with simple Map)
- `lib/core/logger.ts` — contrib has its own logger
- `input-critic.ts`, `consolidated-input-critic.ts` — input classification
  logic (must be extracted alongside)

**Action:**
1. Create standalone input-polisher in pi-braid-contrib
2. Replace braid-internal deps with standalone equivalents
3. Register in contrib's EXTENSIONS map
4. Test syntax + basic flow

#### Identity improvement: proactive user input validation

Beyond proofreading, the input polisher should detect when user input could
contain mistakes that would invert expectations. This is a design research
question:

- What kinds of mistakes invert expectations? (e.g., "delete the production
  DB" vs "delete the staging DB", wrong file paths, contradictory instructions)
- How should braid's identity interact with this? (nudge vs block vs ask)
- What's the pi+braid way? (whisper with triggerTurn:true for critical,
  advisory nudge for minor)

**Proposal:** Add a second stage to the input polisher that runs a lightweight
semantic check on the user's input. If the check detects a high-risk pattern
(e.g., dangerous commands, contradictory requirements, underspecified
destructive operations), the polisher emits a whisper before the agent
processes the input.

**Action:**
- Research: what patterns are worth detecting?
- Design: whisper format, trigger conditions, false positive mitigation
- Implement: second stage in input polisher (or new lightweight extension)

### P3 — forward-looking proposals (consolidated 2026-07-16 from docs/proposals/)

**Status:** Forward-looking. Not implemented.

Three proposals consolidated from `docs/proposals/` (directory deleted).

#### Proposal 1: Better finalization practices

**Problem:** `finalize` doesn't clean up scratchpad (done items accumulate), uses
wrong model tier for system operations (session model instead of max-power), and
emits no event bus signal for other extensions to react.

**Proposed flow:**
1. Emit `TaskCompletedEvent` on event bus after `recordToMemory`
2. Scratchpad listens for event → auto-archive done items
3. Consolidation pipeline uses max-power model instead of session model
4. MARS reflection triggers on event instead of `actualTools.includes("finalize")`

#### Proposal 2: Skill discovery — semantic matching + usage signal

**Problem:** Skills are discovered by substring match on `description`. No
mechanism suggests the *set* of skills relevant to a task before work starts.
No signal separates repeatedly-useful skills from one-shot drafts.

**Proposed:**
1. Token matcher: extract nouns/verbs from user request, compute word-overlap
   score with skill names+descriptions, return top 5
2. Inject ranked skill list as a "Relevant skills" block before the standard
   skill-read instruction
3. Usage tracker: at session end, log which skills were read. Repeatedly useful
   skills float to the top automatically.

#### Proposal 3: Skill quality audit — tier-0 pipeline

**Problem:** 24 skills exist, many written in one session and never revisited.
No process for catching stale guidance, broken cross-references, or skills that
were useful once but misleading in other contexts.

**Proposed procedure (add to meta-improvement skill):**
1. Inventory: collect all SKILL.md frontmatter, identify missing fields
2. Cross-reference check: verify `see-also` links are reciprocal
3. Command verification: extract and test shell commands from skills
4. Session usage check: query memory store for 30-day usage
5. Promotion gate: tier-0 with ≥2 successful outcomes → promote to tier-1
6. Report: write audit report to `docs/audit/SKILL-AUDIT-<date>.md`

---

### P1 — compat subpath cleanup (archived 2026-07-13)

**Status:** Won't fix. The compat import from `@earendil-works/pi-ai/compat`
works correctly and the migration path is fully documented in the source
(`src/lib/ai/llm-call.ts` module-level comment). The migration requires
cross-repo changes to pi-braid-providers (registering custom providers on the
Models instance via `createProvider()` + `setProvider()`), which risks breaking
custom provider registrations (a0venice, openrouter-custom). The documented
migration path serves as sufficient documentation for any future maintainer.
The code comment at `src/lib/ai/llm-call.ts:31-53` describes the exact steps.