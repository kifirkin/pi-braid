<!-- status: forward-looking -->

# Skill quality audit: tier-0 pipeline

> **Status:** Proposal
> **Scope:** pi-braid core — meta-improvement skill + periodic audit procedure
> **Problem:** 24 skills exist. Many were written by Braid in one session and never revisited. There is no process for catching stale guidance, broken cross-references, or skills that were useful once but misleading in other contexts. Quality degrades silently as the codebase evolves.

---

## What a quality audit is

A read-only pass over every SKILL.md that answers three questions:

1. **Is the guidance still accurate?** — Do the tool commands still work? Do the file paths still exist? Are the behavioral expectations still enforced?
2. **Is the cross-reference graph consistent?** — If skill A mentions skill B in `see-also`, does skill B mention skill A back? Are there dead links?
3. **Is the skill earning its context cost?** — How many sessions used it? What was the outcome? If zero sessions in 30 days, flag for archival.

---

## Procedure (add to meta-improvement skill)

```yaml
name: meta-improvement
topics: [skill, quality, audit, improvement]
maturity: tier-1
---
```

New section in meta-improvement/SKILL.md:

### Part 3: Quality audit

Run after every 10 sessions, or on demand.

**Step 1 — Inventory:** Read all SKILL.md frontmatter. Collect `name`, `maturity`, `see-also`. Identify skills missing any of the three new frontmatter fields.

**Step 2 — Cross-reference check:** For each `see-also` link from skill A → skill B, verify B has a reciprocal link to A. Log orphans.

**Step 3 — Command verification:** For each skill that contains shell commands (` ```bash ` or ` ```sh `), extract and run the first command with `--help` or dry-run flag. Flag commands that error.

**Step 4 — Session usage check:** Query memory store for sessions that used each skill in the last 30 days. Skills with 0 uses → archival candidate.

**Step 5 — Promotion gate:** For each tier-0 skill with ≥2 successful session outcomes and clean steps 2–4, promote to tier-1. Write the promotion to SKILL.md frontmatter.

**Step 6 — Report:** Write a one-page audit report to `docs/audit/SKILL-AUDIT-<date>.md`. Include: total skills, tier-1 count, tier-0 count, orphans, stale commands, archival candidates, promotions applied.

---

## Archival policy

Archived skills are not deleted — they move to `skills-archive/` at the repo root. The prompt builder ignores `skills-archive/`. If a skill is later needed, it can be restored in minutes. Archival is not punishment; it's context hygiene.

---

## Integration with existing tools

The audit uses:
- `find` + `grep` — collect frontmatter from all SKILL.md files
- `memory(action='recall_search')` — query session usage per skill
- `bash` with `--help` — verify command examples
- `edit` — promote tier-0 → tier-1 (one field change)

No new tools needed. The procedure is the deliverable.

---

## What this changes for the agent

- Skills stop being permanent residents. They justify their existence every 30 sessions.
- Tier-0 becomes an actionable signal, not a theoretical category.
- The agent has a self-contained procedure for catching its own drift without human intervention.