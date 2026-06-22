# Changelog

All notable changes to pi-braid are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Post-loop classifier timeout bumped 5s → 8s → 30s.** User report:
  `Error: 02:51:02.723 ERROR [llm-call] LLM error: This operation was aborted`
  at turn end. The 8s default was still tight for worst-case paths
  (cold utility-model cache + busy session model + long context at
  session end). Bumped to 30s per LLM tier (60s total worst-case
  when both tiers run). The user explicitly indicated "a minute or
  even more" was acceptable for post-loop waits - it's a
  best-effort audit, not an interactive critic. Tuning curve: 3s → 5s
  → 8s → 30s. Tracked in `DEFAULT_POST_LOOP_TIMEOUT_MS` with full
  history comment.

- **ESC cancellation now propagates to all direct `callLlm` callers.**
  The 2026-06-21 ESC fix threaded `ctx.signal` through
  `classify() → tryModelCall() → callLlm()`, which covered most of
  braid's LLM call sites. But several extensions called `callLlm()`
  directly and bypassed the signal thread, leaking: when the user
  pressed ESC during the agent's main turn, those parallel calls
  kept running until their own internal timeouts fired, producing
  misleading "LLM error: This operation was aborted" ERROR logs
  long after the user had moved on. The three callers fixed are:
    - `core/input-polisher` (polish call) — `ctx.signal` threaded.
    - `memory/session-recall` (session query) — tool's `signal`
      parameter now used (was prefixed `_signal` = unused).
    - `enforcement/verification-judge` (judge audit at MESSAGE_END)
      — `runVerificationJudge` now accepts an optional `signal` in
      its options; `register-message-end.ts` threads `ctx.signal`.

- **Tests rewritten from source-grep to behavioral.** Previous tests
  for ESC/timeout contracts used regex to match function-body
  fragments (the conditional spread, `signal?.aborted === true`,
  etc.). Those tests were fragile - they broke on whitespace and
  comment changes even when behavior was unchanged. Replaced with
  behavioral tests using a new test injection hook:
  `__setCompleteSimpleForTest(fn)` in `lib/ai/llm-call.ts` lets
  tests stub `completeSimple` to a hanging promise, then drive the
  real callLlm/classify/postLoopClassify with a fake ctx and verify
  behavior (timeout fires at expected ms, signal aborts call within
  ~50ms, external abort demoted to debug, onFailure invoked on
  tier=failed). New test files:
    - `test-call-llm-behavior.mjs` (10 tests) — covers callLlm +
      combineSignals behavior end-to-end.
    - `test-post-loop-classify.mjs` (7 tests, was 12) — replaces
      body-grep regex checks with behavioral ones.
    - `test-classifier-abort-handling.mjs` (4 tests, was 8) —
      minimal smoke + 2 behavioral checks for ctx.signal threading.
    - `test-direct-callers-signal-threading.mjs` (6 tests, was 7)
      — minimal smoke + 1 behavioral check for runVerificationJudge.
  The new tests assert on observable outcomes (return values,
  elapsed time, log buffer contents) so they survive refactors that
  preserve behavior.

- **ESC cancellation now propagates to all direct `callLlm` callers.**
  The 2026-06-21 ESC fix threaded `ctx.signal` through
  `classify() → tryModelCall() → callLlm()`, which covered most of
  braid's LLM call sites. But several extensions called `callLlm()`
  directly and bypassed the signal thread, leaking: when the user
  pressed ESC during the agent's main turn, those parallel calls
  kept running until their own internal timeouts fired, producing
  misleading "LLM error: This operation was aborted" ERROR logs
  long after the user had moved on. The three callers fixed are:
    - `core/input-polisher` (polish call) — `ctx.signal` threaded.
    - `memory/session-recall` (session query) — tool's `signal`
      parameter now used (was prefixed `_signal` = unused).
    - `enforcement/verification-judge` (judge audit at MESSAGE_END)
      — `runVerificationJudge` now accepts an optional `signal` in
      its options; `register-message-end.ts` threads `ctx.signal`.
  New regression test `test-direct-callers-signal-threading.mjs`
  pins all three call sites.

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
