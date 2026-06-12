# Changelog

All notable changes to pi-braid are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-06-10

The first public release. This release consolidates 12 tools out of the
codebase (42 → 30), restructures the extension layout around the agent
processing loop, removes Python from the entire project, and fixes two
silent regressions that were missed by typecheck and tests.

### Added

- **7-category extension layout** mapped to the agent's processing loop
  (`core` for Input/Output, `cognitive` for Thinking, `memory` for
  Remembering, `scheduling` for When-to-act, `self` for Self-management,
  `heartbeat` for Background proactive, `enforcement` for Turn pipeline).
- **`pi-braid-skills`** as a separate sibling package - 22 skills
  previously bundled with pi-braid now live in their own content-only
  package (`~/projects/agents/pi-braid-skills`). Discovered via the
  `pi.skills` field in `package.json`.
- **Timer wake: true forced-turn path** (Layers 2/3/4 of the timer-fire
  fix). `wake: true` timer fires now route through
  `pi.sendUserMessage(text, { deliverAs: "followUp" })` which "Always
  triggers a turn" per the SDK contract - replacing the soft-nudge
  `sendMessage(steer)` that the agent could ignore mid-stream.
- **`TIMER_FIRE_HANDLING` prompt section** - instructs the agent to
  acknowledge a `[TIMER FIRED - Ns elapsed] <reason>` message briefly
  and decide next step.
- **CHANGELOG.md** (this file).
- **Release process documentation** in `CONTRIBUTING.md`.

### Changed

- **30 LLM-callable tools** (down from 42), consolidated:
  - `error_list/get/clear/stats` → `error` (action discriminator)
  - `timer_set/list/cancel` → `timer` (action discriminator)
  - `auto_singleton_set/cancel/status` → `auto_singleton` (action discriminator)
  - `verify_claim` + `verify_decomposition` → `verify_claim` (action=claim|decomposition)
  - `check_topic_drift` + `reset_topic_anchors` → `topic_drift` (action=check|reset)
  - `session_search` + `session_query` → `session` (action=search|query)
  - `memory_list` + `memory_get` → folded into `memory_recall` (action=search|list|get)
  - `memory_tool_stats` → removed (intent covered by `get_tool_reliability`)
- **Removed 4 out-of-scope tools**: `prompt_preview`, `time_status`,
  `set_ab_variant`, `context_signal`.
- **Reorganized prompt-builder** to no longer bundle skills (moved to
  `pi-braid-skills`).
- **Updated 7 stale `AGENTS.md` files** to reflect current tool names
  and structure.

### Fixed

- **`topic_drift` tool was registered as `check_topic_drift`** - silent
  regression from an earlier consolidation. The new schema required
  `action=check|reset` but the old name was kept. Calls to `topic_drift`
  would get "tool not found"; calls to `check_topic_drift` with the
  old payload would hit the `default` case and throw. Caught by
  fresh-eyes audit (typecheck+tests didn't flag it). Fixed in commit
  `092beae6`.
- **Timer fire whisper silently suppressed by per-turn flood cap** -
  the 3-minute compaction-resume timer could fail to wake the agent
  when 3+ high-priority whispers had already fired in the same turn.
  Fixed in three layers:
  1. `priorityFromSource` now maps `timer/fire` to `critical` (bypasses
     `WHISPER_CAPS.high`); only subject to `PER_SOURCE_CAP` (2 per turn).
  2. `wake: true` fires route through `pi.sendUserMessage` (forced turn)
     instead of `sendMessage(steer)` (soft nudge).
  3. Text format is now `[TIMER FIRED - Ns elapsed] <reason> - Resume the
     task.` and the prompt-builder emits a `TIMER_FIRE_HANDLING` section.

### Removed

- **All Python** (11 files): 8 in `evaluation/`, 1 in `scripts/`,
  2 in `test/`. The project is now pure JS/TS.
- **22 skill files** moved to the separate `pi-braid-skills` package.
- **31 nonsensical test files** (test-features, quick-benchmark,
  test-sop-suggestion, test-topic-drift, test-silicon-mirror, etc.)
  that were testing nothing - either 0 real assertions, or assertions
  on file existence, or reimplementations of algorithms. Tests went
  from 68 → 34; all remaining are real regression tests.
- **3 shell scripts** in `evaluation/` (duplicate `.mjs` versions).
- **`docs/TOOL-INVENTORY-AUDIT.md`** - a working document for the
  consolidation work, not durable documentation.
- **`src/extensions/core/prompt-builder/preview.ts`** (184 lines) -
  `createPromptPreviewTool` exported but unused. YAGNI.
- **Dead code in `agent-environment/index.ts`** - 13-line REMOVED
  section documenting the deleted `time_status` tool.

### Publish artifacts

- **npm pack: 608 files, 784.6 KB** (down from 1007 files / 1.1 MB
  before this audit).
- **`.npmignore` hardened** - explicit `**/*.map` (negation pattern in
  `files` whitelist), `*.py`, `__pycache__/`, eslint/prettier configs
  excluded.
- **`package.json` polished**:
  - `description`, `keywords`, `license`, `engines.node` all set.
  - `CONTRIBUTING.md` added to `files`.
  - `skills/` removed (now in pi-braid-skills).
  - `files` uses explicit `dist/**/*.js` + `dist/**/*.d.ts` patterns
    instead of `dist/` (the latter was including 378 .map files).

### Test results

- **32/32 tests pass** (was 31 before the wake-handling test was added).
- All 4 quality gates pass: `typecheck`, `test`, `check-deps`,
  `check-duplicates`.

## [0.2.5] - 2026-05-29

Internal release. Not published. Predates the publish-prep audit.

## Pre-history

Commits before 0.2.5 are available via `git log` but are not
publicly documented.
