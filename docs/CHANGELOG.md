# Changelog

All notable changes to pi-braid are documented here.

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
- 7 docs deleted: PI-API-RESEARCH, PROMPT-BUILDER-REFACTOR, RESEARCH-MASTER, CONSOLIDATED-DOCS-INVENTORY, HONEST-REVIEW, DEVELOPMENT, PROPOSAL-scratchpad-*.
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
- 7 docs deleted: PI-API-RESEARCH, PROMPT-BUILDER-REFACTOR, RESEARCH-MASTER, CONSOLIDATED-DOCS-INVENTORY, HONEST-REVIEW, DEVELOPMENT, PROPOSAL-scratchpad-*.
- proposals/README.md: full audit with status markers.
- README.md rewritten: clean, accurate, no dead links.

### Bug Fixes

- enforcement/index.ts: event param cast to `any` (auto_retry_end not in ExtensionAPI types).
- test-features.mjs: doc count guard updated.
- degradation-detector.ts: FIXME resolved.

---

## v0.14.0 (2026-04-23)