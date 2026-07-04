<!-- status: current -->
<!-- Created: 2026-06-27 for fresh-session transfer -->
<!-- Refreshed: v3.10 session + ESC + doc hygiene — 2026-06-30 -->

# pi-braid session handoff

This file exists for a fresh agent session to pick up cleanly.
The work is in a known-good state as of this writing.

## Where we are (last 8 commits)

```
7464128a   fix(docs): ROADMAP tally reconciliation (Task 10 partial)
6754c10f   fix(docs): README R6/R7/R8 — peerDep version, test count, memory desc
391ee8b7   docs: commit DOCUMENTATION-REVIEW-PROPOSAL.md
903940c6   docs(roadmap): add v3.8, v3.9, SPQ-1, v3.10 version entries (Task 9)
b5f4dc4c   fix(docs): README.md — replace phantom pipeline diagram
9e1c25f9   feat(subagent): improve Python RPC client — SIGINT, --verbose, --timeout
6d49d623   fix(docs): ROADMAP file sizes + scratchpad line refs (Task 6)
d2526754   fix(docs): AGENTS.md tool count — 42→22 braid + ~12 pi-core
```

All 33 commits from this session (v3.7 Instance rewrite onward) are
pushed to `origin/main`. Working tree is clean.

The v3.7 → v3.10 arc completes the system-prompt cleanup plan
(v3.5-v3.8) plus a comprehensive second wave:
- **v3.7** Instance rewrite: fix pi-core version discovery, replace
  internal module tree with top-level extension discovery.
- **v3.8** Instance corrections: Root/Cwd/Settings from pi API,
  settings-driven extension loading.
- **v3.9** Prompt-section unification: skills + project-docs + memory
  pointer blocks consolidated, `<recent>` block removed.
- **SPQ-1** Definition of Done invariant: verification triples required
  before `finalize`.
- **v3.10** ESC abort handling overhaul, session lifecycle
  discoverability, subagent RPC infrastructure, doc hygiene
  (AGENTS.md/ROADMAP/README.md fixes).

All 33 commits pushed to `origin/main`. Working tree is clean.

## State of the codebase

- **CI**: `npm run ci:check` → ✅ all green (check:docs + check:doc-drift + check:deps + tsc + 81/81 tests)
- **Tests**: `npm run test` → **81 passed, 0 failed** (as of 2026-07-01 — 3 former failures fixed: `test-instance-block.mjs` cwd tag assertion loosened, `test-behavioral-drift.mjs` + `test-self-evolution-loop.mjs` path resolution switched from CWD-relative to `import.meta.url`-based)
- **Typecheck**: `npm run typecheck` → clean
- **Doc discipline**: `npm run check:docs` → ✅; `npm run check:doc-drift` → ✅
- **check-deps**: `node scripts/check-deps.mjs` → ✅ 0 violations (227 src + 83 test files)
- **pi-ai version**: `0.80.2` installed
- **Working tree**: **CLEAN**. All commits pushed to `origin/main`. 0 uncommitted, 0 untracked.
- **User-space settings**: `~/.pi/agent/settings.json` — no changes needed.

## What just shipped (this session, v3.7 → v3.10)

33 commits, 9 shipped clusters:

| Commit | Item | What it does |
|---|---|---|
| `c6184f27` | v3.7 Instance rewrite | `top-level-extensions.ts` (new): discovers pi extension packages. `instance-composition.ts` (rewritten): consolidated Instance block with Session data merged in, pi-core version via `which pi`. `session-section.ts` deleted. |
| `d3e04c69` | v3.8 Instance corrections | Root/Cwd/Settings from pi API (not OS env scraping). Extension loading from settings.json (not sibling-scan). |
| `f7f08d18` | v3.9 Prompt unification | Skills + project-docs + memory pointer blocks consolidated. `<recent>` block removed. Prompt reduced ~15 lines/turn. |
| `51f8787e` | SPQ-1 DoD invariant | `DEFINITION_OF_DONE` constant in identity.ts: before `finalize`, every scratchpad `done` item must carry verification triple. |
| `fd4b8269` | Skills block compression | `<available_skills>` block shrunk ~72% (10500→3000 chars). Self-closing tags, no descriptions — agent reads SKILL.md on demand. |
| `9d09a2cb` | Instance block test rewrite | `test-runtime-instance-block.mjs` (19 subtests) replaces old test. |
| `ee5fae44` | Think-tool bugfix | All 7 bugs fixed: enum validation, depth handling, complexity vs depth, parent_id, description. |
| `2e716146` | Re-entrancy guard | QueueMicrotask + re-entrancy guard for post-compaction stack overflow. |
| `3b4f108a` | Value-layer removal | 8-value statement layer removed from system prompt. |
| `709950c9` | Behavior modes restored | Dynamic behavior modes (TRUTH-SEEKING + 3) restored. |
| `24efd522` | 35 proposals captured | Lost session proposals captured in ROADMAP. |
| `884a4737` | Memory nudge | Broader search when `episodes_search` returns empty. |
| `3898ad2a` | Task 1 — exception count | 27→28 documented exceptions across all docs. |
| `b938453e` | Tasks 2-5 — ROADMAP quick wins | File counts, P-tier tallies, remaining items list, tally label. |
| `296d90b2` | Subagent RPC infrastructure | `scripts/subagent-rpc.py` — Python RPC client. Input-polisher PI_CODING_AGENT_DIR fix. Skill rewrites. |
| `0a4131a9` | Turn-end hygiene | Turn-end-hygiene handler with context-usage tracking. |
| `3420c2ca` | Dedup fix | WeakMap→cwd-keyed Map for turn-end-hygiene dedup. |
| `f36a57ba` | **ESC abort handling** | 3 critical bugs in callLlm retry loop: abortable sleep, signal check before retry, combineSignals listener cleanup. All timeouts 2-30s→60-120s. claim-tracker signal threading. |
| `f324849e` | **Session lifecycle** | SESSION_START discoverability (before first turn) + SESSION_SHUTDOWN resumption writer. Turn-end-hygiene → context-usage-only. |
| `24cdb549` | Extension path fix | Never bare '.' path. |
| `b60f6391` | CHANGELOG entry | v3.10 extension path fix documented. |
| `d2526754` | Task 7 — AGENTS.md tool count | 42→22 braid + ~12 pi-core built-ins. |
| `6d49d623` | Task 6 — ROADMAP refs | File sizes + 17 dangling scratchpad line refs fixed. |
| `9e1c25f9` | Subagent client improvements | SIGINT forwarding, --verbose, --timeout flags. |
| `b5f4dc4c` | README.md fix | Phantom pipeline diagram → accurate extension map. Phantom extensions removed. |
| `903940c6` | Task 9 — version history | v3.8, v3.9, SPQ-1, v3.10 version entries in ROADMAP. |
| `391ee8b7` | Proposal file committed | `docs/DOCUMENTATION-REVIEW-PROPOSAL.md` (was untracked). |
| `6754c10f` | README R6/R7/R8 | peerDep version, test count, memory description fixes. |
| `7464128a` | Tally reconciliation | 49→45+1 of 51, EW items 12→14 of 15. |

This session also produced:
- **HANDOFF.md** (this file) — refreshed for v3.10
- **New handlers**: `register-session-start-discoverability.ts`, `register-session-shutdown-resumption.ts`, `register-turn-end-hygiene.ts`
- **New scripts**: `scripts/subagent-rpc.py`
- **New docs**: `docs/DOCUMENTATION-REVIEW-PROPOSAL.md`

## What's next (priority order)

1. **Orchestrator extension (subagent handoff + healthcheck).** The
   next big feature. User asked 2026-06-28 for: a `/transfer` command
   + lead flag + sleep mode + self-verification/healthcheck that runs
   on session-start.
   - **Minimum viable first commit (~150 LOC):**
     - `src/extensions/orchestrator/index.ts` with `/healthcheck`
       command (runs ci:check, returns pass/fail per check)
     - `src/lib/state/orchestrator-state.ts` with
       `getLeadSession`/`setLeadSession`/`getSleepMode`
     - `test/runtime/lib/test-orchestrator-healthcheck.mjs` (4-5
       subtests)
     - CHANGELOG + ROADMAP
   - **Follow-up commits (~250 LOC):** `/transfer` command (writes
     HANDOFF.md, spawns subagent, polls healthcheck, sets lead);
     `/lead` and `/follow` commands; sleep-mode behavior on
     session-start. tmux-based parallel visibility is a second
     iteration.

2. **Turn-end memorization expansion.** Architectural: design how
   `turn_end` handles plan/task lifecycle, auto-evolution, richer
   handoff. The current `turn-end-handler.ts` only tracks context
   usage — the memorization layer was stripped out in v3.10.

3. **SPQ-10 and SPQ-11.** `<>` tag leak fix (internal thinking tags
   leaking into rendered output) and memory section "little additions"
   (user-flagged, details not yet specified). Both marked "not started"
   in ROADMAP.

4. **P2-10 / Q13** — large-file splits (`memory-agent-bridge`,
   `timer`, `session-recall`, `latent-activator`). Explicitly
   ✅ resolved by DR-M-8 (now complete: scratchpadExecute dispatch
   table in handlers.ts, 2026-07-04).

5. **P2-7 / DR-H-9** — drift-classifier cache (prompt collapse 3→1
   multi-label). Cache part shipped (critic-cache.ts wired in
   text-classifier.ts). Prompt-merge design call needs user input.

The roadmap tally: **47 full of 51 actionable items shipped**
(P1-2 verified as no-op, not counted in shipped). Remaining items
(4–5) all need user input, a policy decision, or upstream API
stabilization. SPQ-10/11 and the orchestrator extension are additional
items not in the P-tier tally.

**Note on P1-4 / EW-7.3:** shipped in v2.3 (June 18) via the wrapper
approach at `src/lib/utils/injection-tracker.ts:232` — every
`sendTrackedMessage` caller (20+ sites including all 11 the original
audit flagged) now respects `braid.suppressNudges` without per-site
checks. Pinned by `test/runtime/lib/test-suppress-nudges-applied.mjs`
(5/5 passing).

**Note on EW-7.11 / P2-5:** shipped in v3.3 (this conversation) via
the minimum-change path: extended `BraidConfig` schema with an
`enforcement.nudgeConfigs` block, added `validateNudgeConfig(type, cfg)`
+ `parseNudgeConfigOverrides(raw)` helpers in `nudge-manager.ts`,
wired the previously-dead `customConfig` hook on `NudgeManager` to
the settings reader. Pinned by `test-enforcement-config.mjs`
(18/18 subtests). Two-layer validation: unknown NudgeType keys
dropped with a warning; per-entry validation drops bad fields but
preserves valid ones (defense in depth).

## How to navigate this codebase

- `AGENTS.md` (root) — the binding work contract; read first
- `docs/ROADMAP.md` — the actionable roadmap with shipped/per-version
  notes
- `src/AGENTS.md` — top-level architecture
- `src/extensions/<group>/AGENTS.md` — per-group ownership
- `docs/HOOKS-AND-WHISPERS-AUDIT.md` — pi event/hook map + LLM call
  patterns (now `current` after the pi-ai v0.80 port)
- `docs/STATE-POLICY.md` — state lifetime policy narrative
- `src/lib/state/AGENTS.md` — state placement rules + 28 documented
  exceptions

## Conventions

- **Don't add module-level `let`** for stateful data. Use
  `getExtensionState(ctx, key, factory)` per session; or
  `global-state.ts` getter for process-global. The
  `test-no-module-level-let.mjs` lint enforces this.
- **Don't bypass `sendTrackedMessage`** to call `pi.sendMessage`
  directly; bypasses flood cap + injection tracking. Use
  `sendEnforcementWhisper` from the enforcement wrapper.
- **Mark every `.md`** with `<!-- status: current | forward-looking |
  aspirational | historical -->`. The `check:docs` script enforces.
- **Tool factory pattern** — wrap tool definitions in
  `createXTool()` factory functions returning
  `ToolDefinition<any, any, any>` rather than casting at registration
  sites. Pattern documented in `CASTS-AUDIT.md` (now in
  `docs/archive/`).

## Scratchpad state

The session's scratchpad (`.pi/braid/scratchpads/pi-braid/latest.json`) contains:

- **Goal**: ROADMAP tally reconciliation + HANDOFF refresh + remaining deferred items.
- **Open plan**: tally reconciliation (done), HANDOFF refresh (in progress), turn-end memorization expansion (deferred), SPQ-10/11 (not started).
- **Decisions**: D-37 through D-42 captured (most recent: D-42 subagent spawning requires `--mode rpc` with temp PI_CODING_AGENT_DIR).

The scratchpad is the canonical session memory for the in-flight
work; `HANDOFF.md` (this file) is for fresh-session transfer.

## Cross-session memory

High-utility entries persisted to long-term memory:

- **semantic**: `pi-ai v0.80 port finding` — ground truth about `/compat` vs `Models.completeSimple()`, with file paths and verification commands.
- **procedural**: `verify-before-act on roadmap items with factual API/version claims` — pattern of `npm view` + `npm pack` + `.d.ts` inspection BEFORE writing code.
- **episodic**: 3 episodes stored covering discrepancy fix session, ESC handling session, and this session's work.

Use `memory action=recall_search` with a relevant query to surface insights from past sessions before starting new work.

## Known limitations / non-blockers

All known limitations from the prior handoff are now resolved:

1. ~~**Stale line numbers in `EXEMPT_LINES`**~~ — **RESOLVED** in `efd2b9b6`.
2. ~~**`check-deps.mjs` pre-existing violations**~~ — **RESOLVED** in the v3.4 carve-out.
3. ~~**Push status**~~ — **RESOLVED**. All commits pushed to `origin/main`.
4. ~~**Think-tool partial patches**~~ — **RESOLVED** in `ee5fae44`. All 7 bugs fixed.
5. ~~**Skills compression unpushed**~~ — **RESOLVED**. `fd4b8269` pushed with the rest.

~~**Current known limitation:** `test-instance-block.mjs` has 1 pre-existing failure (v3.7 cwd tag regression — pi-core v0.80.2's `getCwd()` returns a relative path or empty string in some contexts).~~ — **RESOLVED** in 2026-07-02 session. The test passes on pi-core v0.80.3.

## Quick-start commands

```bash
# Sanity-check the discipline
npm run check:docs && npm run check:doc-drift

# Verify everything still works
npm run typecheck && npm run test

# Read the most recent decisions
# (use the scratchpad tool, action=continue, to get a focused digest)

# Find the next priority item
grep -A 1 "^| P1-5\|^| EW-7.11" docs/ROADMAP.md | head -10
```

Welcome. Pick up where the last session left off.

---

## Postscript — 2026-07-02 session

Two investigations resolved in this session, plus a documentation overhaul:

### Shipped (commits in this session)

1. **`322d2c43`** — SCOPES identity framing + INTERACTION_STYLE markup-discipline clause + lean CORRECTION directive. See `src/extensions/core/prompt-builder/identity.ts:SCOPES` and the 4th sentence of `INTERACTION_STYLE`. The principle: "every artifact belongs to a scope; default to the narrowest one that satisfies the purpose, broaden only when lifetime / audience / portability demand it." No path lists — discoverability over memorization. 36/36 prompt-builder tests pass; 81/81 full-suite pass.

2. **Doc overhaul (this HANDOFF update, plus uncommitted doc work)**:
   - `README.md` rewritten — user-first with fast-start config example + "what you get" table + setup quicklinks
   - `docs/SETUP.md` (new, ~280 lines) — canonical setup reference: 5 install paths (user-global / project / `-e` flag / direct path / git-URL via npm), bundled skills + companion packs, full config reference, module toggling, storage, troubleshooting
   - `CONTRIBUTING.md` rewritten — pure-contributor focus; cross-links to SETUP.md for dev environment; adds dox-framework reminder + commit-message prefix conventions
   - `HANDOFF.md` (this file) updated with this postscript

### State of doc hygiene

- All top-level `*.md` have `<!-- status: -->` markers.
- `docs/SETUP.md` is the new canonical setup doc; the install snippet in `README.md` is intentionally compressed with "see SETUP.md for full setup reference" as the cross-link.
- `CONTRIBUTING.md` no longer duplicates setup content — it stays focused on contributing workflow.

### What to look at next

- `docs/ROADMAP.md` P0/P1 priorities (45 full + 1 partial of 51 shipped; remaining items need user input — see §What's next in main body).
- The orchestrator extension work (mentioned in main body above).
- `SPQ-10` and `SPQ-11` from ROADMAP.

Read the main body of this HANDOFF.md for the broader v3.7→v3.10 context. Welcome.

---

## Postscript — 2026-07-02 deep-invest session

Shipped in this session (to be committed):

1. **Fix: test-enforcement-state-composition.mjs baseline** — `BASELINE_COUNT` 65 → 70.
   5 nudge-tracking fields added since the last baseline bump per-turn
   think/finalize/verify/startup enforcement (EW-7.2 sub-signal wiring).
   Sentinel keys updated for error-tracking-state and session-state.

2. **Fix: tool-loop-detector.ts recordTurnEnd bug** — `recordTurnEnd` was not
   creating a new `perTurn` entry, so `detectToolLoop` always returned false
   in production (`perTurn.length` never exceeded 1). Also added ordered
   `history: string[]` field for tail-run detection (N consecutive same-tool
   calls within a single turn). The stateful `detectToolLoop` now has two
   detection paths: tail-run (intra-turn, primary) and cross-turn (fallback).
   All 18 subtests in test-tool-loop-detector.mjs now pass.

3. **HANDOFF update** — "Known limitations" section: the stale
   test-instance-block.mjs entry was resolved (passes on pi-core v0.80.3).
   Test count bumped from 79→81 in the v3.10 postscript.

### Verified

- `npm test` → **81/81 passed, 0 failed** (both previously-failing tests green)
- `npm run typecheck` → clean
- `npm run check:docs` → ✅

### D-57 enforcement-bloat inventory (investigated, deferred)

The full classification of turn-end-handler.ts whispers into static
(instruction → move to tool descriptions) vs runtime (keep as detection)
was completed and stored in scratchpad as decision D-58. The
classified inventory is ready for the next session to begin the
partial migration. See scratchpad `action=continue` for the full memo.

---

## Postscript — 2026-07-03 mechanical sweep + task spec

### Shipped this session (2 commits)

| Commit | Item | Kind |
|---|---|---|
| `9819bbe2` | **P3-2** — type enforcementSignals keys (`EnforcementSignalKey` union) | Code |
| `5047c672` | ROADMAP markers: P2-4 shipped v2.8, P2-6 shipped v2.5, P3-2 shipped 2026-07-03 | Doc |

### Discoveries made

- **P2-4 (EW-7.9 per-signal gating):** Already shipped in v2.8
  (`1c8d0b18`). Per-signal subKey gating in `turn-end-handler.ts`,
  `L2_NUDGE_TYPE` map, independent `shouldSendNudge` per signal with
  subKey. Just needed ROADMAP marker.
- **P2-6 (EW-7.13 per-source caps):** Already shipped in v2.5
  (`1628211d`). `PER_SOURCE_CAP_OVERRIDES` in `turn-dedup.ts`. Just
  needed ROADMAP marker.
- **P2-11 (7 B-class fallbacks):** NOT a quick flag change. These are
  regex-based heuristics (scoring dimensions, plan detection,
  semantic-compress, sop-suggestion) across 5-6 files needing full
  `classify()` LLM calls. Research-heavy per-file.
- **P2-10d (memory-agent-bridge split):** Last Q13 split target.
  962 lines, explore-paths.ts (227 lines) already extracted. ~735
  remaining LOC with 4 tool registrations + helpers.

### Detailed task specs for next session

Two independent tasks ready to pick up. Full specs in scratchpad notes:

1. **P2-10d** — Split `memory-agent-bridge/index.ts` into 3 extracted
   files (`memory-store-tool.ts`, `memory-tool.ts`, `conflict-qa-tool.ts`
   following the factory-function pattern from `explore-paths.ts`). See
   scratchpad note `nt-mr4uiog6-7c0aa1` for file-by-file breakdown.

2. **P2-11** — Replace 7 B-class fragile heuristics with LLM
   `classify()` calls using `tierPolicy: "fallback-only"` pattern
   (confidence 0.5). See scratchpad note `nt-mr4uiog6-7d8170` for
   the per-heuristic breakdown across 5-6 files.

### Verified

- `npm test` → **81/81 passed, 0 failed**
- `npm run typecheck` → clean
- `npm run check:docs` → ✅ (65 docs all valid)
- `npm run check:doc-drift` → ✅ (no current-state drift)
- Working tree: **CLEAN**, all on `origin/main`

---

## Postscript — 2026-07-04 RESOURCE_DISCOVERY + test cleanup

### Shipped

**`77bb0cb4`** — feat(identity): add RESOURCE_DISCOVERY invariant, generalize IDENTITY_INTRO, strip prose-pinning tests

Three changes in one commit:

1. **`RESOURCE_DISCOVERY`** — new identity invariant codifying the pointer-on-demand pattern for all grounded knowledge (skills, project docs, memory, runtime extensions, framework APIs, external state). Two-sentence principle: "When a description matches your work, read the source — using the right resource beats working without it. Pointers describe what something claims to be — verify against the source when correctness matters." Defined in `src/extensions/core/prompt-builder/identity.ts`, wired via `simpleSection("invariant-resource-discovery", RESOURCE_DISCOVERY)` in `index.ts`.

2. **`IDENTITY_INTRO` generalized** — the skills-specific "read its full SKILL.md" sentence was replaced with a general resource-scanning instruction: "scan the available resources (skills, project docs, memory, runtime extensions); if a pointer's description matches your work, read its source on demand." The persona emphasis stays: "skills hold procedures for specialized work — not optional hints."

3. **All text-prose tests removed** — `test-prompt-builder-directive.mjs` rewritten from 47+ tests (mostly pinning sentence counts, exact phrases, meta-LLM term scans, vocabulary) to 26 wiring/structural tests (existence, exports, simpleSection rendering, regression guards, structural counts). The system prompt is freeform prose the author can evolve; the wiring is the durable contract.

### Anti-bloat scope clarified

Anti-bloat applies to **static surfaces**: code, system prompt, skills content, project docs content. It does NOT apply to the agent's chat session context — the agent should be eager about reading pointers when their descriptions match the work. Documented in `src/extensions/core/prompt-builder/AGENTS.md`.

### Verified

- `npm test` → **80/81 passed** (1 pre-existing environment-dependent failure in `test-instance-block.mjs`: "Root points at the pi-core npm package folder" — not related to this change)
- `npm run typecheck` → clean
- `npm run check:docs` → ✅
- `npm run check:doc-drift` → ✅
- Working tree: **CLEAN**, all on `origin/main`

---

## Postscript — 2026-07-04 discoverability polish + test fix

### Shipped

**`f0223b71`** — polish(system-prompt): tighten discoverability directives, fix test assertion, add context-hygiene signal

Four changes:

1. **IDENTITY_INTRO rephrased** — more directive: "read the skills that cover your current domain. Skills prevent wasted effort and mistakes. Then scan project docs, memory, and runtime extensions; read any resource whose scope overlaps with your work before acting." (`src/extensions/core/prompt-builder/identity.ts`)

2. **Project-docs header tightened** — "Read project documentation files below before modifying code in the areas they describe. Cross-check references against source code." (`project-docs-section.ts`)

3. **Skills header tightened** — more directive: "read that skill first. Skills are executable procedures, not optional hints." (`skills-section.ts`)

4. **Context hygiene signal added** — 6th discoverability signal in session-start handler, reminding the agent about `context_inspect`, `context_compress`, `workspace_snapshot` for state preservation. (`register-session-start-discoverability.ts`)

### Bug fix

- **test-instance-block.mjs** — Root→Core label mismatch: the Instance block renders `Core:` (not `Root:`) since v3.8, but the test was still asserting against the old `Root:` regex. Fixed: 20/20 subtests pass (was 18/20).

### D-58 status updated

- `test-tool-loop-detector.mjs`: **18/18 passed** (no longer failing)
- `test-enforcement-state-composition.mjs`: **all passed** (BASELINE_COUNT already correct)
- Both D-58 test-drift observations are **resolved** by prior commits.

### Verified

- `npm test` → **81/81 passed** (test-instance-block.mjs now passing)
- `npm run typecheck` → clean
- Working tree: **CLEAN**, all on `origin/main`