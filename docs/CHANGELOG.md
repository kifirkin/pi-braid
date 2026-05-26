# Changelog

All notable changes to pi-braid are documented here.

## v0.2.6 (2026-05-26)

### Revival — Structural Cleanup

- **Nudge module removed** (was duplicating enforcement's turn_end nudges).
- **~2500 lines of dead code removed:** judge.ts, prompts.ts, event-consumers.ts, behavioral-state.ts, bidirectional-verifier Phase 2/4.
- **BehavioralState decomposed** into 4 focused sub-states (MemoryHygieneState, ScratchpadState, ContextHygieneState, ThoughtChainState).
- **as EnforcementState cast removed** — TypeScript now verifies the spread composition.
- **Turn-end coordinator created** (`lib/turn-end-coordinator.ts`) — priority-ordered handler dispatch. Claim tracker extracted from monolithic handler.
- **Advice tracker** (`lib/advice-tracker.ts`) — Dreamer/MARS predictions now get evaluated after 10 turns; thresholds adjust dynamically based on accuracy.
- **Analytics hot-path sync I/O** converted to async append.
- **Paper citations fixed** — 5 files updated to accurately describe heuristic implementations.
- **`get-session-metrics` and `get-tool-reliability` tools** implemented (were stubs).
- **safeSessionManager** now logs warning on stale ctx instead of silent failure.
- **7 new test files, 66 new unit tests** covering 11 lib modules.
- **Test suite: 63/63 pass** (previously 56/57 + 1).

## v0.2.5 (2026-05-14)

### Compaction Resume Fix (v2)

- Timer now scheduled from `context_compact` tool execute BEFORE `ctx.compact()` — reliable even if compaction disconnects the agent.
- Removed unreliable programmatic timer from `compaction_end` handler (steer/timer messages from inside compaction events don't reliably wake the agent).
- Tool description warns agent to set its own timer with task context.

## v0.2.4 (2026-05-14)

### Compaction Loop-Break Fix

- **Root cause**: Compaction success returned silently — agent stall mid-loop after context_compact tool.
- **Fix**: `compaction_end` injects steer message on success so agent continues without manual prompt.

### User Message Preprocessor Race Fix

- **Root cause**: Preprocessor ran during active compaction, corrupting input flow.
- **Fix**: Skip preprocessing when `_compactionActive` is true (reads shared flag exported from context-manager/shared.ts).
- **Added**: session_start lazy-import of `isCompactionActive()` from shared.ts to avoid circular dependency.

### Internal

- **Race condition**: `connectLock` in pi-browser extension was dead code — connection lock now properly acquired and released.
- **Session leak**: `sessionCleanup` stored only the last tab's event handler — now uses array.
- **Shared state**: `_compactionActive` moved from compaction.ts to shared.ts with getter/setter pattern.

## v0.2.0 (2026-05-08)

### Whisper Bugfixes (2026-05-11)

- **SOP coach**: Fixed literal `"msg"` string used instead of `sopSummary` variable — SOP suggestions now actually contain SOP content.
- **Budget module**: Per-step per-threshold cooldown via `Set` tracking — 80/90/100% budget whispers no longer fire on every turn.
- **Context-hygiene**: 20-turn cooldown for high-density whispers, 15-turn for duplicate detection.
- **SOP suggestion**: Per-episode dedup via `alreadySuggestedIds` Set — same episode not injected multiple times.
- **Heartbeat whispers**: Batching — buffer + flush aggregated `[Heartbeat Summary]` instead of N separate injected messages per tick.
- **Cross-session memory**: `retrieveByRUMS` now filters out episodes from foreign sessions.

### Tool Description Rewrites

- All 38 tool descriptions rewritten so `firstSentence()` extracts both _what_ and _when_ — uses em dash separator to keep "use when" advice within the first sentence boundary.
- Tools affected: cognitive-systems (5), verification (2), topic-drift (2), context-manager/tools (7), context-lifecycle (2), session-recall (2), three-memory-stores (2), analytics (5), diff (1), healthcheck (1), observatory (1), system-monitor (1), research (1), timer (2), latent-activator (behavior + mix, 4), evolve (1).

### Compaction Mid-Turn Fix

- **Root cause**: `ctx.compact?.()` in context-hygiene's auto-compact path called pi core's `compact()` which runs `_disconnectFromAgent()` + `abort()` (agent-session.js:1245), killing the agent stream mid-turn.
- **Fix**: Replaced with high-priority whisper suggesting the agent call `context_compact()` tool instead.

### Context Density Noise Tuning

- Context-lifecycle policy engine: density-low-prune 60s→120s cooldown, duplicates-dedup 45s→120s.
- Heartbeat context-hygiene: density whisper 10→25 turns, duplicates 15→25 turns, projection whisper added 20-turn cooldown (was unlimited).

### Test Fixes

- **test-web-fetch-headers.mjs**: Gracefully skips when pi-web-fetch extension isn't installed (now built into pi-coding-agent core).
  **64/64 tests passing.**

### Cleanup

- Removed legacy `~/.pi/memory/memory.json` (143KB, migration code handles ENOENT gracefully).
- Archived `NEXT-PHASE-PROPOSAL.md` to `docs/proposals/` (Phase B is manual smoke testing).

### Publishing Readiness

- **package.json**: Version bump to 0.2.0. Added `files`, `exports`, `bugs`, `homepage`, `prepublishOnly`, `prepare` scripts.
- **README.md**: Complete rewrite — architecture diagram, extension table, installation, configuration, skill catalog.
- **CONTRIBUTING.md**: New file — dev setup, code style, extension anatomy, testing, PR process.
- **.gitignore**: Added compiled output dirs (`extensions/`, `lib/`, `modules/`) and session HTML files.
- Removed stale session HTML exports from root (~10MB).
- Removed 8 stale extension docs for deleted features (prompt-guardian, browser, repl, docs, codebase-tree, codebase-graph, planner, vision, web-fetch).
- Removed `docs/.archive-old/` directory.

### Path Consolidation

- All braid storage consolidated under `~/.pi/agent/braid/` via `src/lib/braid-paths.ts`.
- Eliminated all hardcoded `~/.pi/` paths from source code (16 files updated).
- Added centralized constants: `METRICS_FILE`, `LOGS_DIR`, `BRAID_PROJECTS_DIR`, `HEALTHCHECK_DIR`.

### Memory Unification

- Cognitive-memory migrated to `braid/memory/semantic.json` with automatic legacy fallback.
- Memory deep merge: `memory_recall`, `memory_list`, `memory_store`, `memory_get` all cross-search both semantic and episodic stores.
- `memory_store(type=episodic)` now also populates three-memory-stores.
- 174 legacy memories imported; 47 episodes consolidated.

### Code Quality

- Fixed sync I/O in async functions (`edit-helper.ts`) — `readFileSync`/`writeFileSync` → `await readFile`/`writeFile`.
- Fixed silent catch blocks (`whisper.ts`, `healthcheck/helpers.ts`) — now log warnings.
- All `sendTrackedMessage` calls have explicit `triggerTurn` values (21 calls audited).
- Removed unused `os`/`homedir` imports from 3 files.

## v0.2.0-alpha.5 (2026-05-07)

### Bug Fixes

- **ctx.compact() API fix**: `pi.compact()` doesn't exist - `compact()` is on `ctx` (ExtensionContext), not `pi` (ExtensionAPI). All context-manager tools and handlers updated. `keep` parameter changed to `customInstructions` (CompactOptions only supports customInstructions, onComplete, onError).
- **Cognitive nudge suppression (root cause fix)**: `disableConfirmations: true` was silently suppressing ALL cognitive whispers (enforcement nudges, heartbeat context-hygiene, analytics addiction/degradation, feedback) because 4 extensions incorrectly used it as the gate for advisory messages. Semantic mismatch: `disableConfirmations` was for Y/n blocking dialogs, not soft context-aware nudges. Fix: created `src/lib/braid-settings.ts` with two separate flags — `isConfirmDialogDisabled()` (pi-native, for dialogs) and `areCognitiveNudgesDisabled()` (braid-specific, for cognitive whispers, default false = ON). All 4 `isAutoConfirmEnabled()` copies replaced with the appropriate flag. Added `log.debug()` when suppression fires. Removed `braid.modules` from `settings.json` — all defaults now used (core, cognitive, memory, heartbeat, retry, prompt, tools, assistant).
- **Path consolidation to `~/.pi/agent/braid/`**: All braid-specific storage consolidated under `~/.pi/agent/braid/` for discoverability and easy backup. New layout:
  - `~/.pi/agent/braid/memory/semantic.json` — cognitive-memory semantic store
  - `~/.pi/agent/braid/memory/episodes.jsonl` — three-memory-stores retrospective episodes
  - `~/.pi/agent/braid/checkpoints/` — state-checkpoint snapshots
  - `~/.pi/agent/braid/errors/` — error-capture classified errors
  - `~/.pi/agent/braid/feedback/` — feedback preferences + analytics
  - `~/.pi/agent/braid/retry-state.json` — retry command state
  - `~/.pi/agent/braid/session-recall.json` — session recall config
  - `~/.pi/agent/braid/scratchpads/` — scratchpad task state
  - `~/.pi/agent/braid/tools-config.json` — custom tools config
  - `~/.pi/logs/braid-metrics.jsonl` — analytics (logs dir, appropriate)
  - `~/.pi/memory/memory.json` — cognitive-memory legacy (migration compat)
    Existing files migrated automatically. Created `src/lib/braid-paths.ts` as single source of truth for all paths. Removed `~/.pi/prompt-guardian/` directory.
- **Session persistence after compaction (root cause fix)**: Previously we fixed symptom (intercept state cleanup) but the REAL root cause was `sessionManager._persist()` has a no-assistant guard that returns early without writing to disk if there's no assistant message yet. This caused pre-appended user messages during compaction to be stored in memory but NOT written to disk, making them lost on session reload. Fix: after pre-appending queued user message to sessionManager, call `forcePersistSession()` which manually writes all pending entries to disk, bypassing the no-assistant guard.
- **Whisper delivery timing**: Non-critical advisories now use `deliverAs: "hint"` (visible in TUI, no hidden turn). Critical signals (error bursts, degradation, blocks, retry) use `triggerTurn: true`. Removed BPE duplicate from heartbeat/analytics (only enforcement handles it). MARS, dreamer, BPE recommendations → hint. Error bursts → critical.

### Refactor

- `sendEnforcementWhisper()` signature: Added `critical` boolean parameter (default: false). Non-critical whispers use `hint`, critical use `triggerTurn`.
- State management refactored: enforcement functions now consistently use `getState(ctx)` for session-scoped state instead of deprecated global `state`. Functions updated: `detectMalformedToolCalls`, `detectMissingVerification`, `recordCodeChange`, `recordToolCall`.
- Intercept state cleanup: now cleared on ALL `compaction_end` exits (not just abort). Also cleared on `session_shutdown` to prevent stale intercept between sessions.
- Removed duplicate `getNextRecommendation()` call from heartbeat/analytics (was duplicating enforcement's BPE handling).
- All enforcement whispers preserved with `display: true` - nothing hidden from TUI.

---

## v0.2.0-alpha.4 (2026-05-06)

### Bug Fixes

- **Session persistence after compaction**: Fixed `_processedCompacts` deduplication guard missing + stale intercept on sessionManager after reload/newSession. 5 sub-fixes: `_interceptActive` flag, `_interceptedSmRef` tracking, `tryRestoreAppendMessage()`, `clearInterceptState()`, `message_end` backup handler. Compaction.ts handler now handles session replacement gracefully.

### Features

- **BM3 complex multi-step benchmark**: 5 tasks with nested complexity (flatten custom iterators, generators, mixed, depth variance, empty/singletons).
- **run-compare-modes.mjs**: Naked vs braid comparison script.

---

## v0.2.0-alpha.2 (2026-04-30)

### Features

- **Compaction v0.26 — message preservation**: User messages sent during compaction are now preserved in the session tree. Root cause: TUI's `rebuildChatFromMessages()` runs before `flushCompactionQueue` delivers the queued message. Fix: pre-append user message to sessionManager in `session_compact` (fires before compaction_end), intercept `appendMessage` to skip duplicate from `flushCompactionQueue`'s `session.prompt()` call.
- **Compaction v0.23+ — smart pre-filtering**: `session_before_compact` now runs two-step pre-filter: (1) `filterSafeToRemove()` removes 100%-safe redundant messages, (2) `semanticCompress()` compresses semantic units before LLM summarization fires.
- **P1.7 — session isolation for memory contamination**: `Episode` interface now includes `sessionId` field. `MemoryStoresState` tracks `currentSessionId` on `session_start`. All new episodes tagged with their session. `retrieveByRUMS()` marks results with `_crossSession` flag when episode.sessionId !== currentSessionId. Heartbeat-scheduler's `MemoryStoresState` mirror updated.
- **P2.1 — auto-trigger degrade detection**: `analytics` `turn_end` handler now checks `isDegraded()` every turn. On first detection: emits `stability/decline` signal + whisper `[health] Degradation detected: ...`. On recovery: sends `[health] Performance recovered to healthy.` Uses `wasDegraded` flag for one-shot alerting per session. `SignalSeverity` type extended with `"error"`.
- **Contrast phrase library**: `contrast-phrase-library.ts` — mode-driven phrase selection (TRUTH-SEEKING, CORRECTION, EPISTEMIC-CALIBRATION, TOOL-RELIABILITY) mapped from `determineContrastMode()`. Integrated into prompt-builder §8c.
- **Per-scenario RepE toggle (P0.3)**: `enforcement` emits `enforcement_signals` events with `contrastMode` field. `prompt-builder` listens via `events.on("enforcement_signals")` and sets `ps.activeContrastMode`. `formatContrastSection()` renders mode-specific phrases.
- **Analytics density dashboard**: `analytics` tool output now shows `Context Density` percentage alongside session duration and tool call counts.
- **Episodic extraction**: Reasoning chains (3+ consecutive reasoning messages) now auto-extracted as episodes in `three-memory-stores` via `addEpisode()` on the `context` handler. Extracts task description + tool sequence from block content.
- **P0.4 structured format REMOVED**: TOOL_RESULT/STATUS/DATA/RESULT blocks + XML-style `<result>` tags caused "Tool not found" errors — weaker LLMs confused structured text with API-level tool calls. Removed entirely. Chain-of-thought `>` prefix, code block language tags, and tables preserved.
- **hypothesize throws on failure**: Changed from returning error-as-text to throwing `Error(...)`. Now `tool_execution_end` fires with `isError: true` for analytics to detect.
- **`_braidInjected` tagging**: All pi.sendMessage injection calls now tagged with `details._braidInjected: true`. `filterSafeToRemove()` strips these from compaction summaries so enforcement/timer/retry nudges don't conflate with real user messages.
- **P2.2 — Heartbeat event bus formalization**: Created `src/lib/agent-events.ts` — unified `AgentSignal` type taxonomy documenting all 10 signal domains. Added `memory` to `SignalSource` type. Added `memory_contamination` policy rule (Rule 7) to belief-policy-engine: fires when cross-session memories are retrieved, recommends verifying before acting.
- **P2.3 — Memory contamination architecture**: `deriveProjectId()` normalizes `cwd` to a stable repo-level project identifier (top 2 path components, e.g. `pi-braid/src` → `pi-braid/src`, `vibe/app/components` → `app/components`). Used by both `retrieveEpisodes()` and `addEpisode()`. `retrieveEpisodes()` also applies -0.7 cross-project penalty (memories from other projects effectively excluded). `emitSignal(memory/contamination)` fires when cross-session episodes surfaced via `whisperRecall`. Retrieved episodes include `memoryConfidence` field with 7-day half-life decay. Search results and whispers show project, ttl, confidence%, and `[CROSS-SESSION]` tags.
- **REPL verbose output**: `formatVerbose()` shows `[repl #N] code => result` format. Full code in `details.code` for analytics. Result preview for single-line format. rlmHistory limit 100→500.
- **Recursive Verification Tool**: New `verify` tool in `metacognition/handlers/verify.ts` — validates code/reasoning/plans/results with three depth modes (quick/standard/deep). Heuristic checks: unmatched braces, dangerous patterns (eval, innerHTML XSS), TODO markers, absolute language, placeholder content, missing exit criteria. Auto-detects target from recent context. Records verification in state for finalize pre-flight.
- **ODAR Fast/Slow Routing**: New `estimateComplexity()` and `complexityToDepth()` in `metacognition/handlers/think.ts` — scores task text 0-1 from length, technical keywords (architecture, middleware, async, deploy), step indicators. Routes: 0-0.3→quick, 0.3-0.7→standard, 0.7+→deep. New think tool params: `complexity` (explicit score) and `auto_depth` (auto-estimate). Output shows 'Routing: ODAR auto' when auto-estimated.

### Bug Fixes

- "Tool not found" root cause eliminated: Structured output format taught weaker LLMs to output text resembling tool calls (empty `toolCall.name`). Removed entirely.
- Compaction message loss: User message appeared "invisible" after compaction — TUI snapshot missed it. Fixed via sessionManager pre-append + appendMessage intercept.
- Resume steer removed: `session_compact` no longer injects a resume steer. The user's queued message from `flushCompactionQueue` IS the resume mechanism.
- TUI patch removed: `InteractiveMode.prototype.flushCompactionQueue` monkey-patching deleted. Replaced with sessionManager intercept approach.
- `ctx.turnCount` fallback in `determineCompressionLevel()`: Now uses `beforeCount / 2` as fallback instead of forcing to `Infinity`.

### Refactor

- browser/ merged into tools/: CDP, web-fetch, vision are utility tools. 13 modules total.
- `pi-tui` dependency removed from compaction.ts — TUI patch deleted.
- `getState()` exported from `three-memory-stores` for use by `context-manager`.
- `updateContextDensity()` wired from `context` handler in events.ts into analytics density tracking.
- `injection-tracker` wired across all sendMessage call sites: heartbeat/analytics, session-recall, three-memory-stores, context-manager (events, navigation, rotation, compaction, context-lifecycle).

### Cleanup

- Top-level docs culled 26 → 10: archived 15 redundant/historical docs.
- 6 extension group docs added: cognitive, core, heartbeat, memory, prompt, tools.
- 7 docs deleted: PI-API-RESEARCH, PROMPT-BUILDER-REFACTOR, RESEARCH-MASTER, CONSOLIDATED-DOCS-INVENTORY, HONEST-REVIEW, DEVELOPMENT, PROPOSAL-scratchpad-\*.
- proposals/README.md: full audit with status markers.
- README.md rewritten: clean, accurate, no dead links.

---

## v0.2.0-alpha.1 (2026-04-29)

**First published version.** Metacognitive extension suite for pi-coding-agent.

### Features

- RepE structured contrast vectors: 4-mode system (TRUTH-SEEKING, CORRECTION, EPISTEMIC CALIBRATION, TOOL RELIABILITY) in prompt-builder.
- Structured output format: chain-of-thought with > prefix, code blocks with language tags, XML-style tool result tags, tables.
- resources_discover handler: pi-braid registers bundled skills via pi's native discovery system.
- IMPLEMENTATION.md: master plan with P0-P3 execution order, 15 proposals audited.
- 12 new proposals: Worker tasks, Agent Timer/Pomodoro, Benchmark v2, Contrast Phrase Library, Heartbeat Event Bus, Hierarchical Memory, Memory Leak Prevention, Self-Evolution Meta-Cognition, Structured Output Catalyst, VAR-MATH variants.
- Repl verbose output: shows code executed + result as `[repl #N] code => result`.
- Hypothesize throws on failure: errors now bubble to analytics correctly (isError:true).

### Refactor

- browser/ merged into tools/: CDP automation, web-fetch, vision are utility tools. 13 modules total.

### Cleanup

- Top-level docs culled 26 → 10: archived 15 redundant/historical docs.
- 6 extension group docs added: cognitive, core, heartbeat, memory, prompt, tools.
- 7 docs deleted: PI-API-RESEARCH, PROMPT-BUILDER-REFACTOR, RESEARCH-MASTER, CONSOLIDATED-DOCS-INVENTORY, HONEST-REVIEW, DEVELOPMENT, PROPOSAL-scratchpad-\*.
- proposals/README.md: full audit with status markers.
- README.md rewritten: clean, accurate, no dead links.

### Bug Fixes

- enforcement/index.ts: event param cast to `any` (auto_retry_end not in ExtensionAPI types).
- test-features.mjs: doc count guard updated.
- degradation-detector.ts: FIXME resolved.

---

## v0.14.0 (2026-04-23)
