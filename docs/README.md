<!-- status: current -->

# `docs/` Reference Index

**Entry point for all pi-braid documentation.** Read [`ROADMAP.md`](ROADMAP.md) first.

## Active documents

| Doc | Purpose | Last update |
|---|---|---|
| [`SETUP.md`](SETUP.md) | **Canonical setup reference for braid users.** Install paths (5 options), skills setup, full config schema, module toggling, storage, troubleshooting. | 2026-07-02 |
| [`ROADMAP.md`](ROADMAP.md) | **Primary actionable roadmap.** Consolidated improvement list. Archived proposals moved to `../pi-braid-evaluation/docs-archive/`. | 2026-06-30 |
| [`FRAGILE-HEURISTICS-INVENTORY.md`](FRAGILE-HEURISTICS-INVENTORY.md) | Full 76-heuristic catalog classified A/B/C/D. 14 of 29 A+B flagged items remain for LLM replacement. | 2026-06-14 |
| [`ARCHAEOLOGY-FINDINGS.md`](ARCHAEOLOGY-FINDINGS.md) | Full prompt evolution timeline, lost features, research findings, session archaeology. | 2026-07-06 |
| [`P0-B-CRITIC-CONSOLIDATION.md`](P0-B-CRITIC-CONSOLIDATION.md) | Critic consolidation inventory and plan. 1 implementation remaining (standalone critics). | 2026-07-02 |

## Archived documents (moved to `../pi-braid-evaluation/docs-archive/`)

Historical auditing and proposals, moved to the evaluation project for reference.
All actionable content has been folded into ROADMAP.md.

| Doc | Why archived | Replaced by |
|---|---|---|
| `docs-archive/CASTS-AUDIT.md` | Audit missed 6 `as ToolDefinition` casts | ROADMAP §3.2 DR-H-1 |
| `docs-archive/TOOL-INVENTORY-AUDIT.md` | Most cut/merge recommendations shipped | ROADMAP §2.1, P3-24 |
| `docs-archive/Q13-SPLIT-INDEX-STATUS.md` | Deferral decision still in effect but sizes stale | ROADMAP §2.2, P2-10 |
| `docs-archive/WHISPER-AND-LOGGING-AUDIT.md` | Superseded by enforcement whisper audit | ROADMAP §2.4, DR-C-1 |
| `docs-archive/P2-10-LARGE-FILE-DECOMPOSITION.md` | All 4 file splits shipped | ROADMAP §2.2 |
| `docs-archive/CODE-QUALITY-REMEDIATION-PLAN.md` | Complete record — all 6 remediation rounds shipped | ROADMAP (CR-N items) |
| `docs-archive/STATE-POLICY.md` | Design narrative; operational policy at `src/lib/state/AGENTS.md` | `src/lib/state/AGENTS.md` |
| `docs-archive/ENFORCEMENT-WHISPER-CONTENT-AUDIT.md` | Full catalog preserved; 15 EW-7 proposals tracked in ROADMAP §4 | ROADMAP §4 |
| `docs-archive/HOOKS-AND-WHISPERS-AUDIT.md` | Completed event/whisper mapping | (code is source of truth) |
| `docs-archive/ARXIV-CITATIONS-AUDIT.md` | All 7 citations verified, no changes needed | `test/test-arxiv-citations.mjs` |
| `docs-archive/DOCUMENTATION-REVIEW-PROPOSAL.md` | Proposal doc; items tracked via subsequent sessions | ROADMAP + doc sessions |
| `docs-archive/RESEARCH-INTEGRATION-TESTING-GAP.md` | Research finding; key insight addressed directly | (code is source of truth) |
| `docs-archive/SELF-EVOLUTION-PROPOSAL.md` | Research-backed proposals; no committed workstream | (research reference) |
| `docs-archive/CONTEXT-MANAGEMENT-IMPROVEMENTS.md` | All implementable context_compress features shipped | `context_compress` tool |

> **Note:** Archived docs moved to `../pi-braid-evaluation/docs-archive/`. Preserved as-is for historical reference.

## How docs/ is organized

```
docs/
├── README.md                           ← you are here
├── ROADMAP.md                          ← start here
├── SETUP.md                            ← canonical setup reference
├── FRAGILE-HEURISTICS-INVENTORY.md     ← heuristic catalog (14 items remaining)
├── P0-B-CRITIC-CONSOLIDATION.md        ← critic consolidation
├── ARCHAEOLOGY-FINDINGS.md             ← prompt evolution, research findings
├── enforcement/                        ← enforcement audit docs
│   └── D-57-CLOSURE.md
├── proposals/                          ← improvement proposals
│   └── IMPROVEMENT-PROPOSALS.md
└── (archived audits moved to ../pi-braid-evaluation/docs-archive/)
```

## Conventions

- **`docs/`** is a durable reference folder, NOT a DOX subtree. Each
  document is independent; there is no `AGENTS.md` here.
- All cross-references between docs use relative paths. Archived docs
  moved to `../pi-braid-evaluation/docs-archive/`. Update references in
  remaining docs when moving.
- Test files that cite archived docs should be updated to point to the
  new location OR to the ROADMAP if the citation is no longer
  relevant.
- Historical references in `CHANGELOG.md` are left as-is (they document
  the state at the time of the release, including which doc existed
  then).

## Audit cycle

When ROADMAP items ship:

1. Update the relevant section in `ROADMAP.md` (mark item done, link to commit)
2. If a new audit was needed for the change, add it as a new `docs/<name>.md` (do not amend archived ones)
3. Update tests that pin the previous behavior

When a new audit is needed:

1. Create a new `docs/<name>-AUDIT.md` with the scope, method, findings, and proposed improvements
2. Add the findings to ROADMAP as P0/P1/P2/P3 items with the audit's id as a prefix
3. Do not amend the content of older audit documents; they are historical
