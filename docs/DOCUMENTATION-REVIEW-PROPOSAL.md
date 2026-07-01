<!-- status: forward-looking -->
<!-- Created: 2026-06-30 -->

# pi-braid Documentation Review Proposal

Scope: identify the documentation issues found in a 2026-06-30 audit of
the pi-braid repository, organized so a focused agent session can address
each in turn. The state of the codebase is the source of truth; the
documents are the object being audited.

---

## 1. Context

A session-level audit of the markdown surface (61 files across
top-level, src/, docs/, evaluation/) found these categories of
discrepancy between the docs and the codebase:

- Claims in the main README that don't match the manifest or package.json
- A drift-detection script whose tracked-name set is too narrow to catch
  the actual drift
- Three "forward-looking" reference docs that are mostly inventories of
  current state
- A long roadmap with shipped items and pending items interleaved

Some of the README issues were addressed in the same session that
produced this proposal. The state recorded below is the state at the end
of that work.

---

## 2. Documentation inventory

### 2.1 Status distribution (61 markdown files)

| Status | Count | Files |
|--------|-------|-------|
| `current` | 44 | README.md, AGENTS.md (top-level + src/ + all children), HANDOFF.md, 6 docs/ files |
| `forward-looking` | 4 | ROADMAP.md, ENFORCEMENT-WHISPER-CONTENT-AUDIT.md, FRAGILE-HEURISTICS-INVENTORY.md, HOOKS-AND-WHISPERS-AUDIT.md |
| `historical` | 4 | 4 archived audits in docs/archive/ |
| *(no marker)* | 9 | evaluation/README.md, 8 result reports in evaluation/results/ |

### 2.2 Files by category

**Top-level project docs (5):** README.md, AGENTS.md, CONTRIBUTING.md,
CHANGELOG.md, HANDOFF.md

**Source AGENTS.md (43):** One per subsystem directory under src/ — all
currently marked `current`.

**Reference docs (12):** Under docs/ — ROADMAP.md (actionable),
CODE-QUALITY-REMEDIATION-PLAN.md (shipped record),
ENFORCEMENT-WHISPER-CONTENT-AUDIT.md (whisper catalog),
FRAGILE-HEURISTICS-INVENTORY.md (heuristic catalog),
HOOKS-AND-WHISPERS-AUDIT.md (event hook map), STATE-POLICY.md (state
design), ARXIV-CITATIONS-AUDIT.md, docs/README.md. Plus 4 archived in
archive/.

**Evaluation docs (9):** evaluation/README.md + 8 result reports with
no status markers. Outside the current doc discipline but could be
brought in.

---

## 3. Issues by document

### 3.1 README.md

| # | Claim | State at end of audit |
|---|-------|------------------------|
| R1 | Architecture diagram showed a layered pipeline with a "cognitive-systems" block | Diagram rewritten; layering is still implied but no longer names a nonexistent block. |
| R2 | "15 skills ship with pi-braid... see skills/" | Redirected to pi-braid-skills repo. The count "15" is now stale (current count is 25). |
| R3 | `BRAID_MODULES="core,cognitive,memory,retry"` example | Partially fixed: changed to `"core,cognitive,memory,heartbeat"`. `core` and `cognitive` still don't resolve. `heartbeat` is a real module group; only it works. |
| R4 | Extension table listed `cognitive-systems`, `retry`, `error-capture` | Partially fixed. `cognitive-systems` and `retry` removed. `error-capture` still listed (actual name is `error-tracking`). |
| R5 | Table included tools that pi-core provides (healthcheck, observatory, diff, research, system-monitor) as if they were braid's | Unchanged. These are pi-core builtins, not registered by any braid extension. |
| R6 | "Requires pi-coding-agent ≥ 0.70.0" | Fixed: now `≥ 0.77.0` matching package.json. |
| R7 | "61 runtime tests" | Fixed: now `83 runtime tests`. |
| R8 | "dual-store memory system" | Superseded by the "What It Does" rewrite which describes the memory tree more accurately. |
| R9 | Module system described as a grouping abstraction | Still present. AGENTS.md explicitly says "There is no module-grouping abstraction — just a flat list." |
| R10 | Tagline "The agent doesn't just execute tools — it reflects, remembers, and adapts across turns." | Unchanged. Marketing language. |

### 3.2 ROADMAP.md (status: `forward-looking`, 2533 lines)

| # | Issue |
|---|-------|
| M1 | 3 extra `<!-- status: forward-looking -->` markers inside body (lines 824, 2405, 2479). Violates "one marker near the top" convention defined in `AGENTS.md`. |
| M2 | 6 of 51 items still pending; most require user input rather than code changes. The actionable items are largely exhausted. |
| M3 | The shipped-items section (line 2299+) lists `✅ Shipped` for items in the P0/P1/P2/P3 tables. But the priority tables themselves (lines 705-730) don't show those checkmarks. Reader has to cross-reference. |
| M4 | At 2533 lines, the document is too long for a roadmap. Shipped items belong in CODE-QUALITY-REMEDIATION-PLAN.md. |

### 3.3 Forward-looking reference docs

**ENFORCEMENT-WHISPER-CONTENT-AUDIT.md** (status: `forward-looking`):
Content is ~70% inventory of current whisper templates and ~30% EW-7
proposals. The single status marker doesn't distinguish the two
functions. Recommendation: split, or mark as `current` with a "Proposals"
section.

**FRAGILE-HEURISTICS-INVENTORY.md** (status: `forward-looking`):
Same hybrid structure: 76-heuristic catalog (current-state) + A/B flags
for replacement (forward-looking). Of 29 A+B flagged, 15 have shipped
and 14 remain. The shipped count should be updated.

**HOOKS-AND-WHISPERS-AUDIT.md** (status: `forward-looking`):
Pure inventory of current event subscriptions and whisper emission
sites. No proposals. The status marker is wrong; it should be `current`.

### 3.4 AGENTS.md files (all status: `current`)

| # | Issue |
|---|-------|
| A1 | `src/lib/state/AGENTS.md` had a self-contradiction (line 133: "27 documented exceptions"; line 146: "4 documented exceptions"). P1-2 in ROADMAP says "verified as no-op in v1.9 — line text already matched." Verification not yet done. |
| A2 | 43 AGENTS.md files, all `current`. The drift checker doesn't verify their content matches the code they describe. |

### 3.5 Doc discipline infrastructure

| # | Issue |
|---|-------|
| D1 | `scripts/check-doc-drift.mjs` only tracks 5 API names (completeSimple, streamSimple, __setCompleteSimpleForTest, createModels, Models). It catches the pi-ai v0.80 migration drift and nothing else. README extension IDs, the module system, the skills claim — none of these are covered. |
| D2 | `scripts/check-doc-status.mjs` only checks that status markers exist. It does not check that the content is accurate. |
| D3 | `evaluation/README.md` and result reports have no status markers. The doc discipline is ambiguous about whether `evaluation/` is in scope. |

---

## 4. Work plan

### Phase 1: README.md

Files touched: `README.md` (1).

Actions:
1. Fix the `BRAID_MODULES` example to use only references that resolve.
   Verified working examples: `+heartbeat`, `-enforcement`, `memory`,
   `+heartbeat,-enforcement`. The strings `core` and `cognitive` resolve
   to nothing.
2. Rename `error-capture` to `error-tracking` in the extension table.
3. Decide on the Tools / Infra / System categories. Currently they mix
   braid-registered tools with pi-core builtins. Either remove the
   pi-core items or label them as inherited.
4. Update the skills count from "15" to whatever the current count is
   (or describe the count as approximate).
5. Drop the "reflects, remembers, and adapts" tagline, or move it
   somewhere less prominent.

Verification:
- `node -e "import {MANIFEST, getModuleNames} from './dist/extensions/manifest.js'"`
  to validate each entry in the table.
- `node -e "import {expandRef, getEntry, getModuleGroup} from './dist/extensions/manifest.js'"`
  to test each `BRAID_MODULES` value cited in the README.
- `grep -c "registerTool" src/extensions/*/index.ts` to verify the
  braid-registered tool list.

### Phase 2: Forward-looking reference docs

Files touched: 4 in `docs/`.

Actions:
1. Change `HOOKS-AND-WHISPERS-AUDIT.md` status to `current`.
2. Update shipped counts in `FRAGILE-HEURISTICS-INVENTORY.md` (15 of
   29 A+B shipped → check the actual current state).
3. Decide on structure for `ENFORCEMENT-WHISPER-CONTENT-AUDIT.md`:
   either split into two docs, or keep one with a per-section status
   convention.
4. In `ROADMAP.md`:
   - Remove the 3 extra status markers at lines 824, 2405, 2479.
   - Decide whether to fold shipped items into
     `CODE-QUALITY-REMEDIATION-PLAN.md` and shorten the roadmap.
   - For each of the 6 remaining items, decide if they should remain
     in the roadmap or be archived.

### Phase 3: AGENTS.md verification

Files touched: 10-15 in `src/`.

Actions:
1. Read `src/lib/state/AGENTS.md` lines 133 and 146 to verify the
   P1-2 fix claim. If the contradiction is still there, fix it.
2. Spot-check 5-10 other AGENTS.md files for claims that don't match
   the code in their directory.

### Phase 4: Drift checker expansion

Files touched: `scripts/check-doc-drift.mjs`, possibly
`scripts/check-doc-status.mjs`.

Actions:
1. Add structural checks:
   - Extension IDs named in `README.md` must exist in `MANIFEST`.
   - The strings cited in the `BRAID_MODULES` example must resolve.
2. Add `evaluation/README.md` to the doc discipline (or explicitly
   exclude it).

---

## 5. Outstanding items from the parallel session

Items the parallel agent has already addressed during this audit:
- Peer dependency version (R6) — fixed
- Test count (R7) — fixed
- Skills claim (R2) — partially fixed (link redirected, count not updated)
- Extension table (R4) — partially fixed (2 of 3 phantoms removed)
- Architecture diagram (R1) — partially fixed (cognitive-systems block removed)

Items still outstanding from the audit:
- R3 (module example still partially broken)
- R5 (pi-core tools still mixed in)
- R9 (module-system description still misleading)
- R10 (tagline)
- All of §3.2, §3.3, §3.4, §3.5

---

## 6. Effort

| Phase | Files | Tool calls | Risk |
|-------|-------|------------|------|
| P1: README.md | 1 | ~40 | Medium — needs to choose between editing or rewriting sections |
| P2: Forward-looking docs | 4-5 | ~30 | Low |
| P3: AGENTS.md verification | 10-15 | ~30 | Low |
| P4: Drift checker | 2-3 | ~20 | Medium |

Approximate total: ~4 sessions, ~120 tool calls.
