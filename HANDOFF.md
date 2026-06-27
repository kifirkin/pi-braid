<!-- status: current -->
<!-- Created: 2026-06-27 for fresh-session transfer -->

# pi-braid session handoff

This file exists for a fresh agent session to pick up cleanly.
The work is in a known-good state as of this writing.

## Where we are (last 4 commits)

```
64fb1a78 fix(file-mutation-queue): atomic write-temp-then-rename + race coverage
97419dfe feat(timer): DR-C-4 runtime check — factory call counter warns on assumption violation (P1-3)
84f27f4d feat(ai): port llm-call.ts to pi-ai v0.80 — compat import path (P0-8 Path A)
463bb690 docs(roadmap): correct P0-8 — pi-ai v0.80 minimum-change path is /compat, not stream refactor
2dfa827a feat(docs): doc discipline layer — status markers + drift gate (DR-NEW-DOC-DISCIPLINE)
```

23 unpushed commits on `main` ahead of origin/main.

## State of the codebase

- **Typecheck**: `npm run typecheck` → clean
- **Tests**: `npm run test` → **77/77 pass** (including the new
  `test-file-mutation-queue-race.mjs` at slot 37)
- **Doc discipline**: `npm run check:docs` → ✅ 58 in-scope docs have
  status markers; `npm run check:doc-drift` → ✅ No current-state drift
- **No-module-level-let**: `node test/runtime/lib/test-no-module-level-let.mjs`
  → ✅ 0 violations across 225 files (28 documented exceptions)
- **pi-ai version**: `0.80.2` installed; peerDep floor `>=0.80.0`
- **Working tree**: clean

## What just shipped (this conversation)

| Commit | Item | What it does |
|---|---|---|
| `2dfa827a` | DR-NEW-DOC-DISCIPLINE | Status markers on every in-scope `.md`; `check-doc-drift.mjs` enforces pi-ai v0.80 surface names |
| `463bb690` | P0-8 doc correction | ROADMAP rewritten to reflect `/compat` path is the minimum-change port |
| `84f27f4d` | P0-8 Path A | pi-ai v0.80 port: 1-line import swap to `/compat` + peerDep bump + HOOKS-AND-WHISPERS-AUDIT fix + CHANGELOG |
| `97419dfe` | P1-3 / DR-C-4 | Timer extension factory call counter in `global-state.ts`; warns when single-process-per-session assumption is violated |
| `64fb1a78` | file-mutation-queue atomicity | Write-temp-then-rename + in-flight guard + 304-line race test (committed on behalf of parallel session) |

## What's next (priority order)

1. **P1-5 / EW-7.2** — 14 unwired `NudgeType` values in `DEFAULT_NUDGE_CONFIGS`.
   Each requires a wire-vs-delete decision. See
   `docs/ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` §3 for the catalog.
2. **EW-7.11** — `braid.enforcement` settings block (config plumbing).
   Valuable once EW-7.2 settles.
3. **P3-7 / EW-7.12** — prefix naming convention (policy decision; needs
   user input).
4. **P2-10 / Q13** — large-file splits (`memory-agent-bridge`,
   `timer`, `session-recall`, `latent-activator`). Explicitly deferred;
   trigger condition was partial-met by DR-M-8 (scratchpadExecute split).
5. **Future Models-instance refactor** — `Models.completeSimple()` on a
   `createModels()` instance. Deferred until upstream removes the
   `/compat` subpath from `@earendil-works/pi-ai`.

The roadmap tally: **47 of 51 actionable items shipped**. The 4
remaining items above all need user input or a policy decision.

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

1. **Stale line numbers in `EXEMPT_LINES`**: `_completeSimple` is
   now at line 68 (was 61) and `rateLimitCooldownUntil` at line 93
   (was 86) in `src/lib/ai/llm-call.ts`. The pattern-match test
   still passes, but the line numbers in the test are stale. One-line
   cleanup when convenient.
2. **`check-deps.mjs` pre-existing violations** on commit `92fdfccc`
   (8 layer-boundary + 1 stale test ref). Not caused by this
   session's work. Decision pending: fix, defer, or carve out
   `ALLOWED_BOUNDARY_OVERRIDES`.
3. **No `git push` yet** — 23 commits are local-only. The receiving
   agent should pull from origin or push to make this transfer
   durable.

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