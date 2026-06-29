<!-- status: current -->
<!-- Created: 2026-06-27 for fresh-session transfer -->
<!-- Refreshed for v3.6 (L1 split) — 2026-06-29 -->

# pi-braid session handoff

This file exists for a fresh agent session to pick up cleanly.
The work is in a known-good state as of this writing.

## Where we are (last 6 commits)

```
<new>      refactor(prompt-builder): split L1 into Session + Context blocks (v3.6)
f47ddea6   docs(handoff): refresh for v3.5 - Instance block + contrib filter + browser disable
001ddc8c   fix(loader): tool provenance via Proxy wrapper, not getAllTools diff
bbf70c12   feat(prompt-builder): Instance block v3.5 - module paths + discovery note
43231798   feat(prompt-builder): external tools group + contrib settings.json filter (v3.5 cont.)
111b12d8   feat(prompt-builder): Instance composition block + tool provenance (v3.5)
```

The v3.5 → v3.6 transfer is in flight (v3.5 already pushed;
v3.6 will be 1 new commit). Push the v3.6 commit when ready.

v3.5 + v3.6 together complete the system-prompt cleanup plan:
- **v3.5** ships the `## Instance` block at the top of every system
  prompt (agent identity, env, extension tree) + tool provenance
  + contrib settings.json filter.
- **v3.6** completes the L1 split: `## Session` (volatile: PID,
  session time, turns, last event, tool avg) and `## Context`
  (conditional: context %, session health, memory count, checkpoint
  awareness) replace the monolithic `l1-environment.ts`.

## State of the codebase

- **CI**: `npm run ci:check` → ✅ all green (check:docs + check:doc-drift + check:deps + tsc + 81/81 tests)
- **Tests**: `npm run test` → **81/81 pass** (was 80; added test-l1-split.mjs with 11 subtests)
- **Typecheck**: `npm run typecheck` → clean
- **Doc discipline**: `npm run check:docs` → ✅; `npm run check:doc-drift` → ✅
- **check-deps**: `node scripts/check-deps.mjs` → ✅ 0 violations (228 src + 83 test files)
- **pi-ai version**: `0.80.2` installed
- **Working tree**: clean (v3.6 uncommitted; pi-braid-contrib has staged-but-uncommitted change to `index.ts` for the contrib filter)
- **User-space settings**: `~/.pi/agent/settings.json` now has `braid.contrib.browser: false`. The contrib package's `index.ts` reads this and skips loading the browser extension entirely. Re-enable by deleting the `braid.contrib` block.

## What just shipped (this conversation)

| Commit | Item | What it does |
|---|---|---|
| `<new>` | v3.6 L1 split | `src/extensions/core/prompt-builder/{session-section,context-section}.ts` (new). `l1-environment.ts` (deleted, 275 LOC). `agent-environment/index.ts` no longer exports `formatL1EnvironmentSection`. The L1 block is now two focused sections: `## Session` (volatile: PID, session time, turns, last event, tool avg — always shown) and `## Context` (conditional: context %, session health, memory count, steps since checkpoint — only shown when something to surface; returns `""` otherwise). Pinned by `test/runtime/lib/test-l1-split.mjs` (11 subtests). No consumer-visible behavior change. |
| `f47ddea6` | v3.5 HANDOFF | Pre-v3.6 HANDOFF refresh capturing post-push reality. |
| `001ddc8c` | v3.5 fix | `src/loader/loader.ts`: tool provenance now via a Proxy that wraps `pi.registerTool` per extension, instead of calling `pi.getAllTools()` during loading. The previous diff approach hit "Extension runtime not initialized" in pi-core (a regression introduced in 111b12d8); this restores `pi -a` to a clean start. |
| `bbf70c12` | v3.5 polish | `src/extensions/core/prompt-builder/instance-composition.ts`: per-extension indented entries → module-level lines with inline extension ids (1 line per module + module root path) + one-line discovery hint at the bottom pointing the agent at the read tool. Compact + discoverable. |
| `43231798` | v3.5 label fix | `src/extensions/core/prompt-builder/instance-composition.ts`: `coreTools` field → `externalTools` field. The label `pi-core: N built-in tool(s)` was misleading once pi-braid-contrib started showing up there; new label is `external: N tools (pi-core + contrib)`. |
| `111b12d8` | v3.5 foundation | New `## Instance` block at top of system prompt (concise: agent version, env, extension tree grouped by module with per-extension tool counts, totals). New `src/lib/state/tool-provenance.ts` records `toolName → extensionId`. Companion change in `pi-braid-contrib/index.ts` (sibling repo, staged-but-uncommitted) reads `braid.contrib.<name>` from `~/.pi/agent/settings.json` to skip disabled extensions. Browser now disabled. |
| (sibling) | contrib filter | `pi-braid-contrib/index.ts` (sibling repo, not in this commit) refactored to read `braid.contrib.<name>` from `~/.pi/agent/settings.json`. Default: enabled. To disable, set to `false`. Format: `{"braid": {"contrib": {"browser": false}}}`. The change is staged but not committed in contrib — user has other uncommitted work there. |

## What's next (priority order)

1. **Orchestrator extension (subagent handoff + healthcheck).** User
   asked 2026-06-28 for: a `/transfer` command + lead flag + sleep
   mode + self-verification/healthcheck that runs on session-start.
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
2. **Skill compression (commit 5 of v3.5 plan).** Skills section:
   drop `<description>`, add `hint:` frontmatter field (one-line
   "when to read this skill" cue). This is a separate migration
   that touches external skill files (~26 local skills + the
   skills-repo skills). Could ship as a single commit (frontmatter
   migration + skills-section.ts change) or as 3 commits (one for
   the skills-section.ts renderer change, one for the local skills,
   one for the skills-repo skills).
3. **P3-7 / EW-7.12** — prefix naming convention (policy decision;
   needs user input).
4. **P2-10 / Q13** — large-file splits (`memory-agent-bridge`,
   `timer`, `session-recall`, `latent-activator`). Explicitly
   deferred; trigger condition was partial-met by DR-M-8
   (scratchpadExecute split).
5. **P2-7 / DR-H-9** — drift-classifier cache (prompt collapse 3→1
   multi-label). Partially unblocked by v3.0 cost-report but the
   prompt-merge design call needs user input.

The roadmap tally: **49 of 51 actionable items shipped**. The 4
remaining items all need user input, a policy decision, or upstream
API stabilization. The next autonomous push (after this HANDOFF is
written) is likely none — `ci:check` is fully green, all known
limitations from the prior handoff are resolved, and the remaining
items are explicitly deferred awaiting decisions.

**Note on P1-4 / EW-7.3:** shipped in v2.3 (June 18) via the wrapper
approach at `src/lib/utils/injection-tracker.ts:232` — every
`sendTrackedMessage` caller (20+ sites including all 11 the original
audit flagged) now respects `braid.suppressNudges` without per-site
checks. Pinned by `test/runtime/lib/test-suppress-nudges-applied.mjs`
(5/5 passing). The HANDOFF priority list above does not include P1-4
because it is already shipped.

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

The session's scratchpad (`.pi/scratchpad/`) contains:

- **Goal**: P0-8 + P1-3 shipped; 47 of 51 roadmap items shipped.
- **Open plan (0 items)**: all planned items marked done.
- **Decisions**: D-37 through D-41 captured (most recent: D-41 P1-3
  scope decision).
- **Handoff notes**: pre-port (2026-06-23), post-port (2026-06-27),
  post-P1-3 (2026-06-27).

The scratchpad is the canonical session memory for the in-flight
work; `HANDOFF.md` (this file) is for fresh-session transfer.

## Cross-session memory

Two high-utility entries were persisted to long-term memory this
session:

- **semantic** `pi-ai v0.80 port finding` — the ground truth about
  `/compat` vs `Models.completeSimple()`, with file paths and
  verification commands.
- **procedural** `verify-before-act on roadmap items with factual
  API/version claims` — the pattern of `npm view` + `npm pack` +
  `.d.ts` inspection BEFORE writing code. Saved hours of
  wrong-direction work.

Use `memory recall_search` to retrieve; `memory_store` to persist
new findings.

## Known limitations / non-blockers

All three known limitations from the prior handoff are now resolved:

1. ~~**Stale line numbers in `EXEMPT_LINES`**~~ — **RESOLVED** in
   `efd2b9b6`. `_completeSimple` and `rateLimitCooldownUntil` line
   numbers in `test/runtime/lib/test-no-module-level-let.mjs` now
   match `src/lib/ai/llm-call.ts` (68 and 93 respectively).
2. ~~**`check-deps.mjs` pre-existing violations**~~ — **RESOLVED**
   in the v3.4 carve-out. 7 layer-boundary pairs added to
   `ALLOWED_BOUNDARY_OVERRIDES` (all real integration points with
   one-line justifications matching the existing 5-entry pattern);
   the 1 stale test ref (`test-context-lifecycle-state.mjs` pointing
   at `src/.js`) was the dead `INDEX_PATH` removed in `efd2b9b6`.
   `ci:check` is now fully green.
3. **Push status** — v3.4 commits are pushed to `origin/main`
   (as of 2026-06-27). `main` is in sync with upstream; the
   v3.3 → v3.4 transfer is durable. The next agent inherits
   the state described in this HANDOFF directly.

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