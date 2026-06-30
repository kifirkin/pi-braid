<!-- status: current -->

# `docs/` Reference Index

**Entry point for all pi-braid documentation.** Read [`ROADMAP.md`](ROADMAP.md) first.

## Active documents

| Doc | Purpose | Last update |
|---|---|---|
| [`ROADMAP.md`](ROADMAP.md) | **Primary actionable roadmap.** Consolidated improvement list with 51 items (P0–P3, 45 full + 1 partial shipped), 36 new findings from deep review, 15 EW-7 proposals. Replaces the 4 archived audits. | 2026-06-30 |
| [`CODE-QUALITY-REMEDIATION-PLAN.md`](CODE-QUALITY-REMEDIATION-PLAN.md) | Historical record of the 6 remediation rounds (Q1–Q15). Headline numbers reflect the state at the time of each round (current: 81/81 tests, 227 src + 83 test files, 28 documented exceptions). | 2026-06-17 |
| [`ENFORCEMENT-WHISPER-CONTENT-AUDIT.md`](ENFORCEMENT-WHISPER-CONTENT-AUDIT.md) | Full inventory of all 35 whisper templates with trigger conditions, file:line, message templates, and the 15 EW-7 proposals. The §3 catalog is a reference; actionable items are in ROADMAP §4. | 2026-06-17 |
| [`FRAGILE-HEURISTICS-INVENTORY.md`](FRAGILE-HEURISTICS-INVENTORY.md) | Full 76-heuristic catalog classified A/B/C/D. Of 29 A+B flagged for LLM replacement, 15 have shipped and 14 remain (shipped count may be stale — verify against code). | 2026-06-14 |
| [`STATE-POLICY.md`](STATE-POLICY.md) | Design narrative for state lifetimes. Operational policy is in `src/lib/state/AGENTS.md`. | 2026-06-17 |
| [`ARXIV-CITATIONS-AUDIT.md`](ARXIV-CITATIONS-AUDIT.md) | All 7 cited papers verified, no changes needed. Test in `test-arxiv-citations.mjs`. | 2026-06-15 |

## Archived documents (in `archive/`)

These are preserved for historical reference only. Their actionable
content has been folded into ROADMAP.md. See the archive notice at the
top of each file for details and the relevant ROADMAP section.

| Doc | Why archived | Replaced by |
|---|---|---|
| `archive/CASTS-AUDIT.md` | Audit missed 6 `as ToolDefinition` casts (actual count is 10, not 4) | ROADMAP §3.2 DR-H-1, §2.6 |
| `archive/TOOL-INVENTORY-AUDIT.md` | Most cut/merge recommendations shipped; orphan `tasks.json` may still need cleanup | ROADMAP §2.1, P3-24 |
| `archive/Q13-SPLIT-INDEX-STATUS.md` | Deferral decision still in effect but file sizes are stale | ROADMAP §2.2, §5.3, P2-10 |
| `archive/WHISPER-AND-LOGGING-AUDIT.md` | Delivery-mechanism audit superseded by ENFORCEMENT-WHISPER-CONTENT-AUDIT.md + the new `ctx.whisper` finding | ROADMAP §2.4, §3.1 DR-C-1 |

## How docs/ is organized

```
docs/
├── README.md                          ← you are here
├── ROADMAP.md                         ← start here
├── CODE-QUALITY-REMEDIATION-PLAN.md   ← what we shipped
├── ENFORCEMENT-WHISPER-CONTENT-AUDIT.md  ← whisper catalog (reference)
├── FRAGILE-HEURISTICS-INVENTORY.md    ← heuristic catalog (reference)
├── STATE-POLICY.md                    ← state design narrative
├── ARXIV-CITATIONS-AUDIT.md           ← citation verification
└── archive/                           ← superseded audits (preserved)
    ├── CASTS-AUDIT.md
    ├── TOOL-INVENTORY-AUDIT.md
    ├── Q13-SPLIT-INDEX-STATUS.md
    └── WHISPER-AND-LOGGING-AUDIT.md
```

## Conventions

- **`docs/`** is a durable reference folder, NOT a DOX subtree. Each
  document is independent; there is no `AGENTS.md` here.
- All cross-references between docs use relative paths. When archiving
  a doc, update references in remaining docs (the convention is
  `docs/archive/<name>` for archived, `docs/<name>` for active).
- Test files that cite archived docs should be updated to point to the
  new location OR to the ROADMAP if the citation is no longer
  relevant.
- Historical references in `CHANGELOG.md` are left as-is (they document
  the state at the time of the release, including which doc existed
  then).

## Audit cycle

When ROADMAP items ship:

1. Update the relevant section in `ROADMAP.md` (mark item done, link to commit)
2. If the change is structural, also update `CODE-QUALITY-REMEDIATION-PLAN.md` (new round)
3. If a new audit was needed for the change, add it as a new `docs/<name>.md` (do not amend archived ones)
4. Update tests that pin the previous behavior

When a new audit is needed:

1. Create a new `docs/<name>-AUDIT.md` with the scope, method, findings, and proposed improvements
2. Add the findings to ROADMAP as P0/P1/P2/P3 items with the audit's id as a prefix
3. Do not amend the content of older audit documents; they are historical
