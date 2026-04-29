# Cleanup Sprint Plan — 2026-04-29

## Audit Summary

| Category | Count | Action |
|---|---|---|
| Total active docs | 101 | — |
| Total archive docs | 49 | Keep (historical) |
| Redundant | 7 | DELETE |
| Overlaps existing | 3 | MERGE or ARCHIVE |
| Gap: extension groups | 6 | ADD DOCS |
| Good | ~85 | KEEP |

---

## TIERS

### TIER 1 — DELETE (7 files)

These are superseded, historical, or redundant with no keeping value.

| File | Size | Reason to delete |
|---|---|---|
| `PI-API-RESEARCH.md` | 11KB | Superseded by PYTHON-TO-JS-MIGRATION.md (SDK migration complete, RPC dead-end documented). |
| `PROMPT-BUILDER-REFACTOR.md` | 18KB | Header says "HISTORICAL — See RESEARCH-MASTER.md Part 5" — its content IS the BRAID-NEXT system. |
| `PROPOSAL-scratchpad-persist-aware-eviction-2026-04-28.md` | 10KB | One-off session note, superseded by BRAID-NEXT + scratchpad implementation complete. |
| `RESEARCH-MASTER.md` | 36KB | Superseded by BRAID-NEXT-PROPOSAL.md (clearer, maintained, all content merged). |
| `CONSOLIDATED-DOCS-INVENTORY.md` | 18KB | Date-locked (2026-04-24), superseded by DOC-AUDIT.md (newer, more thorough). |
| `HONEST-REVIEW.md` | 9.5KB | Version-locked (v0.14.0→v0.18.1 review), no current value — historical only. |
| `DEVELOPMENT.md` | 3.5KB | Fully duplicated by ARCHITECTURE.md + MODULES.md. |

### TIER 2 — MERGE / ARCHIVE (7 files)

Content has value but overlaps with other docs. Move to archive or merge into existing doc.

| File | Size | Action |
|---|---|---|
| `SAE-STEERING.md` (top-level) | 4KB | Merge status note into `docs/proposals/SAE-STEERING-PROPOSAL.md` (already marked OBSOLETE), then DELETE. |
| `REPE-PROMPT-CONTRAST.md` (top-level) | 4KB | Merge into `docs/proposals/REPE-PROMPT-CONTRAST-PROPOSAL.md` (which has full content), DELETE top-level. |
| `SKILL-LOADING-RESEARCH.md` | 4KB | Archive — it's research notes, superseded by docs/SKILLS.md + DOC-AUDIT.md. |
| `REPE-PROMPT-CONTRAST-PROPOSAL.md` | 8KB | Already in proposals/. Keep, but merge top-level REPE-PROMPT-CONTRAST.md into it. |

**SAE-STEERING.md + SAE-STEERING-PROPOSAL.md consolidation:**
```
Status: OBSOLETE
Superseded by REPE-PROMPT-CONTRAST-PROPOSAL.md
API-only providers (stepfun/minimax) don't expose activations.
RepE-style Prompt Contrast is the correct approach.
```

### TIER 3 — ADD DOCS (Extension Groups)

6 extension groups have NO .md doc coverage. Each group has substantial .ts files:

| Group | .ts files | Priority |
|---|---|---|
| `cognitive` | 28 files | HIGH — enforcement, reasoning, verification, topic-drift, sycophancy-detector, cognitive-systems |
| `core` | 9 files | MEDIUM — polyfill, metacognition, scratchpad, user-message-preprocessor |
| `heartbeat` | 2 files | MEDIUM — heartbeat-scheduler, analytics |
| `memory` | 16 files | MEDIUM — context-manager, context-lifecycle, session-recall, three-memory-stores |
| `prompt` | 5 files | LOW — prompt-builder, prompt-guardian |
| `tools` | 7 files | LOW — codebase-tree, docs, healthcheck, latent-activator, repl, timer |

**Priority reasoning:**
- `cognitive` has 28 files including enforcement (most complex), reasoning, verification, topic-drift, cognitive-systems — highest impact
- `core` has polyfill (critical infrastructure), metacognition, scratchpad
- `heartbeat` has heartbeat-scheduler + analytics (both documented individually as extensions, need group doc)
- `memory` has context-manager + context-lifecycle + three-memory-stores + session-recall

### TIER 4 — KEEP (including archive verdict)

**Keep all 49 archive files.** All from v0.5-v0.9 era, document evolution of ideas. No critical content missing. ROADMAP-v1.0-FULL.md (1942 lines) is especially useful as master reference.

**Keep all existing docs:**
- 33 top-level (ARCHITECTURE, CHANGELOG, MODULES, WHAT-IS-MISSING, etc.)
- 37 extension docs (docs/extensions/)
- 22 lib docs (docs/lib/)
- 3 proposals (docs/proposals/)
- 3 research docs (docs/research/)
- README, SKILLS, TESTING, ERRORS, FEATURE-AUDIT, etc.

---

## Execution Order

### Phase 1: DELETE tier-1 items (5 min)
```
PI-API-RESEARCH.md
PROMPT-BUILDER-REFACTOR.md
PROPOSAL-scratchpad-persist-aware-eviction-2026-04-28.md
RESEARCH-MASTER.md
CONSOLIDATED-DOCS-INVENTORY.md
HONEST-REVIEW.md
DEVELOPMENT.md
```

### Phase 2: MERGE/ARCHIVE tier-2 items (10 min)
```
1. Merge SAE-STEERING.md status into proposals/SAE-STEERING-PROPOSAL.md
2. Merge REPE-PROMPT-CONTRAST.md into proposals/REPE-PROMPT-CONTRAST-PROPOSAL.md
3. Delete top-level SAE-STEERING.md, REPE-PROMPT-CONTRAST.md
4. Move SKILL-LOADING-RESEARCH.md → .archive-old/
```

### Phase 3: ADD extension group docs (45 min)
Create minimal docs for 6 extension groups. Even a single paragraph helps.

**cognitive.md** (HIGH priority):
```markdown
# Extension Group: cognitive

High-level cognitive extensions: enforcement, reasoning, verification, topic-drift, sycophancy-detector, cognitive-systems.

See individual extension docs in docs/extensions/ for detailed docs.
```

**heartbeat.md + memory.md + core.md** (medium priority): similar minimal structure.

### Phase 4: Verify (5 min)
- Build clean
- 34/34 tests pass
- `npm run typecheck` clean

---

## Metrics After Cleanup

| Metric | Before | After |
|---|---|---|
| Active top-level docs | 33 | 26 (-7) |
| Total active docs | 101 | 94 (-7) |
| Extension group coverage | 1/6 groups | 6/6 |
| Redundant files | 7 | 0 |

## Archive Stats (unchanged)

```
docs/.archive-old/       49 files   (keep as-is)
  └── research/           9 files   (keep)
  └── subagent-tasks/     2 files   (keep)
```