<!-- status: forward-looking -->
<!-- Created: 2026-06-30 -->

# pi-braid Documentation Review Proposal

> Proposal for a subagent to systematically audit and remediate pi-braid's
> self-presentation. Not an action plan — this identifies what needs review
> and why, scoped for a focused agent session.

---

## 1. Why this is needed

pi-braid's documentation has drifted from its codebase. The main README
describes an architecture that doesn't exist (layered pipeline, phantom
extensions), references a skills directory that was extracted to another
repo, and provides an example of the module system that is non-functional.
Forward-looking audit documents mix inventories of current state with
proposals for future changes, making it unclear what's true today vs what's
planned. The automated drift detector only tracks 5 API names — far too
narrow to catch the structural claims that are wrong.

A systematic documentation review is needed before any new public
presentation can be grounded in what the code actually implements.

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

**Source AGENTS.md (43):** One per subsystem directory under src/ —
all currently marked `current`.

**Reference docs (12):** Under docs/ — ROADMAP.md (actionable),
CODE-QUALITY-REMEDIATION-PLAN.md (shipped record),
ENFORCEMENT-WHISPER-CONTENT-AUDIT.md (whisper catalog),
FRAGILE-HEURISTICS-INVENTORY.md (heuristic catalog), HOOKS-AND-WHISPERS-AUDIT.md
(event hook map), STATE-POLICY.md (state design), ARXIV-CITATIONS-AUDIT.md,
docs/README.md. Plus 4 archived in archive/.

**Evaluation docs (9):** evaluation/README.md + 8 result reports with no
status markers. Out of scope of the current doc discipline but could be
brought in.

---

## 3. Issues found per document

### 3.1 README.md — Critical (status: `current`, needs `→ remediation`)

This is the highest-priority document. It is marked `current` but contains
multiple statements that are false or misleading:

| # | Claim | Problem | Type |
|---|-------|---------|------|
| R1 | Architecture diagram shows layered pipeline (enforcement→cognitive-systems→metacognition→heartbeat→memory→analytics) | The actual dependency graph is a star around agent-environment + independent satellites. No pipeline, no layering. `cognitive-systems` does not exist as a unit. | **Architectural misrepresentation** |
| R2 | "15 skills ship with pi-braid… See skills/ for the full list" | No `skills/` directory exists. Skills are in a separate repo (pi-braid-skills, 25 directories). | **Broken reference** |
| R3 | `BRAID_MODULES="core,cognitive,memory,retry"` example | Verified: `core`, `cognitive`, `retry` resolve to zero extensions. Only `memory` works. The example would load 5 memory extensions — not what the user intended. | **Non-functional example** |
| R4 | Extension overview table lists `cognitive-systems`, `retry`, `error-capture` | `cognitive-systems` doesn't exist. `retry` doesn't exist. `error-capture` is named `error-tracking`. | **Phantom extensions** |
| R5 | Table lists healthcheck, observatory, diff, research, system-monitor, assistant, feedback, evolve, rate-limiter, verification as braid tools | These are pi-core builtins, not registered by any braid extension. | **Scope inflation** |
| R6 | "Requires pi-coding-agent ≥ 0.70.0" | package.json says `>= 0.77.0`. | **Stale version** |
| R7 | "npm run test — Build + run 61 runtime tests" | Actual count is 82 test files. | **Stale metric** |
| R8 | "dual-store memory system" | Actually 5 extensions (three-memory-stores, session-recall, context-manager, context-lifecycle, memory-agent-bridge) + cognitive memory. Under-describes the architecture. | **Oversimplification** |
| R9 | Module system described as grouping abstraction | AGENTS.md explicitly says "There is no module-grouping abstraction — just a flat list." Only 7/25 extensions have a `module` field. | **Architectural misrepresentation** |

**Suggested status:** `forward-looking` until remediated.

### 3.2 ROADMAP.md — Medium (status: `forward-looking`, 2533 lines)

| # | Issue |
|---|-------|
| M1 | 3 extra `<!-- status: forward-looking -->` markers inside body (lines 824, 2405, 2479). Violates "one marker near the top" convention. |
| M2 | 6 of 51 items still pending — but most require user input, not code changes. The actionable items may be exhausted. Needs pruning: either mark remaining items as deferred/obsolete, or scope-lock them. |
| M3 | Shipped items section (2299+) lists 8/8 P0, 7/8 P1, 7/11 P2, 23/25 P3 shipped. But many P0/P1 items in the priority tables (lines 705-730) lack ✅ markers — you have to cross-reference the shipped section. |
| M4 | At 2533 lines this is too long for a roadmap. Consider splitting: shipped items → CODE-QUALITY-REMEDIATION-PLAN.md, pending items → shorter living roadmap. |

### 3.3 Forward-looking reference docs — Medium

**ENFORCEMENT-WHISPER-CONTENT-AUDIT.md** (status: `forward-looking`):
- Content is ~70% inventory of current whisper templates (current-state)
  and ~30% EW-7 proposals (forward-looking). The status marker doesn't
  distinguish these two functions.
- **Recommendation:** Split into two documents or mark as `current` with
  an explicit "Proposals" section.

**FRAGILE-HEURISTICS-INVENTORY.md** (status: `forward-looking`):
- Same hybrid issue: 76-heuristic catalog (current-state inventory) + A/B
  flags for replacement (forward-looking).
- Of 29 A+B flagged, 15 have shipped and 14 remain. The shipped count
  should be updated.

**HOOKS-AND-WHISPERS-AUDIT.md** (status: `forward-looking`):
- This is purely an inventory of current event subscriptions and whisper
  emission sites. No proposals or future-state claims. Should be `current`.

### 3.4 AGENTS.md files — Minor (all status: `current`)

| # | Issue |
|---|-------|
| A1 | `src/lib/state/AGENTS.md` had a self-contradiction (line 133 says "27 documented exceptions", line 146 says "4"). P1-2 in ROADMAP says this was "verified as no-op in v1.9 — line text already matched." **Needs verification that this is actually fixed.** |
| A2 | 43 AGENTS.md files, all `current`. No automated check verifies that their content actually matches the code they describe — only the narrow 5-name drift check exists. |

### 3.5 Doc discipline infrastructure — Medium

| # | Issue |
|---|-------|
| D1 | Drift checker (`scripts/check-doc-drift.mjs`) only tracks 5 API names (completeSimple, streamSimple, __setCompleteSimpleForTest, createModels, Models). This catches only pi-ai v0.80 migration drift. Broader structural claims (extension tables, architecture diagrams, module system) have zero automated guard. |
| D2 | No script checks README.md claims against actual code. The `check-doc-status.mjs` only checks that status markers exist — not that the content is accurate. |
| D3 | `evaluation/README.md` and result reports have no status markers. If the doc discipline is meant to cover all .md files, they should be included or explicitly excluded. |

---

## 4. Proposed review plan

The work breaks into phases. Each phase is scoped for a subagent session.

### Phase 1: README.md remediation (~1 session, ~40 tool calls)

**Goal:** Make README.md accurately describe the current codebase.

**Actions:**
1. Replace architecture diagram with one that matches actual dependency
   structure (star around agent-environment + independent satellites)
2. Remove skills claim or redirect to pi-braid-skills repo with correct count
3. Fix module system example to use actual valid references
   (e.g., `BRAID_MODULES="+heartbeat,-enforcement"`)
4. Rewrite extension overview table:
   - Remove phantom extensions (cognitive-systems, retry, error-capture)
   - Add missing alwaysOn extensions (input-polisher, agent-environment, workspace-snapshot)
   - Remove tools provided by pi-core (healthcheck, observatory, diff, etc.)
   - Add actual module labels from manifest
5. Fix peer dependency version to match package.json
6. Update test count (or remove the number — use a relative reference)
7. Update "What It Does" bullets to accurately describe the 5-group architecture
   (alwaysOn infra, agent-environment-dependent, memory tree, heartbeat, independent leaves)

**Verification:**
- `node -e "import {MANIFEST} from './dist/extensions/manifest.js'; ..."` to validate
  each extension claim
- `grep -c` on test files to get actual count
- Cross-reference each tool in the table against actual `registerTool` calls

### Phase 2: Forward-looking doc audit (~1 session, ~30 tool calls)

**Goal:** Clarify which parts of audit docs are current-state vs planned.

**Actions:**
1. **HOOKS-AND-WHISPERS-AUDIT.md:** Change status from `forward-looking` to
   `current`. It's a pure inventory with no proposals.
2. **ENFORCEMENT-WHISPER-CONTENT-AUDIT.md:** Either:
   - Add a second status marker separating §3 (catalog, current) from §7
     (proposals, forward-looking), or
   - Split into two docs, or
   - Mark as `current` and add a note that §7 are proposals
3. **FRAGILE-HEURISTICS-INVENTORY.md:** Update shipped count (15 of 29 → check
   actual current state). Consider splitting inventory from proposals.
4. **ROADMAP.md:**
   - Remove duplicate status markers
   - Add ✅ markers to shipped items in the P0/P1/P2/P3 tables
   - Review the 6 remaining items — are they still valid? Can any be closed?
   - Consider splitting shipped items to CODE-QUALITY-REMEDIATION-PLAN.md

### Phase 3: AGENTS.md verification (~1 session, ~30 tool calls)

**Goal:** Verify that all `current` AGENTS.md files are factually accurate.

**Actions:**
1. Verify `src/lib/state/AGENTS.md` self-contradiction fix (line 146 vs 133)
2. Spot-check 5-10 AGENTS.md files for claims about their subsystem
3. Verify each extension's AGENTS.md description matches its actual
   tool registrations and event handlers

### Phase 4: Doc discipline expansion (~1 session, ~20 tool calls)

**Goal:** Expand automated checks to catch the structural issues.

**Actions:**
1. Extend `check-doc-drift.mjs` to track structural claims:
   - Extension IDs listed in README must exist in MANIFEST
   - Tool names claimed as braid's must match actual `registerTool` calls
2. Add `evaluation/README.md` to the doc discipline scope (add status marker)
3. Consider a script that checks README extension table against MANIFEST
   entries

---

## 5. Effort estimate

| Phase | Files touched | Tool calls | Risk | Depends on |
|-------|--------------|------------|------|------------|
| P1: README.md | 1 file | ~40 | Medium — needs architectural understanding | None |
| P2: Forward-looking audit | 4-5 files | ~30 | Low — mostly status markers | P1 (some claims cross-reference README) |
| P3: AGENTS.md verification | 10-15 files | ~30 | Low — spot-check pattern | None |
| P4: Doc discipline | 2-3 files + scripts | ~20 | Medium — requires understanding drift checker | P1, P3 (to know what to track) |

**Total:** ~4 sessions, ~120 tool calls.

---

## 6. Quick wins (can be done in <10 tool calls)

These are the highest-ROI individual fixes:

1. **README.md peer dep version** — one line change (`0.70.0` → `0.77.0`)
2. **README.md test count** — one line change (`61` → `82`)
3. **README.md skills link** — remove `skills/` link, point to pi-braid-skills repo
4. **HOOKS-AND-WHISPERS-AUDIT.md** — change status to `current`
5. **ROADMAP.md** — remove 3 duplicate status markers
6. **README.md module example** — replace with working example
   (e.g., `BRAID_MODULES="+heartbeat,-enforcement"`)
