<!-- status: current -->

# Changelog

All notable changes to pi-braid are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`## Instance` block at top of system prompt (v3.5).** Replaces
  scattered env info (root/cwd/os/datetime previously split between
  `l1-environment.ts` and section 6 of the prompt-builder) with a
  single concise block at the very top. Surfaces:
  - Agent identity (`Braid vX.Y.Z` over `pi-core vA.B.C`)
  - Environment (`Root`, `Cwd`, `OS`, `Now`)
  - Tree-style extension listing (grouped by module, per-extension
    tool counts, always-on tagged)
  - Aggregate counts (tools, skills, memory)
  The block is the agent's at-a-glance view of "what's loaded and
  where it came from" — no `braid-reference` skill needed; the tree
  IS the documentation. Mirror of what `pi-reference` does for
  pi-core. New module: `src/extensions/core/prompt-builder/instance-composition.ts`.
  Test: `test/runtime/lib/test-instance-composition.mjs` (9/9 subtests).
- **Tool provenance tracking.** New module
  `src/lib/state/tool-provenance.ts` records `toolName → extensionId`
  as extensions load. The loader (`src/loader/loader.ts`) populates
  the registry by diffing `pi.getAllTools()` before/after each
  extension runs. Used by the Instance block to show per-extension
  tool counts. Foundation for future "what extension registered
  this tool" queries.
- **`braid.contrib.<name>` settings.json filter.** The contrib
  package's `index.ts` now reads `braid.contrib.<name>` from
  `~/.pi/agent/settings.json` to decide which contrib extensions
  to load. Default: enabled. To disable, set to `false`. To enable
  an extension that's commented out in the contrib loader, set to
  `true`. Example:
  ```json
  {
    "braid": {
      "contrib": {
        "browser": false,
        "vision": false
      }
    }
  }
  ```
  Disabled extensions are simply not loaded — their tools are not
  registered, so they don't appear in the agent's tool list or the
  Instance block. Unknown names are ignored with a stderr warning.
  The contrib package refactor lives in
  `pi-braid-contrib` (sibling project, not in this repo).
- **`braid.enforcement.nudgeConfigs` settings block (EW-7.11).**
  Per-NudgeType cooldowns, escalation thresholds, and deduplication
  are now user-tunable without forking. Shape:
  ```json
  {
    "braid": {
      "enforcement": {
        "nudgeConfigs": {
          "validation": { "baseCooldownMs": 30000 },
          "malformed": { "deduplicate": false }
        }
      }
    }
  }
  ```
  All fields are optional (partial overrides). The previously-dead
  `customConfig` parameter on the `NudgeManager` constructor is now
  wired: `getNudgeManager(ctx)` reads + validates settings on every
  access and passes the result through.
  - `src/lib/config/braid-settings.ts`: `getRawNudgeConfigOverrides()`
    reads `braid.enforcement.nudgeConfigs` as an unvalidated
    `Record<string, unknown>`. Validation lives next to the schema
    (in nudge-manager) to keep the type knowledge in one place.
  - `src/extensions/enforcement/nudge-manager.ts`:
    - `validateNudgeConfig(type, cfg)`: per-entry validator. Drops
      invalid fields from the parsed result but keeps valid ones
      (defense in depth: one bad field doesn't lose the whole
      entry). Returns `{valid, errors, parsed}`.
    - `parseNudgeConfigOverrides(raw)`: two-layer filter —
      unknown NudgeType keys dropped (with `log.warn`), per-entry
      validation drops bad fields, result is always usable.
    - `getNudgeManager(ctx)` now calls
      `parseNudgeConfigOverrides(getRawNudgeConfigOverrides())`
      and passes the result to the `NudgeManager` constructor.
  - `test/runtime/lib/test-enforcement-config.mjs` (new, 18
    subtests): pins both the wire-up (source-level grep) and the
    validation behavior (runtime import of compiled
    `validateNudgeConfig` + `parseNudgeConfigOverrides`).
  Test count: 78 → 79 passing. tsc clean. `check:docs` +
  `check:doc-drift` green.

- **Doc discipline layer** (DR-NEW-DOC-DISCIPLINE). Every `.md` file in
  `docs/`, every `src/**/AGENTS.md`, and every top-level `*.md` now
  carries a `<!-- status: ... -->` marker (`current`, `forward-looking`,
  `aspirational`, or `historical`). Two scripts enforce it:
  - `scripts/check-doc-status.mjs` (`npm run check:docs`) — fails if
    any in-scope doc is missing the marker.
  - `scripts/check-doc-drift.mjs` (`npm run check:doc-drift`) — greps
    for tracked API names (`completeSimple`, `streamSimple`,
    `__setCompleteSimpleForTest`, `createModels`, `Models`) in docs vs
    source, fails if a `current`-status doc references an API not in
    code. Initial tracked list captures the pi-ai v0.80 migration drift
    surface; extend `TRACKED_NAMES` as new surfaces emerge.
  Both are wired into `npm run ci:check`. The discipline caught the
  v0.80 port's invisible drift (audit doc marked `forward-looking`,
  AGENTS.md corrected to use `completeSimple` rather than
  `streamSimple`).

### Changed

- **P1-5 / EW-7.2 — NudgeType wiring contract.** Of the 16 NudgeType
  values in `DEFAULT_NUDGE_CONFIGS`, 14 were forward-looking scaffolding
  with no callers — a false impression of a wired system. Resolved:
  - Wired: `malformed` (10s cooldown; `detection/malformed.ts:24` now
    rate-limits via NudgeManager) and `recordFailure` (20s cooldown;
    `turn-analysis.ts:106-118` no longer uses the parallel
    `state.lastNudgeTime + nudgeCooldownMs` mechanism for this path).
  - Wired via L2 sub-signal routing: `memory`, `scratchpad`, `context`
    now use their own NudgeType configs (45s/60s/90s) instead of
    routing through `sessionSignals`. `turn-end-handler.ts` got a
    `L2_NUDGE_TYPE` lookup table mapping `sig.key` →
    `{type, subKey}`. Sub-signals without a dedicated NudgeType
    (`think`, `localization`) fall through to `sessionSignals` with
    the subKey preserved.
  - Deleted (no triggering logic, no callers — kept as false promises
    per EW-7.2): `lazy`, `claim`, `toolDiversity`, `exploreBeforeAct`,
    `phaseValidation`, `toolError`, `judge`, `contextTool`,
    `dangerousCommand`. Each removal documented in
    `nudge-manager.ts` with the rationale for future readers.
  - State cleanup: `lastLazyNudgeTime` (dead field) removed from
    `ErrorTrackingState`. `lastJudgeTime` moved from
    `ErrorTrackingState` to `SessionState` where it logically belongs
    (with the other verification-judge fields). Structural test
    baseline updated 66 → 65.
  - Cross-cutting test: `test-nudgetype-wiring.mjs` (new, 9 subtests)
    asserts every NudgeType in `DEFAULT_NUDGE_CONFIGS` has at least
    one caller. Would have caught the original 14 unwired types.
  Test count: 77 → 78 passing. Remaining NudgeTypes in the union:
  `validation`, `recordFailure`, `malformed`, `memory`, `scratchpad`,
  `context`, `sessionSignals`.

- **Timer extension factory call counter (P1-3 / DR-C-4 runtime
  check).** Added `getTimerExtensionFactoryState()` to
  `src/lib/state/global-state.ts` and wired it into the factory body
  of `src/extensions/scheduling/timer/index.ts`. Increments the
  counter on every `timerExtension(pi)` call and logs a `log.warn`
  when the count exceeds 1, citing the DR-C-4 single-process-per-
  session assumption documented in the top-of-file comment block.
  The `_timerExtensionFactoryState` let at `global-state.ts:279` is
  the 28th documented exception in the no-module-level-let
  contract. The `test-timer-single-process-assumption.mjs`
  enforcement test grew from 7 to 10 subtests.

- **`src/lib/ai/llm-call.ts` ported to pi-ai v0.80 (P0-8 Path A).**
  Import path changed from `"@earendil-works/pi-ai"` to
  `"@earendil-works/pi-ai/compat"` — `completeSimple` was moved out of
  the top-level export in v0.80.0. The `/compat` subpath is a
  "Temporary compatibility entrypoint" with identical signature and
  return type, so no consumer-visible behavior changes. Forward-looking
  replacement is `Models.completeSimple()` on a `createModels()`
  instance (`models.d.ts:82`); that refactor is a separate deferred
  ticket.
- `package.json` peerDep floor for `@earendil-works/pi-ai` bumped
  `>=0.77.0` → `>=0.80.0`. Same bump needed for the other three
  `@earendil-works/*` peer deps when their consumers are touched.
- `docs/HOOKS-AND-WHISPERS-AUDIT.md` lines 60 and 133 corrected. The
  "Broken on pi-ai v0.80" framing was inaccurate — `completeSimple` was
  not removed, only relocated. P0-8 is the fix.
- `src/lib/ai/AGENTS.md` lines 18, 31 corrected from `streamSimple` to
  `completeSimple` to match current code (was drift, not aspirational).
- `docs/HOOKS-AND-WHISPERS-AUDIT.md` marked `forward-looking` (describes
  target state for the enforcement-loop pipeline; reconcile to `current`
  when the enforcement-loop pipeline ships).

- **L1 environment split into Session + Context blocks (v3.6).**
  The monolithic `l1-environment.ts` mixed three categories of state
  (stable env, volatile session, conditional context) into a single
  "## System State" block. The v3.5 Instance block moved the stable
  env info (`Root`, `Cwd`, `OS`, `Now`, agent version, extension
  tree) to its own section; v3.6 completes the split by separating
  the remaining two categories:
  - **`## Session`** (volatile, always shown) — PID, session elapsed
    time, since-last-event, turn count, tool-call average. Source:
    `agent-environment/gatherL1Environment()`.
  - **`## Context`** (conditional, only shown when something to
    surface) — context-usage % (when > 75%), session health (when
    non-healthy), memory count (when > 0), steps since last
    checkpoint (when > 0). Renders `""` when nothing matches; the
    "## Context" header never appears empty in the prompt.
  Removed: `src/extensions/core/prompt-builder/l1-environment.ts`
  (was 275 LOC; all state-gathering moved into the new sections
  and all formatting now lives next to its data). The
  `formatL1EnvironmentSection` formatter in `agent-environment` was
  also removed (session-section does its own formatting). No
  consumer-visible behavior change for the agent — the rendered
  prompt now has clearer section boundaries, no longer shows
  "Machine:" / "Hostname:" inside the L1 block (those are in
  Instance), and the conditional Context block only appears when
  relevant. New tests: `test/runtime/lib/test-l1-split.mjs` (11
  subtests). Test count: 80 → 81.

- **Instance block rewrite + Session merge (v3.7).** v3.6's three-block
  architecture (`## Instance` stable, `## Session` volatile,
  `## Context` conditional) had two issues observed in production:
  1. The `## Instance` block surfaced braid's internal module tree
     (`src/extensions/<module>/...`), which leaked project-specific
     implementation details into every system prompt. The user wanted
     a pi-core TUI-style summary of top-level pi extension PACKAGES
     (pi-braid, pi-braid-contrib, ...) with load-source classification.
  2. The pi-core version was reported incorrectly (showed `v0.77.0`
     when the actually-running binary was `v0.80.2`). Root cause: the
     discovery walked up from braid's `import.meta.url` and found
     braid's local `node_modules` before the global installation.

  v3.7 resolves both:
  - **`top-level-extensions.ts`** (new module): discovers top-level
    pi extension packages (anything with `"pi"` in `package.json`)
    from cwd, cwd-siblings, `~/.pi/agent/extensions/`, and
    `node_modules/<scope>/`. Each package classified with a
    load-source tag: `cwd` / `sibling-repo` / `user-global` / `npm`.
  - **`instance-composition.ts`** (rewritten): now renders the
    consolidated Instance block with all env info (Root, Cwd, OS,
    hostname, Now, PID), Session data (elapsed, last-event, turns,
    tool-avg) MERGED in from the deleted Session block, and the new
    top-level extension list. Pi-core version discovery rewritten to
    use `which pi` + symlink resolution + dual-strategy walk
    (`node_modules/<scope>/<pkg>/package.json` for mise/npm-global,
    `<dir>/package.json` for source/monorepo layouts).
  - **`session-section.ts`** (deleted): the v3.6 Session block was
    merged into Instance. All session data still comes from
    `agent-environment/gatherL1Environment()` (the data layer is
    unchanged; only the renderer changed).
  - **Section 6 of the prompt** (`environment` simpleSection with
    Current time + cwd) was removed — Instance now owns those fields.

  Removed: `src/extensions/core/prompt-builder/session-section.ts`.
  Renamed `test/runtime/lib/test-instance-composition.mjs` →
  `test-instance-block.mjs` (the v3.5 module-tree contract was
  obsolete). Test count: 81 (same; new test replaces old).

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
