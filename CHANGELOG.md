<!-- status: current -->

# Changelog

All notable changes to pi-braid are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Dynamic behavior modes restored** (TRUTH-SEEKING + 3). The
  3b4f108a commit deleted the contrast-mode system along with the
  static value statements. The dynamic modes are now back in a lean
  form (`behavior-modes.ts`, 132 LOC vs the old 265 combined). 4
  modes × 1-2 directives each, wired to enforcement signals via
  `determineContrastMode()`. The agent gets TRUTH-SEEKING by default,
  TOOL-RELIABILITY on error bursts, CORRECTION when editing without
  thinking, EPISTEMIC-CALIBRATION during overflow recovery. The 8
  static value statements stay deleted (verifier tools carry that
  rigor).

### Changed

- **CHANGELOG fix**: corrected bogus test count "81 → 89" to "81
  (8 new subtests within the test file)".

- **Memory + project-docs pointer blocks now mirror the skills section 1:1**
  (v3.9). The system prompt previously had three pointer blocks (skills,
  project docs, memory) with three different visual conventions that had
  drifted apart over the v3.5 → v3.8 evolution. This refactor unifies
  them under the skills model's lean philosophy: directive-first sentence
  + `<available_*>` block of self-closing attribute-only entries
  (name + count/location/path).
  - `memory-section.ts`: dropped `<outcomes>` vanity stats, the per-episode
    `<recent>` block (dominated by the `session_outcome` placeholder
    sentinel — never informative), per-type `<by_type>` breakdown, and
    the verbose heuristics prose. Three self-closing stores now: episodes
    (with `count` + `path`), semantic (with `count` + `path`), heuristics
    (`scope="session"` only, no path). Always renders, even when all counts
    are 0 — mirrors skills' "Skills (0 available): ..." so the agent knows
    stores exist as concepts. ~30% smaller per-turn surface.
  - `project-docs-section.ts`: dropped redundant `<description>` (a literal
    tautology with the wrapping directive on every doc) and the weak
    `<lines>` signal. Sections TOC kept as `sections="..."` attribute
    (capped at 6) because it's a genuine pre-read navigation aid. ~40%
    smaller per-turn surface.
  - `skills-section.ts`: untouched — already lean from `fd4b8269`.
  Tests in `test/runtime/core/test-memory-section.mjs` updated to match
  the new contract (8/8 subtests: self-closing shape, no `<recent>` /
  `<outcomes>` / `<by_type>` / `<episode>` / `<description>` surface,
  cache + invalidation behavior). `test-prompt-builder-values.mjs`
  unchanged — its existing project-docs pointer-model assertions still
  pass (no content injection, `<available_project_docs>` referenced,
  required exports present).

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

- **Instance block Root/Cwd/Settings + settings-driven extensions (v3.8).**
  v3.7 shipped three remaining issues observed in the next session:
  1. `Root:` leaked the braid development cwd into every system prompt
     — for any agent running through braid, "Root" was braid's source
     directory instead of the pi-core npm package folder where the
     agent is actually hosted. Re-pointed at `discoverRunningPi().root`.
  2. `Cwd:` was suppressed when it equaled `braidRoot`, hiding the
     agent's actual working directory in the common case where the
     user invokes `pi` from a project directory. Now always rendered.
  3. Top-level extension discovery scanned cwd siblings, picking up
     unrelated packages (e.g. `@saibolla/ada` surfaced as a sibling
     repo that happened to have `pi` in its package.json) and
     under-discovering packages that were actually configured
     (`pi-braid-skills`, `npm:pi-smart-fetch`). The agent couldn't
     trust the list as a real runtime inventory.

  v3.8 resolves all three:
  - **`top-level-extensions.ts`** (rewritten): reads pi-core's
    `packages` field from `<cwd>/.pi/settings.json` (project) and
    `~/.pi/agent/settings.json` (user-global) — the actual runtime
    configuration. Project wins on collision, matching pi-core's
    `DefaultPackageManager.resolve()` precedence. Resolves `npm:`
    specs via `npm root -g`; resolves local paths in place. Source
    tags: `project` / `user-global`. Accepts any package that
    declares a `pi` field with at least one resource (extensions,
    skills, or prompts) — pure skill packs like `pi-braid-skills`
    now surface alongside extension providers.
  - **`instance-composition.ts`** (rewritten):
    - `Root:` now points at the pi-core npm package folder.
    - `Cwd:` is always rendered.
    - New `Settings: ~/.pi/agent` line (or `PI_CODING_AGENT_DIR`
      override) — the userland settings dir is the agent's main
      discovery hub (settings.json, skills, memory, sessions).
    - Session line leads with the session id (so the agent can
      read the raw session file or invoke the session-recall tool)
      followed by elapsed/last-event/turns/tool-avg.
    - Discovery hint: dropped the `→` unicode arrow, broadened
      from "extension source code" to "the wider runtime" — file
      tools (`bash`, `grep`, `find`, `ls`) reach `~/.pi/agent` and
      the pi-core package, not just the listed extension paths.

  Test: `test/runtime/lib/test-instance-block.mjs` rewritten from
  17 to 19 subtests covering the Root/Cwd/Settings lines, session
  id rendering, and the settings-driven discovery contract. Test
  count: 81 (same).

- **memory-agent-bridge: nudge broader search on empty episodes.**
  When `memory action=episodes_search` returns zero hits, the
  response now ends with "Consider trying broader search."
  pointing the agent at `recall_search` (semantic similarity) as
  the next move. One-line UX improvement, no behavior change
  beyond the agent-facing message. Originated from a user
  observation that empty search results usually mean the query was
  too narrow, not that no relevant memory exists.

### Fixed

- **Post-compaction stack overflow + re-entrancy guard (enforcement).**
  Live trace: two `Maximum call stack size exceeded` errors fired
  right after the `[compaction]` summary, then a third 180s later
  when the agent manually called the scratchpad tool.

  Root cause: the `session_compact` handler synchronously called
  `callScratchpadTool(ctx, {action: "read"})` followed by two
  `sendEnforcementWhisper(...)` calls. The scratchpad tool wrapper
  in pi-core fires `tool_call` / `tool_execution_end` synchronously,
  and the timer extension's `tool_execution_end` handler invokes
  `fireExpired()` which can synchronously call `pi.sendMessage` with
  `triggerTurn: true` for any timer that expired at the same moment.
  That synchronous chain re-entered the handler (or other handlers)
  and overflowed the V8 stack before the existing
  `MAX_REENTRY_DEPTH=1` guard in `injection-tracker.ts` got a
  chance to defer.

  Fix (3 layers):
  1. Per-session `inHandler` re-entrancy guard in
     `enforcement/handlers/register-session-compact.ts` (mirrors the
     `inBeforeAgentStart` pattern from `context-lifecycle`, keyed via
     `getExtensionState` on `sessionManager.getSessionFile()` so a
     previous session's stale flag cannot poison the next session).
  2. Scratchpad read + whisper delivery deferred via `queueMicrotask`
     so the handler returns synchronously. State writes
     (`lastCompactionTurn`, `contextNudgeSent`, etc.) stay
     synchronous because downstream handlers read them on the same
     tick. Errors inside the microtask are logged, not propagated.
  3. `MAX_REENTRY_DEPTH` bumped 1 → 3 in `injection-tracker.ts`
     with a detailed comment explaining why the runtime + 25+
     extensions + the session_compact chain need that headroom.

  Test: `test/runtime/lib/test-session-compact-reentrancy.mjs` (new,
  8 subtests) pins the synchronous-return property, the deferred
  microtask side-effects, the per-session guard, and source-level
  invariants on both modified files. Test count: 81 (8 new subtests
  within the test file, not 8 new files).

- **Think-tool single source of truth + all 7 prior bugs (cognitive).**
  Seven bugs identified in the prior session's think-tool
  investigation, all addressed via one structural change: the
  schema enum and internal defaults now reference const arrays in
  `think-budget.ts`.

  - `THINK_TYPES` const array — schema enum references it. Currently
    holds 10 entries (`observation`, `planning`, `execution`,
    `reflection`, `conclusion`, `debugging`, `design`, `analysis`,
    `insight`, `research`); adding a new allowed value is now a
    one-line change in one file.
  - `DEPTH_LEVELS` const array — schema enum references it.
  - `ODAR_DEPTH_LEVELS` const array — vocabulary aligned with
    `complexityToDepth` return type.
  - `DEFAULT_THINK_TYPE` const — replaces the literal `"insight"`
    that was duplicated across the schema default and the execute
    path.

  Bug fixes:
  - **B1** (type enum restrictive): `analysis`, `insight`, `research`
    added to `THINK_TYPES`.
  - **B2** (default `'insight'` not in enum): `'insight'` added to
    `THINK_TYPES`; schema default references the const.
  - **B3** (latent fix): `complexityToDepth` previously returned
    `"standard"` which was in neither schema nor `DEPTH_BUDGETS`,
    so `getBudget("standard")` silently fell back to 512 tokens
    (the `quick` budget). Now returns `"medium"` which resolves
    correctly to 1024 tokens. The fallback no longer silently
    under-allocates.
  - **B4** (depth silently overridden by complexity): execute()
    now uses explicit precedence — `explicit depth > complexity >
    auto > quick` — and appends a `routingNote` to the depth line
    when an override happens (e.g.
    `Depth: deep (extended reasoning) (explicit depth wins over
    complexity=0.5)`).
  - **B5** (sparse tool description): expanded with required fields,
    `parent_id` chaining, depth vocabulary, complexity interaction,
    long-observation auto-estimation, type semantics, outcome
    feedback.
  - **B6** (auto_depth description wrong): doc now matches behavior
    (hidden default for observations > 30 chars is documented).
  - **B7** (complexity description wrong): doc now accurate
    (complexity is never auto-estimated — only depth is, via
    `estimateComplexity`).

  Description polish (folded into the same commit per "no reverts"):
  tool description went from a 7-clause / ~140-word block with
  quotes, parentheses, and slashes, to a 5-clause / ~95-word block
  with zero quotes, zero parens, zero slashes. The em-dash
  delimiter serves as the typographic break between the level list
  and its purpose: "Use quick, medium, or deep — for ODAR routing;
  minimal, low, high, or max — for finer control." `promptSnippet`
  also expanded to mention `parent_id` / `depth` / `complexity`.

  Test count unchanged (89). The think tool had no regression tests
  prior to this commit; the schema + execute changes were validated
  by a 19-step verification script during investigation (since
  deleted — the discipline is now committed to single source of
  truth).

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
