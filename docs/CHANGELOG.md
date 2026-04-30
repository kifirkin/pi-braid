# Changelog

All notable changes to pi-braid are documented here.

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