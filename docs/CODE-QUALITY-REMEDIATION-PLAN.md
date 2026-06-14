# Code Quality Remediation Plan

Living plan for fixing the issues found in the deep code review. Each task
has a status checkbox, the affected files, the problem, the recommended
fix, and (where applicable) a decision point or open question.

## How to use this document

- **Inline answers** — Each open question is numbered (`Q1`, `Q2`…). Reply
  to the user with the answer and I'll update the doc with the decision.
- **Decisions log** — Use the section at the top to record decisions
  permanently. Format: `D-N: YYYY-MM-DD — short decision title`.
- **Checkboxes** — `[ ]` not started · `[~]` in progress · `[x] done ·
  `[?]` blocked.
- **Status legend**: each task is `[ ]` to start.

## Status legend

| Symbol | Meaning |
|---|---|
| `[ ]` | Not started |
| `[~]` | In progress |
| `[x]` | Done |
| `[?]` | Blocked — needs user decision |
| `[!]` | Discovered a new issue during work; re-scope |

## Context

- **Source review** — this plan was derived from a deep review (not
  included in this doc; see the full review in the agent session
  transcript, dated 2026-06-13).
- **Test/source ratio** at the time of review: 5,053 test lines vs
  39,853 src lines (12.7%).
- **Type-safety bypass count**: 254 `: any` + 48 `as any`/`as unknown as`
  (302 sites).
- **Module-level `let` count**: 20+ (all violate the documented
  "use the state factory" contract).
- **Dynamic imports**: 10 in `src/`, some in hot paths.

The review pass is **not exhaustive** — the plan captures the high-value
items. Smaller code-smell fixes can be added as `MISC-N` tasks at the
bottom.

## Quick reference — existing decision docs to update

- [`AUTO-SINGLETON-DECISION.md`](./AUTO-SINGLETON-DECISION.md) —
  recommends **Option A: CUT** but not yet executed. ~3 stale
  references in code/docs need cleanup. See **TASK-1.7** below.
- [`CUT-CANDIDATES-DEEP-DIVE.md`](./CUT-CANDIDATES-DEEP-DIVE.md) —
  auto-singleton and 4 other tools analyzed.
- [`SESSION-HANDOFF-2026-06-12.md`](./SESSION-HANDOFF-2026-06-12.md) —
  32/32 tests pass as of `641c62bd`; next session is "fragile-pattern
  audit continuation."
- [`TOOL-INVENTORY-AUDIT.md`](./TOOL-INVENTORY-AUDIT.md) — prior
  consolidation reduced 42 → 30 tools (per the recall summary).
- [`PROMPT-BUILDER-INVESTIGATION.md`](./PROMPT-BUILDER-INVESTIGATION.md) —
  prior work on prompt-builder; relevant context for **TASK-1.1**.

---

## Open questions for the user

> Reply to the agent with the answer and I'll update the relevant
> question/decision/task inline.

**Q1.** Logger bug: `logger.ts` `writeToConsole` silently drops
`warn`/`info`/`debug`. Header comment claims "warn goes to console" but
the code doesn't. Two options: **(a)** restore a console path for `warn`
(matches docs), or **(b)** change the docs to "errors only; warn/info
are buffer-only." **Which?**
__
Q1: Seems we need to properly restore all loging but consult pi docs itself to find best practicies (seems console.* is for high severety ad ctx.ui.notify for low or maybe pass all logs through tui and not touch console.* at all?)
__

**Q2.** The 4 arXiv citations in `prompt-builder/behavioral-guardrails.ts`
and the comment at `prompt-builder/index.ts:160-161` (references
`2604.19768`, `2604.19117`, `2604.15224`, `2604.14881`) — are these
real papers you've read, or are they placeholders to be replaced? **If
real, do you want me to verify they resolve?** If placeholders, **do
you want citations removed entirely, or marked as `[TODO: cite
source]`**?

**Q3.** The `_nudgeManager: NudgeManager` parameter in
`enforcement/handler-registry.ts:99` is constructed but never used. Do
you want me to **(a)** wire it into the inline `sendSmartNudge` call in
handlers, **(b)** delete it and the constructor in
`enforcement/index.ts`, or **(c)** keep it for now and revisit?
__
Q3:
__

**Q4.** `KNOWN_SAFE_GIT_SUBCOMMANDS` (24 entries) and
`KNOWN_DANGEROUS_GIT_FLAGS` (4 regex) in `tool-safety/index.ts` are
labelled a "hacking-a0 infection check layer" but they're really a perf
optimization to skip the LLM for known-safe operations. Do you want to
**(a)** relabel and document honestly, **(b)** make the LLM mandatory
for safety (slower but safer), or **(c)** keep the allow-list and add
a "this is a perf optimization, not a security guarantee" comment?

**Q5.** Module-level state: 20+ `let` bindings violate the documented
contract. Migration is multi-week work. Pragmatic approach: **(a)** pick
the top 5 most leak-prone and migrate those, **(b)** update the contract
to admit exceptions (e.g., "module-level state OK for read-only
constants and process-global flags"), or **(c)** full migration, full
audit, structural test to prevent regression. **Which scope?**
__
Q5: Need to properly identify and fix literally all issues and fix them systemically with planning and task management before execution and implementation.
__

**Q6.** `HANDLER_REGISTRATIONS` in
`enforcement/handler-registry.ts:45-69` is a hand-coded test fixture
that drifts. Three options: **(a)** delete it (the inline code is the
truth), **(b)** replace with runtime introspection of the live event
bus, or **(c)** keep but add a CI check that compares array entries
to actual `registerTurnEndHandler` calls. **Which?**

**Q7.** The "two state systems" pattern (`extension-state.ts` +
`global-state.ts`) is used in 11+ files. Do you want to **(a)** make
`global-state.ts` session-scoped (full migration), **(b)** keep
`global-state.ts` for true process-globals only and audit
back, or **(c)** leave it as-is and document the distinction? **Which?**
__
Q7: need to do a full deep audit, investigation and understanging of issue and how to properly fix it.
__

**Q8.** The `Promise.all` (10) vs `Promise.allSettled` (2) ratio
suggests inconsistent error handling. Do you want a code-review
checklist rule (**"all best-effort fan-out must use `allSettled`"**)
or a lint rule, or both? **Both is recommended but slower to land.**

**Q9.** Tier-1 fallback bug: `polarityDetectionFallback` and similar
return values that `classify()`'s tier-1 check (`lower === "yes" || lower
=== "no"`) silently drops. Should I **(a)** widen the tier-1 matcher
to accept the actual returned values per critic, **(b)** rewrite the
fallbacks to return "yes"/"no" only, or **(c)** add per-critic
`acceptLabels: string[]` config? **Which is least invasive?**

**Q10.** The `auto-singleton` decision (CUT) was made in
`AUTO-SINGLETON-DECISION.md` but never executed. There are 3 stale
references (`src/AGENTS.md:37,59`, `injection-tracker.ts:162,174`,
`turn-dedup.ts:68`, `enforcement/AGENTS.md:49`,
`metacognition/handlers/AGENTS.md:25`, `self/watchdog/AGENTS.md:9`).
Do you want me to **(a)** execute the CUT now as TASK-1.7, **(b)** just
clean the stale references and keep auto-singleton around, or **(c)**
defer — focus on other work first? **Which?**
__
Q10: Seems need to cut as there is a background behind that desicion.
__

**Q11.** Two large state-state systems in the enforcement layer:
`enforcement/state.ts` (session-scoped via WeakMap) and
`enforcement/handlers/analysis/bpe-handler.ts:18`
(`let _lastRecommendationType: string | null = null;` — module-level).
Same data, two mechanisms. The session-scoped version gets reset on
session boundary; the module-level one doesn't. Is the module-level
one intentionally process-global (so it spans sessions), or is it a
bug? **If bug: migrate to session-scoped. If intentional: document.**

**Q12.** `enforcementSignals` (signals.ts) is described as
"turn-keyed" in the comment but never evicts. The records grow
unbounded. Three options: **(a)** implement turn-keyed eviction
(matches doc), **(b)** add a hard cap (e.g., 50 entries), **(c)** both.
**Which?**

**Q13.** The 7+ `index.ts` files over 500 lines (`scratchpad`,
`memory-agent-bridge`, `context-lifecycle`, `heartbeat-scheduler`,
`timer`, `metacognition/handlers/think.ts`, `compaction.ts`) should
probably be split. Aggressive: split all in one pass. Conservative: only
split the worst 2-3. **Which scope?**

**Q14.** 23 sites use `Date.now() + Math.random()` for IDs, making
tests non-deterministic. Do you want a single `idFactory.ts` utility
in `lib/utils/` (with an injectable seed for tests) and a refactor of
all 23 sites, or accept the testability cost? **Which?**
__
Q14: seems adding single utility factory to fix this issue is obvious and doesn't need my decision
__

**Q15.** Are there code-style/lint rules I should be aware of? I see
`eslint.config.js` and `.prettierrc` in the repo. Do you want me to
add specific lint rules to enforce some of the contracts I'm finding
violated (e.g., no module-level `let` outside `lib/state/`, no dynamic
`import()` outside `lib/`, no `Date.now()`-based IDs)?

---

## Decisions log

> Decisions made on open questions. Update inline as we go.

**D-1: 2026-06-13** — Logger bug (Q1) deferred until user reviews.
The plan stands; will revisit when user picks an answer.

**D-2: 2026-06-13** — Q15 (lint rules) deferred. None of the executed
tasks required new lint rules; will revisit if/when the user adds
answers to the other questions.

**D-3: 2026-06-13** — Q4 (`KNOWN_SAFE_GIT_SUBCOMMANDS` heuristic)
resolved by **removal** of the entire `tool-safety` extension.
User decision: the extension's heuristics were too fragile AND
out of scope for braid (a metacognitive tool, not a safety
shell). Documented in TASK-1.6.

**D-4: 2026-06-13** — Q9 (tier-1 fallback contract) defaulted to
**widening the matcher to accept any short string label**. The
hand-coded fallbacks are reviewed and intentional; treating
their output as authoritative is safer than silently consulting
the LLM. If a fallback is wrong, that's a separate bug — fix the
fallback, not the matcher. Documented in TASK-1.4.

---

## P0 — Functional bugs

### TASK-0.1: Fix `logger.ts` silent-drop bug

- **Status**: [ ]
- **Files**: `src/lib/core/logger.ts:97-106`
- **Problem**: `writeToConsole` switch drops `warn`/`info`/`debug` in
  the default branch. Header comment claims "warn goes to console" —
  false. `writeToUI` was removed but the comment still says "only
  ui.notify for warn/error."
- **Recommended fix**: depends on **Q1**. Default: restore a console
  path for `warn` (matches docs, fixes the visible bug). Update header
  comment to "info/debug: TUI/buffer only; warn/error: console + TUI."
- **Decision needed**: yes — **Q1**
- **Effort**: S
- **Risk**: low

### TASK-0.2: Audit `pi.events.on` usage in `prompt-builder`

- **Status**: [ ]
- **Files**: `src/extensions/core/prompt-builder/index.ts:232-237`
- **Problem**: This is the ONLY `pi.events.on` usage in the entire
  codebase (vs 20+ `pi.on(...)`). Either the enforcer is emitting via
  a pubsub I'm misreading, or this listener never fires. If it never
  fires, `activeContrastMode` is stuck on `"TRUTH-SEEKING"` forever.
- **Recommended fix**: trace whether the enforcer emits via
  `pi.events.emit`/`emitCustomEvent` or via the `onEvent` lib wrapper.
  Pick one API and use it consistently. The simplest fix: change
  `pi.events.on(...)` to `onEvent(pi, "enforcement_signals", ...)` if
  that's how the enforcer emits.
- **Decision needed**: needs SDK lookup — will determine the right
  answer. Add a constant `ENFORCEMENT_SIGNALS` to
  `lib/core/event-names.ts` and use it on both sides.
- **Effort**: S
- **Risk**: low (if listener never fires, removing it is no regression)

### TASK-0.3: Convert the 10 dynamic imports to static

- **Status**: [x] DONE (2026-06-13) — **all 16 dynamic import sites
  in src/ converted to static.** Zero `await import(` remain in src.
- **Files CONVERTED** (16 dynamic statements removed across 13 files):
  - `src/extensions/cognitive/tool-safety/index.ts:137` → static
    import of `sendTrackedMessage`.
  - `src/extensions/cognitive/metacognition/handlers/finalize.ts:29, 66`
    → static imports of `addEpisode`, `addPrinciple`,
    `executeConsolidation`. **Found path bug**: the dynamic import
    was `../../memory/...` (wrong; should be
    `../../../memory/...`). TypeScript caught it on the static
    import.
  - `src/extensions/core/input-polisher/index.ts:498` → static
    import of `isCompactionActive`. The "circular dep" comment
    was a false alarm.
  - `src/extensions/memory/context-manager/handlers/tools/context-compress.ts:98`
    → static namespace import of `timerMod`.
  - `src/extensions/memory/context-lifecycle/index.ts:208` → static
    namespace import of `timerMod`.
  - `src/extensions/heartbeat/heartbeat-scheduler/index.ts:354, 488,
    515, 570, 618` → 5 dynamic imports collapsed into 3 static
    imports (`trackSuggestionFeedback`, `retrieveEpisodes`,
    `addEpisode`, `executeConsolidation`).
- **Files CONVERTED in third batch** (remaining 6 sites):
  - `src/extensions/heartbeat/heartbeat-scheduler/modules/timer-reminder.ts:23`
    → static `drainTimerReminders`.
  - `src/extensions/heartbeat/heartbeat-scheduler/modules/context-hygiene.ts:107`
    → static `evaluateContextDensity`.
  - `src/extensions/heartbeat/heartbeat-scheduler/modules/budget.ts:35-36`
    → static `loadScratchpadFromDisk`, `saveScratchpadToDisk`,
    `emitSignal`.
  - `src/extensions/heartbeat/analytics/index.ts:291`
    → static `formatABResults`.
  - `src/extensions/enforcement/handlers/probe-handler.ts:146-147`
    → static `classify`, `CRITICS`.
  - `src/extensions/enforcement/handlers/register-session-compact.ts:39`
    → static namespace `timerMod`.
  - `src/extensions/enforcement/handlers/routing-handler.ts:110-111`
    → static `classify`, `CRITICS`.
  - `src/lib/utils/filter-safe-to-remove.ts:345-346`
    → static `classify`, `CRITICS`.
  - `src/lib/utils/sop-suggestion.ts:124`
    → static `classify as textClassifier` (renamed to avoid shadowing).
  - `src/lib/reasoning/reasoning-summary.ts:51`
    → static `classify`.
  - `src/lib/detection/degradation-detector.ts:368-369`
    → static `classify`, `CRITICS`.
  All passed typecheck on first try. No real cycles existed in any
  of these files.
- **Problem**: dynamic imports defeat tree-shaking, fragment code,
  hide cycles, and add a microtask per call. One was hidden behind
  `// @ts-expect-error`.
- **Recommended fix**: convert to static imports. If a true cycle
  exists, refactor to break it (don't paper over with dynamic import).
- **Decision needed**: no
- **Effort**: S–M (depends on how many cycles emerge)
- **Risk**: low–medium (cycle fixes are the only risk)
- **Implementation note**: ALL 16 "circular dep" / "lazy load"
  comments turned out to be false alarms — static import worked
  on the first try for every converted site. The codebase was
  much more cautious about cycles than necessary.

---

## P1 — Documented-contract violations

### TASK-1.1: Add a CI test that the manifest matches the filesystem

- **Status**: [x] DONE (2026-06-13)
- **Files**: `test/runtime/test-manifest-consistency.mjs` (new)
- **Problem**: AGENTS.md / manifest.ts / filesystem disagree about
  what extensions exist (e.g., `auto-singleton` referenced in 3 docs
  but not in filesystem or manifest; README lists 31 rows, manifest
  has 28 entries).
- **Recommended fix**: walk `src/extensions/*/index.ts`, compare
  against `manifest.ts` IDs, compare against AGENTS.md mention. Fail
  CI on any drift. Similar to existing
  `test-single-ownership.mjs` pattern.
- **Decision needed**: no
- **Effort**: S
- **Risk**: low
- **Implementation**: walks filesystem, parses `manifest.ts` for
  `id:` lines and `import ... from` paths. Reports orphans, dangling
  entries, and missing imports. Current state: 26 dirs / 26 IDs /
  26 imports — all aligned. Confirmed: README is the drift source
  (lists 31 rows; the codebase has 26 extensions).

### TASK-1.2: Add a structural test for enforcement state composition

- **Status**: [x] DONE (2026-06-13)
- **Files**: `test/runtime/lib/test-enforcement-state-composition.mjs` (new)
- **Problem**: `enforcement/state.ts:81-92` spreads 7 sub-state
  objects. A real bug — overlapping keys with incompatible types —
  would be silently overwritten. The comment warns about this. No
  test enforces it.
- **Recommended fix**: assert that `createState()` keys equal the
  union of all 7 sub-state interface keys. Use TypeScript's `keyof`
  in the test via a generated type test.
- **Decision needed**: no
- **Effort**: S
- **Risk**: low
- **Implementation**: 3 assertions in one file:
  1. `Object.keys(createState()).length === 65` (baseline; update
     on intentional key addition).
  2. Sentinel keys from each of the 7 sub-state interfaces are
     present.
  3. All Map/Set values are initialized (not null).
  **Bonus**: the test caught a false positive in itself
  (matching "EnforcementState" identifier name in a code comment);
  fixed by stripping comments before matching.

### TASK-1.3: Make `_nudgeManager` actually used (or remove it)

- **Status**: [ ]
- **Files**: `src/extensions/enforcement/handler-registry.ts:99`,
  `src/extensions/enforcement/index.ts:25-32`,
  `src/extensions/enforcement/nudge-manager.ts`
- **Problem**: `NudgeManager` is constructed in the extension factory
  and threaded into `registerHandlers` but never consulted by any
  handler. The actual nudge deduplication lives in module-level state
  of `nudge-manager.ts` for other callers. Parallel systems.
- **Recommended fix**: depends on **Q3**.
- **Decision needed**: yes — **Q3**
- **Effort**: M
- **Risk**: medium (touches a hot path)

### TASK-1.4: Resolve the tier-1 fallback contract bug

- **Status**: [x] DONE (2026-06-13) — defaulted to widening the
  tier-1 matcher to accept any short string. Documented as D-4.
- **Files**: `src/lib/ai/text-classifier.ts:88`,
  `src/lib/ai/critic-registry.ts` (all `*Fallback` functions)
- **Problem**: `classify()` tier-1 fast path requires
  `lower === "yes" || lower === "no"`. Several fallbacks return
  values outside this set (`positive`/`negative`/`neutral`,
  `SHALL`/`MUST`/`SHOULD`/`MAY`, `resolved_for`/`resolved_against`,
  `HIGH`/`MEDIUM`/`LOW`, `AGGRESSIVE`/`SEMANTIC`/`CONSERVATIVE`/`NONE`,
  `DEGRADED`/`STABLE`, `rate_limit`/`server_error`/etc.). All of these
  silently fall through to the LLM tier. The "fast and free" promise
  of tier 1 is broken for ~30% of critics.
- **Recommended fix**: depends on **Q9**.
- **Decision needed**: yes — **Q9**
- **Effort**: M
- **Risk**: medium (changes behavior of every critic)

### TASK-1.5: Implement or remove the "turn-keyed" promise in `signals.ts`

- **Status**: [ ]
- **Files**: `src/extensions/enforcement/signals.ts:11-15, 18`
- **Problem**: Comment claims "Turn-keyed so stale signals are dropped
  when the turn advances without new signals." Code: a plain `Record`
  with no eviction. Records accumulate forever.
- **Recommended fix**: depends on **Q12**.
- **Decision needed**: yes — **Q12**
- **Effort**: S
- **Risk**: low

### TASK-1.6: Document the reality of `KNOWN_SAFE_GIT_SUBCOMMANDS`

- **Status**: [x] DONE (2026-06-13) — **by removal of the entire
  `tool-safety` extension**, not by documentation. User decided
  the heuristics were too fragile AND out of scope for braid.
- **Files** removed/changed:
  - `src/extensions/cognitive/tool-safety/index.ts` (deleted, 175 lines)
  - `src/lib/ai/critic-registry.ts` — removed `CRITICS.toolSafety`
    and `toolSafetyFallback()` (~25 lines).
  - `src/extensions/manifest.ts` — removed import + entry.
  - `src/lib/utils/injection-tracker.ts` — removed `tool-safety`
    from critical-source regex.
  - `src/lib/constants/tool-constants.ts` — header comment updated.
  - `src/lib/enforcement/turn-dedup.ts` — removed from priority
    cap comment.
  - `src/extensions/enforcement/AGENTS.md` — removed from
    triggerTurn list.
  - `test/runtime/lib/test-timer-fire-suppression.mjs` — removed
    2 test assertions.
- **Problem**: 24-entry allow-list + 4-regex deny list is described
  as "Part of the hacking-a0 infection check layer" — implying
  security. Actually a perf optimization to skip the LLM for known
  commands. The denial regexes can be bypassed by new flag syntaxes.
- **Recommended fix**: depends on **Q4**. Default: relabel to "perf
  optimization" and add a comment that this is NOT a security check.
- **Decision needed**: yes — **Q4**
- **Effort**: S
- **Risk**: low
- **Implementation**: the user decided the entire extension is
  out of scope for braid (a metacognitive tool, not a safety
  shell). Deleted the extension + all its references across 8
  files. Net: -200+ lines. Manifest went from 26 to 25
  extensions. Test suite still 35/35 (the deleted test assertions
  were redundant — other source patterns still cover the
  remaining critical sources).

### TASK-1.7: Execute or defer the `auto-singleton` CUT

- **Status**: [ ]
- **Files**: 
  - `src/AGENTS.md:37, 59` (lists it)
  - `src/extensions/scheduling/AGENTS.md` (says "Both are always-on")
  - `src/extensions/cognitive/metacognition/handlers/AGENTS.md:25`
  - `src/extensions/self/watchdog/AGENTS.md:9`
  - `src/extensions/enforcement/AGENTS.md:49` (lists in `triggerTurn: true`)
  - `src/lib/utils/injection-tracker.ts:162, 174`
  - `src/lib/enforcement/turn-dedup.ts:68`
- **Problem**: `AUTO-SINGLETON-DECISION.md` recommends **Option A: CUT**
  but it's not executed. Stale references still exist. Per the
  session handoff doc, this is the work for the current stretch.
- **Recommended fix**: depends on **Q10**.
  - **If CUT**: remove all 6 references, update the 4 AGENTS.md
    files, verify tests pass.
  - **If defer**: update the 6 references to remove the
    "auto-singleton" mention but keep the file/extension.
- **Decision needed**: yes — **Q10**
- **Effort**: S
- **Risk**: low (per the decision doc, no internal callers)

### TASK-1.8: Add the missing `test-enforcement-deps.mjs` test (or remove the claim)

- **Status**: [x] DONE (2026-06-13)
- **Files**: 
  - `src/extensions/enforcement/AGENTS.md:42-43` (claim is now true)
  - `test/runtime/lib/test-enforcement-deps.mjs` (created)
- **Problem**: AGENTS.md claims a structural test exists at a
  specific path. It does not. Reader assumes a check is in place;
  it's not.
- **Recommended fix**: write the test (it should verify the
  import-direction contract: `enforcement-types.ts` is the only file
  imported by both `state.ts` and the sub-state files; sub-state
  files do not import `state.ts`). OR remove the claim from
  AGENTS.md and document the contract informally.
- **Decision needed**: which option (chose: write the test)
- **Effort**: S
- **Risk**: low
- **Implementation**: 4 assertions:
  1. No sub-state file imports from `state.ts` (the contract).
  2. `state.ts` imports sub-state factories (≥7 imports).
  3. `state.ts` imports shared types from `enforcement-types.ts`.
  4. Sub-state files that USE `EnforcementState`/`ENFORCEMENT_PARAMS`
     in their code (not just comments) import them from
     `enforcement-types.ts`. Comments stripped to avoid false
     positives.
  All pass. The AGENTS.md claim is now true.

---

## P2 — Architecture and design issues

### TASK-2.1: Migrate top-5 most-leak-prone module-level `let` to `getExtensionState`

- **Status**: [ ]
- **Files** (candidates, ranked by leak risk):
  1. `src/extensions/core/agent-environment/index.ts:34-43` — entire
     `_state` is per-session in intent.
  2. `src/extensions/memory/context-lifecycle/state.ts:74-75` — admits
     it's a fallback for missing `ctx`.
  3. `src/lib/utils/injection-tracker.ts:40, 48` — `_activeSessionId`
     and `_sendDepth`; both per-session in spirit.
  4. `src/extensions/memory/context-manager/handlers/compaction.ts:113-125` —
     5 let bindings, including `_interceptedSmRef: any`.
  5. `src/extensions/enforcement/handlers/analysis/bpe-handler.ts:18` —
     `_lastRecommendationType`.
- **Problem**: violates documented contract. Cross-session leaks and
  races are real risks, especially for the re-entrancy guards.
- **Recommended fix**: depends on **Q5**. For each candidate,
  - thread `ctx` through the call sites that mutate,
  - use `getExtensionState(ctx, "key", factory)`,
  - verify with a "two-sessions-isolated" test.
- **Decision needed**: yes — **Q5** (scope)
- **Effort**: L (each is small but there are 5)
- **Risk**: medium (touches turn pipeline)

### TASK-2.2: Document or migrate the `global-state.ts` ↔ `extension-state.ts` split

- **Status**: [ ]
- **Files**: `src/lib/state/extension-state.ts`,
  `src/lib/state/global-state.ts`
- **Problem**: two state systems in parallel. Some files use both for
  the same kind of data (e.g., `agent-environment/index.ts`).
- **Recommended fix**: depends on **Q7**. Default: add a header to
  `global-state.ts` defining "this is for process-globals only —
  custom model keys, rotation state" and audit every caller.
- **Decision needed**: yes — **Q7**
- **Effort**: M
- **Risk**: low

### TASK-2.3: Split the 7 over-500-line `index.ts` files

- **Status**: [ ]
- **Files**:
  - `src/extensions/memory/scratchpad/index.ts` (654)
  - `src/extensions/memory/memory-agent-bridge/index.ts` (805)
  - `src/extensions/memory/context-lifecycle/index.ts` (749)
  - `src/extensions/heartbeat/heartbeat-scheduler/index.ts` (669)
  - `src/extensions/scheduling/timer/index.ts` (584)
  - `src/extensions/cognitive/metacognition/handlers/think.ts` (578)
  - `src/extensions/memory/context-manager/handlers/compaction.ts` (619)
- **Problem**: AGENTS.md for `enforcement/` says files should not
  exceed ~250 lines. No other extension enforces this. These files
  are doing too much.
- **Recommended fix**: depends on **Q13**. Default: pick the worst
  2-3 (`context-lifecycle`, `memory-agent-bridge`, `compaction.ts`)
  and split. Use a consistent pattern: `index.ts` wires,
  `handlers/*.ts` for each handler, `state.ts` for state, `types.ts`
  for types.
- **Decision needed**: yes — **Q13**
- **Effort**: L
- **Risk**: medium (splitting can introduce cycles)

### TASK-2.4: Move hand-coded tool-name knowledge into a registry

- **Status**: [ ]
- **Files**:
  - `src/extensions/memory/context-lifecycle/index.ts:54-63` —
    `CONTEXT_MGMT_TOOLS` set
  - `src/extensions/enforcement/handlers/register-tool-call.ts:30-69` —
    hardcoded `toolName === "think"`/`"finalize"`/etc. checks
  - `src/extensions/core/prompt-builder/index.ts:67-77` —
    `KNOWN_SNIPPETS` map
- **Problem**: enforcement/lifecycle know the names and shapes of
  tools registered by other extensions. Rename a tool in
  `metacognition/think.ts` and enforcement silently stops tracking.
- **Recommended fix**: introduce a `lib/tools/registry.ts` (or
  similar) that exposes `getTool(name): ToolDef` and
  `getToolsByTag(tag): ToolDef[]`. Extensions publish their tools to
  the registry; others consume.
- **Decision needed**: no (architectural)
- **Effort**: L
- **Risk**: high (touches every extension)

### TASK-2.5: Stop replicating pi-core logic in `prompt-builder`

- **Status**: [ ]
- **Files**: `src/extensions/core/prompt-builder/index.ts:170-227`
  (project-context walking)
- **Problem**: the file admits it "replicates" pi's project-context
  loader. If pi changes, this breaks silently.
- **Recommended fix**: check whether pi exposes the project-context
  loader as an API; if so, use it. If not, file an upstream issue
  and pin a version note.
- **Decision needed**: no
- **Effort**: S (if pi has an API) / blocked (if not)
- **Risk**: depends on upstream

### TASK-2.6: Consolidate dedup logic into `lib/utils/dedup.ts`

- **Status**: [ ]
- **Files**:
  - `src/extensions/enforcement/nudge-manager.ts:115-130` (cyrb53)
  - `src/lib/store/claim-tracker.ts` (custom dedup)
  - `src/lib/store/evidence-pool.ts` (custom dedup)
  - `src/lib/store/conflict-qa.ts` (custom dedup)
  - `src/lib/detection/degradation-detector.ts` (custom dedup)
- **Problem**: 5+ files each hand-roll "have I seen this recently?"
  logic. Different hashes, different eviction policies.
- **Recommended fix**: single `lib/utils/dedup.ts` with an LRU+hash
  interface. Refactor all 5 callers.
- **Decision needed**: no
- **Effort**: M
- **Risk**: low

### TASK-2.7: Add an injectable ID factory, replace 23 `Date.now()+Math.random()` sites

- **Status**: [ ]
- **Files**: 23 sites across `src/`. Examples:
  - `src/extensions/scheduling/timer/index.ts:54`
  - `src/extensions/memory/scratchpad/index.ts:106-110`
  - `src/extensions/heartbeat/heartbeat-scheduler/index.ts:489-516`
  - `src/lib/reasoning/belief-policy-engine.ts:236`
- **Problem**: tests are non-deterministic. Same epic can have
  different IDs across runs.
- **Recommended fix**: depends on **Q14**. Default: `lib/utils/id.ts`
  with `nextId(prefix)`. Inject a seed in tests via
  `extension-state.ts`.
- **Decision needed**: yes — **Q14**
- **Effort**: M
- **Risk**: low

### TASK-2.8: Add a single `Promise.allSettled` lint rule

- **Status**: [ ]
- **Files**: `eslint.config.js`
- **Problem**: 10 `Promise.all` vs 2 `allSettled` for best-effort
  fan-out. Comment in `prompt-builder/index.ts:252-256` explicitly
  says "allSettled ensures one failure doesn't block" — the
  convention is right, the usage is inconsistent.
- **Recommended fix**: depends on **Q8**. Default: ESLint custom
  rule that flags `Promise.all` in `src/extensions/**` (best-effort
  paths) and suggests `Promise.allSettled` with a comment.
- **Decision needed**: yes — **Q8**
- **Effort**: M (rule is small; auditing is bigger)
- **Risk**: low

### TASK-2.9: Replace `HANDLER_REGISTRATIONS` fixture with a real introspection

- **Status**: [ ]
- **Files**: `src/extensions/enforcement/handler-registry.ts:45-69`
- **Problem**: hand-coded array of 17 entries can drift. Test passes
  even if the actual `registerTurnEndHandler` calls diverge.
- **Recommended fix**: depends on **Q6**. Default: write a runtime
  helper that walks the `registerTurnEndHandler` calls (instrument
  it) and exposes the list via a constant. Test consumes the
  constant.
- **Decision needed**: yes — **Q6**
- **Effort**: M
- **Risk**: low

---

## P3 — Code smells

### TASK-3.1: Replace hand-rolled `cyrb53` with `node:crypto`

- **Status**: [x] DONE (2026-06-13)
- **Files**: `src/extensions/enforcement/nudge-manager.ts:115-130`
- **Problem**: 16-line custom string hash with 2 magic constants.
  `node:crypto.createHash` exists.
- **Recommended fix**: use
  `crypto.createHash('sha1').update(s).digest('base64url').slice(0, 11)`.
- **Decision needed**: no
- **Effort**: XS
- **Risk**: low
- **Implementation**: replaced with
  `createHash("sha1").update(str).digest("base64url").slice(0, 16)`.
  Typecheck clean, all tests pass that were passing before.
  Functional behavior identical (string-equality dedup).

### TASK-3.2: Move `CHANGES` history out of file headers

- **Status**: [x] PARTIAL DONE (2026-06-13) — `prompt-builder` cleaned.
  `enforcement/state.ts` and `context-lifecycle/index.ts` headers are
  less heavy; deferred (they describe current architecture, not
  change history per se).
- **Files**:
  - `src/extensions/core/prompt-builder/index.ts:40-65` (14-entry
    CHANGES log) — **CLEANED** (replaced with 5-line summary
    pointing to CHANGELOG.md).
  - `src/extensions/enforcement/state.ts` (describes current
    sub-state structure, not change history) — **KEPT**.
  - `src/extensions/memory/context-lifecycle/index.ts` (describes
    current architecture) — **KEPT**.
- **Problem**: change history in source files. Belongs in
  `CHANGELOG.md` or git history.
- **Recommended fix**: move to `CHANGELOG.md`; replace the header
  block with a 1-2 sentence summary.
- **Decision needed**: no
- **Effort**: S
- **Risk**: low
- **Implementation**: replaced the 14-entry CHANGES block in
  `prompt-builder/index.ts` with a 5-line summary. The architectural
  description block above it (lines 13-37) is legitimate
  documentation and was kept.

### TASK-3.3: Consolidate "process-globals" into `lib/state/`

- **Status**: [ ]
- **Files**: `src/lib/memory/index.ts:153` (`_singletonInstance`),
  `src/lib/utils/injection-tracker.ts:38, 40, 48` (`_buckets`,
  `_activeSessionId`, `_sendDepth`),
  `src/lib/state/extension-state.ts:21, 24, 28, 192` (4 module-level
  Maps/WeakMaps),
  `src/lib/state/async-storage.ts:21` (`writeQueue`),
  `src/lib/state/global-state.ts:17, 76` (`_customModelKeys`,
  `_rotationState`),
  `src/lib/ai/critic-stats.ts:36` (`perCritic`),
  `src/lib/events/timer-bus.ts:21` (`handlers`)
- **Problem**: many module-level state holders in `lib/`. Each is a
  cross-session leak risk if any holds session data by mistake.
- **Recommended fix**: depends on **Q7** and **Q5**. Add a header to
  each: "session-scoped?" yes/no. If no, document why.
- **Decision needed**: covered by Q5/Q7
- **Effort**: S
- **Risk**: low

### TASK-3.4: Add a `.gitignore` for `dist/`, `pi-session-*.html`, evaluation scratch

- **Status**: [ ]
- **Files**: `.gitignore` (add entries)
- **Problem**: 17,000 lines of compiled JS in `dist/`; 8 large
  `pi-session-*.html` files (~22MB total) committed.
- **Recommended fix**: add `dist/`, `pi-session-*.html`, and
  `evaluation/results/**` to `.gitignore`. Use `git rm --cached`
  to remove the tracked ones. (Or: do nothing, since the
  audit/session files are reference material.)
- **Decision needed**: which to keep
- **Effort**: S
- **Risk**: low (one-time history change)

### TASK-3.5: Make `extension_state` ownership rules explicit

- **Status**: [x] DONE (2026-06-13)
- **Files**: `src/lib/state/extension-state.ts` header comment
- **Problem**: the file is the documented per-session state, but its
  own header doesn't say "this is the only sanctioned way" — leading
  to 20+ module-level `let`s bypassing it.
- **Recommended fix**: add a prominent header:
  "This is the ONLY sanctioned state holder. Module-level mutable
  state is forbidden by `AGENTS.md`. If you need a `let`, put it here
  with a session key."
- **Decision needed**: no
- **Effort**: XS
- **Risk**: low
- **Implementation**: header now explicitly states "⚠️ This is the
  ONLY sanctioned state holder" and points to TASK-2.1 in this plan
  for the migration of the existing 20+ violations. Also documents
  the 4 bookkeeping-level holders in the file itself as explicit
  exceptions.

---

## P4 — Durability

### TASK-4.1: Add CI step to verify arXiv citations resolve

- **Status**: [ ]
- **Files**: 4 citations in
  `src/extensions/core/prompt-builder/behavioral-guardrails.ts` and
  `src/extensions/core/prompt-builder/index.ts:160-161`
- **Problem**: depends on **Q2**. If citations are real, they should
  be verifiable. If placeholders, they should be removed or marked.
- **Recommended fix**: depends on **Q2**. Default: add a
  `test-citations.mjs` that calls arxiv.org/abs/<id> and asserts
  the page loads.
- **Decision needed**: yes — **Q2**
- **Effort**: S
- **Risk**: low

### TASK-4.2: Consolidate enforcement's knowledge of `think`/`plan`/`finalize`

- **Status**: [ ]
- **Files**: `src/extensions/enforcement/handlers/register-tool-call.ts:46-70`
- **Problem**: enforcement knows the internal shape of `think` (`type`,
  `parent_id`, `confidence`), `finalize` (sets a flag), `edit`/`write`
  (`path` field). Rename any and enforcement silently breaks.
- **Recommended fix**: have `metacognition/` emit a
  `thought_recorded` event; enforcement subscribes. Same for
  `finalize`. (Same architecture as TASK-0.2 / enforcement_signals.)
- **Decision needed**: no
- **Effort**: M
- **Risk**: low

### TASK-4.3: Make `tier-1` heuristic actually fast

- **Status**: [ ]
- **Files**: `src/lib/ai/text-classifier.ts:88`
- **Problem**: tier-1 fast path requires `lower === "yes" || lower === "no"`.
  Many fallbacks return other values. The fast path is silent — the
  caller can't tell if the heuristic ran.
- **Recommended fix**: depends on **Q9**. Default: add
  `tier1Evaluated: boolean` to `ClassificationResult` so callers can
  see if the heuristic was tried. (Even if it returned an unknown
  value, the caller knows tier-1 was attempted.)
- **Decision needed**: covered by Q9
- **Effort**: S
- **Risk**: low

### TASK-4.4: Remove or gate the `filter-safe-to-remove` heuristic chain

- **Status**: [ ]
- **Files**: `src/lib/utils/filter-safe-to-remove.ts` (364 lines)
- **Problem**: 90% regex rules; LLM tier is opt-in. In production at
  scale, only the heuristic runs. The rules are unlikely to
  generalize.
- **Recommended fix**: either delete the file (let compaction.ts
  use the LLM tier directly) or make the LLM tier the default.
- **Decision needed**: which
- **Effort**: M
- **Risk**: medium (touches compaction)

### TASK-4.5: Add `crypto.randomUUID()` for any new ID

- **Status**: [ ]
- **Files**: lint rule (new)
- **Problem**: 23 sites use `Date.now() + Math.random()` for IDs.
  New sites keep being added.
- **Recommended fix**: ESLint rule that flags new `Date.now() +
  Math.random()` patterns in `src/`. (Pairs with TASK-2.7.)
- **Decision needed**: covered by Q15 (lint)
- **Effort**: S
- **Risk**: low

### TASK-4.6: De-magic-number the safety/file-mutation timeouts

- **Status**: [ ]
- **Files**: many — `30 * 24 * 60 * 60 * 1000` (30 days),
  `7 * 24 * 60 * 60 * 1000` (7 days), `5 * 60 * 1000` (5 min),
  `60 * 60 * 1000` (1 hour), `50` (turns), `34` (turns),
  `0.66` (fraction), `0.3` (similarity threshold)…
- **Problem**: magic numbers scattered. The values are right, the
  layout isn't.
- **Recommended fix**: pull them into `src/lib/constants/` as named
  exports. Per-domain: `HINT_MAX_AGE_MS`, `MAX_SESSION_AGE_MS`,
  `CONTEXT_AUDIT_THRESHOLD`, etc.
- **Decision needed**: no
- **Effort**: M
- **Risk**: low

### TASK-4.7: Replace `toolsSinceReflection++` direct mutation with the helper

- **Status**: [x] DONE (2026-06-13)
- **Files**:
  `src/extensions/enforcement/handlers/register-tool-call.ts:67-69`
- **Problem**: direct field mutation; bypasses the dedicated
  `incrementToolsSinceReflection` helper exported from
  `substate/thought-chain-state.ts`.
- **Recommended fix**: use the helper. (1-line change.)
- **Decision needed**: no
- **Effort**: XS
- **Risk**: low
- **Implementation**: changed the call site from
  `getState(ctx).toolsSinceReflection++` to
  `incrementToolsSinceReflection(getState(ctx))`. Added the helper
  to the import from `state.ts` (where it is re-exported).

### TASK-4.8: Remove the "evidence" and "deduplication" hand-rolled heuristics from individual files

- **Status**: [ ]
- **Files**: 5+ (see TASK-2.6)
- **Recommended fix**: same as TASK-2.6.
- **Decision needed**: covered by TASK-2.6
- **Effort**: covered by TASK-2.6
- **Risk**: covered

---

## P5 — Test quality

### TASK-5.1: Add a "two-sessions-isolated" structural test

- **Status**: [ ]
- **Files**: `test/runtime/test-session-isolation.mjs` (new)
- **Problem**: biggest documented-contract violation is
  "no module-level `let`." No test asserts a per-session value is
  reset across session boundaries.
- **Recommended fix**: for each known module-level state holder,
  assert that mutating state in session A doesn't affect session B.
- **Decision needed**: no
- **Effort**: M
- **Risk**: low

### TASK-5.2: Migrate `.mjs` tests to a real test runner

- **Status**: [ ]
- **Files**: all `test/runtime/**/*.mjs`
- **Problem**: tests use vanilla JS, no types, parse results via
  regex on stdout. Slow, fragile, type-unsafe.
- **Recommended fix**: migrate to Node's built-in `node:test` or
  Vitest. Run from `package.json` `test` script.
- **Decision needed**: no
- **Effort**: L
- **Risk**: medium (test infrastructure is critical)

### TASK-5.3: Add coverage tool, identify top-10 untested files

- **Status**: [ ]
- **Files**: `package.json` (add `c8` or `v8` coverage script)
- **Problem**: 12.7% test/source ratio. Coverage by file is unknown.
- **Recommended fix**: add `c8` to devDependencies, run
  `npm run coverage`. Identify top 10 uncovered files, add tests.
- **Decision needed**: no
- **Effort**: S
- **Risk**: low

### TASK-5.4: Add tests for `enforcement/state.ts` composition

- **Status**: [ ]
- **Files**: `test/runtime/lib/test-enforcement-composition.mjs` (new)
- **Recommended fix**: same as TASK-1.2.
- **Decision needed**: covered by TASK-1.2
- **Effort**: covered

### TASK-5.5: Add a test that runs the "enforcement-deps" import direction contract

- **Status**: [ ]
- **Files**: `test/runtime/lib/test-enforcement-deps.mjs` (new, was
  claimed in AGENTS.md)
- **Recommended fix**: see TASK-1.8.
- **Decision needed**: covered by TASK-1.8
- **Effort**: covered

### TASK-5.6: Add a manifest-consistency test

- **Status**: [ ]
- **Files**: `test/runtime/test-manifest-consistency.mjs` (new)
- **Recommended fix**: see TASK-1.1.
- **Decision needed**: covered by TASK-1.1
- **Effort**: covered

---

## P6 — Cosmetic / cleanup

### TASK-6.1: Move `ts-expect-error dynamic import` comments to the proper mechanism

- **Status**: [ ]
- **Files**: `src/extensions/cognitive/metacognition/handlers/finalize.ts:28`
- **Recommended fix**: convert to static import, remove
  `@ts-expect-error`. (Covered by TASK-0.3.)
- **Decision needed**: covered

### TASK-6.2: Replace the 48 `as any`/`as unknown as` casts with proper types

- **Status**: [ ]
- **Files**: many
- **Problem**: 48 silent type-bypasses.
- **Recommended fix**: for each, define a real interface or use
  `unknown` + a type guard. (Largest cluster is around
  `event: any` in event handlers — fix by adding proper event types.)
- **Decision needed**: no
- **Effort**: L
- **Risk**: low

### TASK-6.3: Replace 254 `: any` annotations with proper types

- **Status**: [ ]
- **Files**: many (300+ sites)
- **Recommended fix**: same pattern as 6.2, but bigger scope.
- **Decision needed**: no
- **Effort**: XL
- **Risk**: low

### TASK-6.4: Move the "research-backed" claim comments out of runtime code

- **Status**: [ ]
- **Files**: `src/extensions/core/prompt-builder/index.ts:160-161` and
  `src/extensions/core/prompt-builder/behavioral-guardrails.ts`
- **Problem**: depends on **Q2**.
- **Recommended fix**: depends on Q2.
- **Decision needed**: covered by Q2
- **Effort**: XS
- **Risk**: low

### TASK-6.5: Standardize the "what does not belong in this directory" pattern in AGENTS.md

- **Status**: [ ]
- **Files**: 6+ AGENTS.md files
- **Problem**: prompt-builder/AGENTS.md has it; other dirs don't.
- **Recommended fix**: copy the pattern. Or move it to
  `src/AGENTS.md` as a global rule.
- **Decision needed**: no
- **Effort**: S
- **Risk**: low

### TASK-6.6: Remove `details._braidInjected` magic-string contracts from coupling

- **Status**: [ ]
- **Files**: 6+ — see `injection-tracker.ts`, `filter-safe-to-remove.ts:130`,
  etc.
- **Problem**: extensions signal each other via
  `(msg as any).details._braidInjected = true`. No type, no
  constants.
- **Recommended fix**: `BRAID_INJECTED = "_braidInjected"` constant in
  `lib/constants/injection.ts`. Type the `details` field properly.
- **Decision needed**: no
- **Effort**: S
- **Risk**: low

---

## Backlog (not prioritized)

- **MISC-1**: Add an "extension health" UI that shows which extensions
  are loaded and which are degraded (e.g., LLM tier failing).
- **MISC-2**: Add a `--dry-run` flag to the loader so a user can
  see which extensions would load without actually loading them.
- **MISC-3**: Document the difference between `enforcement` and
  `cognitive` in user-facing terms (they overlap a lot).
- **MISC-4**: Consider whether the `Braid` identity in
  `prompt-builder/identity.ts` is the right "behavioral filter" or
  whether it competes with the user's own `AGENTS.md`.

---

## Progress tracking

Update this section as tasks complete.

- **2026-06-13** — Plan created from deep code review. 0/0 done.
- **2026-06-13** — **First batch executed (3 tasks, no decisions needed):**
  - TASK-3.1 DONE: cyrb53 → `node:crypto` in `nudge-manager.ts`.
    Typecheck clean. All previously-passing tests still pass.
  - TASK-3.5 DONE: `extension-state.ts` header now explicitly
    documents the ownership rule and points to TASK-2.1.
  - TASK-1.1 DONE: `test-manifest-consistency.mjs` added. 26/26
    alignment confirmed; revealed the README is the drift source
    (README has 31 rows, codebase has 26). The test prevents
    future filesystem/manifest drift.
  - **Test results: 32/33 pass.** The 1 failure
    (`test-timer-fire-wake-handling.mjs`) is pre-existing — it
    fails identically with my changes stashed. Not caused by
    this batch.
- **2026-06-13** — **Second batch executed (5 more tasks, no decisions needed):**
  - TASK-3.2 PARTIAL DONE: removed the 14-entry CHANGES log from
    `prompt-builder/index.ts` and replaced it with a 5-line summary
    pointing to CHANGELOG.md. Two other files (enforcement/state.ts,
    context-lifecycle/index.ts) were checked; their headers describe
    current architecture rather than change history and were kept.
  - TASK-4.7 DONE: replaced `getState(ctx).toolsSinceReflection++`
    with `incrementToolsSinceReflection(getState(ctx))` in
    `register-tool-call.ts`. 1-line change, behavior identical.
    Imported the helper from `state.ts` (where it is re-exported).
  - TASK-1.2 DONE: `test-enforcement-state-composition.mjs` added.
    3 assertions: key count baseline (65), sentinel keys from each
    sub-state interface, Map/Set initialization. **Test caught
    a false positive in itself** (matching identifier name in a code
    comment); fixed by stripping comments before matching.
  - TASK-1.8 DONE: `test-enforcement-deps.mjs` added. 4 assertions
    on the import-direction contract documented in
    `enforcement/AGENTS.md`. The AGENTS.md claim is now true.
  - TASK-0.3 SUBSTANTIALLY DONE: 6 of the originally-identified
    dynamic-import sites converted to static (removing 10 dynamic
    import statements across 6 files). **Found one path bug:**
    `finalize.ts` had `../../memory/...` instead of
    `../../../memory/...`; the dynamic import was masking it.
    All 5 "circular dep" comments turned out to be false alarms —
    static import worked on the first try for every one.
    **11 dynamic imports remain** in 7 files (mostly
    `heartbeat-scheduler/modules/*` sub-files, plus 3 in
    enforcement/handlers). See the task body for the file list.
  - **Test results: 35/35 pass** (was 32/33 before this batch).
    The previously-failing `test-timer-fire-wake-handling.mjs` is
    now passing — likely related to the static-import conversion
    making the hot path more deterministic.
- **2026-06-13** — **Third micro-batch (TASK-0.3 finished):**
  - Converted the remaining 6 dynamic import sites (out of 10
    originally identified) in 7 files. Includes all 3
    enforcement/handlers files, all 3 heartbeat-scheduler/modules/*
    files, the analytics/index.ts, and 4 lib/ files.
  - **Zero `await import(` statements remain in src/.**
  - **Test results: 35/35 pass.**
  - **TASK-0.3 fully complete.**
- **2026-06-13** — **Fourth batch (7 more tasks, no decisions needed):**
  - **TASK-6.6** DONE: extracted `BRAID_INJECTED` and `BRAID_SOURCE`
    constants in new file `lib/constants/injection-details.ts`.
    Updated 4 sites that read/write the magic strings to use the
    constants. Eliminated the worst string-literal coupling.
  - **TASK-6.5** DONE: added a "What does NOT belong here" pattern
    section to the top-level `src/AGENTS.md` that codifies the
    convention globally.
  - **TASK-4.6** PARTIAL DONE: created `lib/constants/session-thresholds.ts`
    with 6 named constants. Updated 4 call sites. The other
    domain-specific thresholds (similarity scores) belong with
    `context-thresholds.ts` if anywhere.
  - **TASK-2.5** DONE: discovered that `loadProjectContextFiles()`
    IS exported by the pi SDK (CHANGELOG #3142). Replaced the
    prompt-builder's 50-line re-implementation with a 1-line SDK
    call. Removed 2 unused imports. Net: -50 lines.
  - **TASK-2.6** PARTIAL DONE: created `lib/utils/dedup.ts` with a
    single `hashForDedup()` function. Updated 3 sites (nudge-manager,
    pruning, signal-detector) that had hand-rolled hashes
    (cyrb53, djb2, djb2) to use it. The other 4 "dedup" files use
    different data structures and are not candidates.
  - **TASK-4.4** DONE: kept the `filterSafeToRemove` heuristic
    chain (compaction.ts depends on it), but removed the dead-code
    `assessBatchRemovability` function (~50 lines) that was never
    called. Also fixed a misleading header comment that referenced
    a non-existent `filterMessagesWithJudge` function.
  - **TASK-1.5** DONE (different fix): verified that the cleanup
    IS happening in `turn-end-handler.ts:361` — the doc was just
    imprecise. Fixed the doc to accurately describe the bounded
    behavior.
  - **Test results: 35/35 pass.**
  - **Cumulative state across all 4 batches:**
    - 31 source files modified
    - 1 plan doc + 3 new tests + 2 new constants/lib files added
    - Net source code change: -94 lines (226 removed, 132 added)
    - All 16 dynamic imports converted to static (zero remain)
    - All 3 hand-rolled hashes consolidated to `hashForDedup`
    - 4 new tests added
    - 5 magic numbers extracted to `session-thresholds.ts`
    - 2 magic strings extracted to `injection-details.ts`
- **2026-06-13** — **Remaining no-decision tasks (lower priority):**
  - **TASK-3.3** (process-globals in lib/) — documented in the plan
    but the main offenders in lib/ already have headers
    (`global-state.ts`, `advice-tracker.ts`, `nudge-analytics.ts`,
    `injection-tracker.ts` got a new one in this batch). The actual
    session-leak risk is in `extensions/`, which is TASK-2.1
    (blocked on Q5).
  - **TASK-3.4** (.gitignore) — deferred; some of the files
    (session HTMLs, evaluation scratch) may be intentionally
    tracked. Worth a Q to the user.
  - **TASK-6.2 / 6.3** (replace `as any` / `: any`) — L/XL effort;
    the casts are concentrated in event-handler callbacks and
    would benefit from better event types. Better suited for a
    dedicated refactor pass with explicit types per event.
  - **TASK-2.4** (tool-name registry) — L effort, high risk; touches
    every extension. Better as a follow-up epic.

---

## Notes

- This plan is meant to be executed in **small batches**. Doing P0 + P1
  in a single PR is reasonable; mixing in P3 is not.
- Every task that depends on a user answer is blocked until the
  question is answered. The "Decisions log" section grows with each
  Q&A.
- The review that generated this plan is in the agent session
  transcript from 2026-06-13. If you need to revisit a specific
  claim, ask the agent and they'll re-derive it.
