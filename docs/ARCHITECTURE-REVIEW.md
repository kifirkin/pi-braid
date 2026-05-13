# pi-braid Architecture Review — Systematic Top-Down Analysis

**Date**: 2026-05-08
**Method**: Entry-point → modules → extensions → lib → disabled modules
**Framework**: Each piece gets 3 questions — (1) fits package subject? (2) well-architected/wired? (3) unfinished work?

---

## Table of Contents

1. [Entry Point & Module System](#layer-0-entry-point--module-system)
2. [Layer 1: Core Module](#layer-1-core-module)
3. [Layer 2: Cognitive Module](#layer-2-cognitive-module)
4. [Layer 3: Memory Module](#layer-3-memory-module)
5. [Layer 4: Heartbeat Module](#layer-4-heartbeat-module)
6. [Layer 5: Retry Module](#layer-5-retry-module)
7. [Layer 6: Prompt Module](#layer-6-prompt-module)
8. [Layer 7: Tools Module](#layer-7-tools-module)
9. [Layer 8: Assistant Module](#layer-8-assistant-module)
10. [Disabled Modules](#disabled-modules-watchdog--evolve--rate-limiter--agent-environment)
11. [Lib Infrastructure](#lib-infrastructure)
12. [Cross-Cutting Concerns](#cross-cutting-concerns)
13. [Summary](#summary)

---

## Layer 0: Entry Point & Module System

### `src/index.ts` — Braid Entry

**Structure**: Minimal. Exports `SKILLS_DIR`, loads modules via `loadModules()`, registers the module API.

**1. Fits package subject?** ✅ Yes — thin entry point that delegates to module system.

**2. Well-architected?** ⚠️ Minor issue:

- `getVersion()` is hardcoded `"0.20.0"` inside a try/catch that does nothing. The version always returns `"0.20.0"`. Should read from `package.json` via `require("../../package.json").version` or similar.
- `SKILLS_DIR` uses `fileURLToPath` which is correct for ESM. ✅

**3. Unfinished work?** — The SKILLS_DIR resolution uses a hardcoded relative path `".."` from the package's `src/` directory. This works in development but may break when the package is installed as a dependency (different directory layout). Should be resolved relative to `import.meta.url` with a more robust path.

---

### `src/modules/definitions.ts` — Module Registry

**Structure**: 12 module definitions, 4 disabled by default. Each has name, label, description, paper ref, dependencies, extensions, coupling documentation.

**1. Fits package subject?** ✅ Yes — central registry for all braid extensions.

**2. Well-architected?** ⚠️ **Bug found:**

- ✅ RESOLVED: `researchFn` was orphaned, now registered in the `contrib` module.
- Tools module description says "Codebase graph, REPL, docs reader, timer, latent activator" — references deleted tools (codebase-graph, repl, docs). Stale.

**3. Unfinished work?** — The `coupledWith` field documents cross-module coupling but nothing enforces it. If an extension starts listening to a new event, the coupling doc drifts silently.

---

### `src/modules/loader.ts` — Module Loader

**Structure**: 4-tier config resolution (runtime API → settings.json → env var → defaults). Topological sort for dependency ordering.

**1. Fits package subject?** ✅ Yes — essential for modular research experiments.

**2. Well-architected?** ✅ Good:

- Priority chain is clear and well-documented
- Topological sort avoids circular dependency issues
- Settings persistence (global + project tier) matches pi-native pattern
- Runtime API allows researcher subagents to toggle modules mid-session

⚠️ Minor: Writes directly to `~/.pi/agent/settings.json` using `readFileSync`/`writeFileSync` (sync I/O). Should use async for non-blocking.

**3. Unfinished work?** — Serial loading only (no parallel). With 34 extensions, sequential awaits could be a startup bottleneck.

---

### `src/modules/api.ts` — Subagent Module API

**Structure**: 6 commands (enable/disable/toggle/list/status/reset) calling loader's runtime API.

**1. Fits package subject?** ✅ Yes — enables researcher subagent workflow.

**2. Well-architected?** ⚠️ **Dead code:**

- `modules-list` handler computes `const deps = (() => {...})()` which always returns `""` and is never used. Clearly intended to show module dependencies but never wired.
- `modules-status` handler computes `const overrides = ...` which always returns `false` and is never used.
- The list handler shows `status.padEnd(12)` but status strings like `"●"` (1 char) and `"— disabled"` (12 chars) produce uneven alignment.
- The `source` variable reads from `Object.values(states)[0]?.source` which breaks if the first module has different source than the last. Source is per-resolution, not per-module.

**3. Unfinished work?** — The deps display and override tracking were clearly planned but never implemented.

---

## Layer 1: Core Module

### `agent-patch` — Agent.handleRunFailure Monkey-Patch

**Files**: 1 (index.ts)
**Events**: 0 | **Tools**: 0 | **Dependencies**: `@mariozechner/pi-agent-core`

**1. Fits package subject?** ✅ Yes — fixes an upstream bug that causes lost assistant messages on API errors. Critical for braid's session persistence to work.

**2. Well-architected?** ✅ Good:

- Well-documented with upstream issue reference
- Graceful degradation (try/catch, logging, returns false on failure)
- Checks `Agent.prototype` existence before patching
- Checks original handler existence before patching

**3. Unfinished work?** — No version check for upstream fix. The comment says "can be removed once pi-agent-core ships a proper fix" but there's no mechanism to detect when that happens.

---

### `polyfill` — API Method Polyfills

**Files**: 1 (index.ts, ~340 lines)
**Events**: 3 (`before_agent_start`, `session_end`, vision-model command) | **Tools**: 1 (vision-model command)

**1. Fits package subject?** ✅ Yes — patches missing API methods and provides model selection UI.

**2. Well-architected?** ⚠️ Issues:

- `loadCustomKeysFromDisk().catch(() => {})` — empty catch swallows errors. Should log.
- `patchConfirmForAutoConfirm()` stores `originalConfirm` but never uses it (replaces entirely without fallback).
- `getPolyfillState` has a module-level `_default` fallback plus `getExtensionState` — inconsistency. The module-level singleton leaks state across sessions.
- The `catch {}` blocks in `persistCustomKeys()` and `loadCustomKeysFromDisk()` have commented empty catches (lint flags).

**3. Unfinished work?** — File header mentions `/utility-model` command but only `/vision-model` is implemented. The model selector UI `openModelSelectorUI` accepts `settingKey` parameter but only called with `VISION_MODEL_KEY`.

---

### `metacognition` — Think/Verify/Hypothesize Tools

**Files**: 1 (index.ts) + handlers/
**Events**: 0 | **Tools**: 4 (think, hypothesize, verify, +1 more)

**1. Fits package subject?** ✅ Yes — core metacognitive tools for structured reasoning.

**2. Well-architected?** ✅ Clean — tools only, no event listeners. Each tool is in its own handler file.

**3. Unfinished work?** — None known.

---

### `scratchpad` — Session Memory

**Files**: 1 (index.ts) + persistence.ts
**Events**: 0 | **Tools**: 1+ (scratchpad with many actions)

**1. Fits package subject?** ✅ Yes.

**2. Well-architected?** ✅ Clean. Uses `getExtensionState` for session-scoped state.

**3. Unfinished work?** — None known.

---

## Layer 2: Cognitive Module

**6 extensions**: cognitive-systems, reasoning, enforcement, verification, topic-drift, sycophancy-detector
**Dependencies**: core
**Events**: 10+ (most pervasive event listener in codebase)

### `enforcement` — Smart Nudge Delivery

**Files**: index.ts + handler-registry.ts + handlers/ (blocking, tool-tracker, message-analysis, orphan-chains, probe-handler, routing-handler, turn-end-handler) + detection/ (malformed, verification, dangerous-tool) + signals.ts, state.ts, whisper.ts
**Events**: 7 (input, tool_call, message_end, turn_end, session_compact, auto_retry_end, session_shutdown) | **Tools**: 0

**1. Fits package subject?** ✅ Yes — behavioral enforcement is a core research track.

**2. Well-architected?** ⚠️ Mixed:

- **Good**: 3-tier signal architecture (L1 internal tracking, L2 structured hints, L3 critical messages) is well-documented in handler-registry.ts header. Nudge dedup via cooldown.
- **Good**: Handlers are split into separate files (handlers/, detection/).
- **Problem**: Massive handler-registry.ts (~720 lines) — too many event handlers in one file. The comment says it was "extracted from index.ts to reduce it from 1268L to a thin wrapper" but it's still very large.
- **Problem**: 8 unused imports in handler-registry.ts (SessionCompactEvent, eventBus, detectMissingVerification, recordCodeChange, getNudgeAnalytics, validateTurn, knownFiles, loadFileContent). These were likely once used but became orphaned during refactoring.
- **Problem**: The `turn-end-handler.ts` has 5 unused imports (sendTrackedMessage, eventBus, recordNudgeSent).

**3. Unfinished work?** — The orphaned imports suggest incomplete refactoring. Some detection functions are imported but never called.

---

### `cognitive-systems` — Memory Store/Recall/List Tools

**Files**: 1 (index.ts) + project-storage.ts
**Events**: 0 | **Tools**: 6 (memory_store, memory_recall, memory_list, memory_get, conflict_qa, verify_claim, check_topic_drift, reset_topic_anchors)

**1. Fits package subject?** ✅ Yes — cognitive memory tools.

**2. Well-architected?** ✅ Good. Cross-search between cognitive-memory and three-memory-stores episodes is properly wired with try/catch fallback.

**3. Unfinished work?** — None known.

---

### `reasoning`, `verification`, `topic-drift`, `sycophancy-detector`

**Files**: 1 each
**Events**: 0-2 | **Tools**: 0-2 each

**1. Fits package subject?** ✅ Yes — each has a clear concern.

**2. Well-architected?** ✅ Reasonable for their scope. verification and topic-drift are tool-only (no event listeners). reasoning and sycophancy-detector have minimal event listeners.

**3. Unfinished work?** — None known.

---

## Layer 3: Memory Module

**4 extensions**: three-memory-stores, session-recall, context-manager, context-lifecycle
**Dependencies**: core

### `three-memory-stores` — Episodic Memory Store

**Files**: index.ts + episodes.ts, heuristics.ts, tool-reliability.ts, types.ts
**Events**: 4 (session_start, turn_end, tool_end, session_shutdown) | **Tools**: 3 (memory_episodes, memory_heuristics, memory_tool_stats)

**1. Fits package subject?** ✅ Yes — core memory research (paper 2604.14475).

**2. Well-architected?** ✅ Good:

- 3-tier memory (RUMS: recency, utility, importance, similarity) is a clean retrieval algorithm
- Event handlers persist episodes on `turn_end` and `session_shutdown`
- `turn_end` recaller cross-searches cognitive memory for insights
- Exported `createMemoryStoresState` is used by cognitive-systems for cross-search

**3. Unfinished work?** — None known. Well-maintained.

---

### `session-recall` — Past Session Insights

**Files**: 1 (index.ts)
**Events**: 2 | **Tools**: 2 (session_search, session_query)

**1. Fits package subject?** ✅ Yes — proactive recall of past experiences.

**2. Well-architected?** ✅ Clean. Minimal.

**3. Unfinished work?** — None known.

---

### `context-manager` — Compaction + Context Tools

**Files**: index.ts + handlers/tools.ts + handlers/compaction.ts + handlers/rotation.ts
**Events**: 2 | **Tools**: 8+ (context_tag, context_log, context_checkout, context_prune, context_audit, context_snapshot, context_compact, context_archive, context_proposals, context_signal)

**1. Fits package subject?** ✅ Yes — context lifecycle management.

**2. Well-architected?** ✅ This is the most tool-rich extension. Handlers are in separate files.

**3. Unfinished work?** — Known: `context_prune(dryRun=false)` causes agent loop termination — documented as a blocker. Recommends using `context_archive` instead.

---

### `context-lifecycle` — Semantic Signal Detection

**Files**: index.ts + types.ts + signal-detector.ts + policies.ts
**Events**: 2 | **Tools**: 2

**1. Fits package subject?** ✅ Yes — proactive context quality monitoring.

**2. Well-architected?** ✅ Clean signal-based architecture.

**3. Unfinished work?** — None known.

---

## Layer 4: Heartbeat Module

**2 extensions**: heartbeat-scheduler, analytics
**Dependencies**: core, memory

### `heartbeat-scheduler` — Proactive Tick

**Files**: index.ts + modules/ (budget.ts, context-hygiene.ts, dreamer.ts, evolver.ts, measurement.ts, timer-reminder.ts) + policies.ts + state.ts + types.ts
**Events**: 5 (session_start, session_shutdown, agent_end, turn_end, tool_call) | **Tools**: 0

**1. Fits package subject?** ✅ Yes — proactive cognitive scheduling (paper 2604.14178).

**2. Well-architected?** ✅ Good:

- Modular sub-handlers (6 modules) each with clear responsibility
- Policy engine for decision-making
- Clean separation between timing (heartbeat-scheduler) and measurement (analytics)

**3. Unfinished work?** — None known.

---

### `analytics` — Metrics Collection

**Files**: index.ts + core.ts, ab-variant.ts, format.ts
**Events**: 4 | **Tools**: 9 (get-session-metrics, get-tool-reliability, get-ab-results, get-tool-addiction, error_list, error_get, error_clear, error_stats, hidden-messages)

**1. Fits package subject?** ✅ Yes — measurement infrastructure.

**2. Well-architected?** ✅ Clean. Many tools but well-organized.

**3. Unfinished work?** — None known.

---

## Layer 5: Retry Module

**2 extensions**: retry, error-capture
**Dependencies**: core

### `retry` — /retry Command + Auto-Retry

**Files**: 1 (index.ts) + state.ts
**Events**: 3 (session_start, input, agent_end, after_provider_response, auto_retry_start, auto_retry_end) | **Tools**: 2 (error_list, error_get originally — moved to error-capture)

**1. Fits package subject?** ✅ Yes — error recovery is essential for agent stability.

**2. Well-architected?** ✅ Reasonable. Listens to many events but the coupling is appropriate.

**3. Unfinished work?** — None known.

---

### `error-capture` — Error Classification

**Files**: 1 (index.ts)
**Events**: 1 (turn_end) | **Tools**: 4 (error_list, error_get, error_clear, error_stats)

**1. Fits package subject?** ✅ Yes — provides error introspection tools.

**2. Well-architected?** ✅ Clean separation from retry logic.

**3. Unfinished work?** — None known.

---

## Layer 6: Prompt Module

### `prompt-builder` — System Prompt Reconstruction

**Files**: 1 (index.ts, ~550 lines) + preview.ts + l1-environment.ts + contrast-phrase-library.ts
**Events**: 2 (resources_discover, before_agent_start) | **Tools**: 1 (prompt_preview)

**1. Fits package subject?** ✅ Yes — this is the most important extension. Overrides pi-native prompt with braid's structured prompt.

**2. Well-architected?** ⚠️ Good concept, implementation gaps:

- **Good**: 10-section system prompt built from structured data, not string extraction
- **Good**: Identity framing (Dimension 1 of tone-quality) — "You are Braid, an expert software architect"
- **Good**: Research citations (2604.19117, 2604.15224)
- **Problem**: Tool listing uses `KNOWN_SNIPPETS[t.name] ?? t.description` — for braid tools without KNOWN_SNIPPETS, the **full description** is used (not the one-line promptSnippet that the researcher defined). This wastes ~5000 tokens/turn.
- **Problem**: `KNOWN_SNIPPETS` only covers 8 pi-native tools — the remaining 50+ braid tools use verbose descriptions.
- **Problem**: Past insights (`searchPastInsights`) uses `readdirSync` (sync I/O) inside async function — blocking.

**3. Unfinished work?** — See `docs/PROMPT-GUIDELINES-REVIEW.md` for full proposal. P0 fix: use `firstSentence()` truncation for all tool descriptions.

---

## Layer 7: Tools Module

**6 extensions**: healthcheck, timer, latent-activator, observatory, diff, system-monitor
**Dependencies**: core

**NOTE**: `research` tool — was orphaned, now registered in the `contrib` module.

### General Assessment

**1. Fits package subject?** ✅ Yes — utility tools support agent workflow.

**2. Well-architected?** ✅ All tools are clean: no event listeners (except timer which needs turn tracking), single-file each.

**3. Unfinished work?** — The `research` tool exists in source but is never loaded. It was created for the researcher agent to analyze system prompts (commit `3888c17a`) but was orphaned when the module definitions were reorganized.

---

## Layer 8: Assistant Module

### `assistant` — Identity State Persistence

**Files**: 1 (index.ts)
**Events**: 1 | **Tools**: 2 (registerCommand for /tools)

**1. Fits package subject?** ✅ Yes — manages assistant identity across sessions.

**2. Well-architected?** ✅ Clean.

**3. Unfinished work?** — None known.

---

### `feedback` — Feedback Whisper

**Files**: 1 (index.ts)
**Events**: 5 (session_start, turn_start, message_end, tool_call, agent_start) | **Tools**: 0

**1. Fits package subject?** ✅ Yes — provides feedback nudges to the agent.

**2. Well-architected?** ⚠️ Has 2 unused imports (`homedir`, `AgentToolResult`).

**3. Unfinished work?** — None known.

---

## Disabled Modules (watchdog, evolve, rate-limiter, agent-environment)

**Common assessment**:

**1. Fits package subject?** ✅ For watchdog and evolve (monitoring/self-improvement). ⚠️ rate-limiter and agent-environment feel tangential — API throttling and execution context are pi-native concerns, not braid research tracks.

**2. Well-architected?** Can't assess — disabled by default, likely minimally tested.

**3. Unfinished work?** — These were never fully developed. They exist because the module system was designed to be extensible. May be dead code.

---

## Lib Infrastructure

**47 files** across `src/lib/`. Key categories:

| Category        | Files                                                                                                                                                                                                                             | Assessment              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **Memory**      | cognitive-memory (dir), belief-store, claim-tracker, evidence-pool, conflict-qa, memory-guidance                                                                                                                                  | ✅ Well-structured      |
| **Storage**     | braid-paths, braid-settings, async-storage, global-state                                                                                                                                                                          | ✅ Recently centralized |
| **Enforcement** | injection-tracker, nudge-analytics, belief-policy-engine                                                                                                                                                                          | ✅ Clean                |
| **State**       | extension-state, session-start-queue, metacognitive-state, state-checkpoint                                                                                                                                                       | ✅ Good patterns        |
| **Reasoning**   | mars-reflector, reasoning-metrics, reasoning-summary, planner, cognition-evaluator, goal-manager                                                                                                                                  | ✅ Focused              |
| **Infra**       | logger, model-resolver, event-bus, event-consumers, timer-bus, filter-safe-to-remove                                                                                                                                              | ✅ Standard             |
| **Utilities**   | edit-helper, extension-utils, compression-strategy, consolidation-channel, language-hint, sop-extractor, sop-suggestion, bidirectional-verifier, context-density, degradation-detector, observatory, file-mutation-queue, dreamer | ✅ Varied quality       |
| **Dead/Stale**  | agent-events (restored), tool-security (restored)                                                                                                                                                                                 | ✅ Restored             |

**1. Fits package subject?** ✅ — lib provides shared infrastructure used across all extensions.

**2. Well-architected?** ✅ Generally good. The recent path consolidation (braid-paths.ts) and settings centralization (braid-settings.ts) improved quality significantly.

**3. Unfinished work?** — Some lib files are one-off utilities that could be consolidated: `compression-strategy.ts` is used only by context-manager; `goal-manager.ts` is used only by mars-reflector; `dreamer.ts` is used only by heartbeat-scheduler. These could live inside their respective extensions.

---

## Cross-Cutting Concerns

### Dead Code / Unused Imports

| File                                 | Unused Import                                                                                                                                            | Reason                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| handler-registry.ts (enforcement)    | `SessionCompactEvent`, `eventBus`, `detectMissingVerification`, `recordCodeChange`, `getNudgeAnalytics`, `validateTurn`, `knownFiles`, `loadFileContent` | 8 orphaned imports             |
| turn-end-handler.ts (enforcement)    | `sendTrackedMessage`, `eventBus`, `recordNudgeSent`                                                                                                      | 3 orphaned imports             |
| feedback/index.ts                    | `homedir`, `AgentToolResult`                                                                                                                             | 2 orphaned imports             |
| cognitive-systems/index.ts           | `getAllConflictQAs`                                                                                                                                      | 1 orphaned import              |
| modules/api.ts                       | `deps` variable, `overrides` variable                                                                                                                    | 2 computed-but-never-used      |
| definitions.ts                       | `researchFn` (was orphaned)                                                                                                                               | ✅ Now registered in contrib module |
| metacognition/index.ts               | `evaluateCognition`, `Type`                                                                                                                              | 2 orphaned imports             |
| blocking.ts (enforcement)            | `queueBlockAction`                                                                                                                                       | 1 orphaned export/import       |
| probe-handler.ts, routing-handler.ts | `ExtensionAPI`                                                                                                                                           | 2 files, each 1 unused import  |
| handler-registry.ts (enforcement)          | `loadFileContent`                                                                                                                                        | 1 orphaned import              |

### Known Blockers

1. **context_prune agent-loop termination** — Using `context_prune(dryRun=false)` kills the agent loop. Use `context_archive` instead. Documented in memory.

2. **Test isolation** — `test-cognitive-memory.mjs` clears all memories during test. Needs isolated test database.

3. **research tool orphaned** — ✅ RESOLVED. Now registered in the `contrib` module.

### Sync I/O in Async Contexts

| File                    | Line                           | Pattern                                          |
| ----------------------- | ------------------------------ | ------------------------------------------------ |
| prompt-builder/index.ts | `readdirSync(memoryDir)`       | Blocking inside `searchPastInsights()`           |
| loader.ts               | `readFileSync`/`writeFileSync` | Settings persistence (at load time — acceptable) |
| polyfill/index.ts       | `fs.readFile/parse/set keys`   | Already using async fs.promises ✅               |

---

## Summary

### Fit for Purpose

All 12 modules fit the pi-braid subject ("metacognitive agent extension suite"). The disabled modules (rate-limiter, agent-environment) are weakest — they feel like external features rather than research tracks.

### Architecture Quality

**Strong areas**: Module loader, agent-patch, cognitive-systems, three-memory-stores, heartbeat-scheduler, context-manager.

**Needs attention**: Enforcement handler-registry (too many orphaned imports, too large), prompt-builder (tool description truncation missing), modules/api.ts (dead variables).

### Unfinished Work Priority

| Priority | Item                                          | Why                                         |
| -------- | --------------------------------------------- | ------------------------------------------- |
| 🟩 DONE  | Wire researchFn into contrib module            | Was orphaned, now loads (contrib module) |
| 🟥 P0    | Tool description truncation in prompt-builder | ~5000 tokens wasted per turn                |
| 🟧 P1    | Clean 13 orphaned imports                     | Code quality, maintainability               |
| 🟧 P1    | Fix modules/api.ts dead variables             | Half-finished features confuse users        |
| 🟧 P1    | Version detection for agent-patch             | Remove when upstream fix ships              |
| 🟨 P2    | Add context_prune blocker in tools docs       | Prevents future frustration                 |
| 🟨 P2    | Test isolation for cognitive-memory test      | Tests should be isolated                    |
| 🟩 P3    | utility-model command (polyfill)              | Parity with vision-model                    |
| 🟩 P3    | Soft-start — load modules in parallel         | Startup perf                                |
