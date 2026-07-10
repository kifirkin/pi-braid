<!-- status: forward-looking -->

# Skill discovery: semantic matching + usage signal

> **Status:** Proposal
> **Scope:** pi-braid core — prompt builder only. Zero changes to SKILL.md format.
> **Problem:** Skills are discovered by substring match on `description`. Agent reads them one at a time, iteratively, as it hits problems. No mechanism suggests the *set* of skills relevant to a task before work starts. No signal separates repeatedly-useful skills from one-shot drafts.

---

## What changes

### 1. Prompt builder: semantic skill matching

Current: `query` vs `description` substring match.

Proposed: before task execution, extract significant nouns and verbs from the user's request. Match them against skill names and descriptions using a simple word-overlap score (intersection / union of non-stopword tokens). Return the top N skills ranked by score.

**No new dependencies.** No embeddings, no vector DB. Just a `Set(tokenize(task)) ∩ Set(tokenize(skill.name + " " + skill.description))` per skill. The existing 24 descriptions are already in the prompt builder's scope.

**Effect:** a task like "make a presentation about Braid" yields `visual-creator`, `tone-quality`, `documentation`, `software-engineer` — not just the first one whose description contains "presentation". Agent reads the set before starting, not one at a time.

### 2. Usage signal: implicit qualification

No maturity field in SKILL.md. Instead, the prompt builder tracks which skills are actually *read and executed* per session. After 10 sessions, skills read in <2 sessions and never leading to a successful outcome are moved to the bottom of the match ranking.

**Data source:** session memory (episodes). Each episode records which skills were read. If a skill is read but the session ends with `completed: false`, the skill's implicit score decreases.

**Effect:** tier-0 and tier-1 emerge organically from usage patterns, not from a metadata field that requires manual maintenance.

---

## Implementation

| Step | Effort | What |
|---|---|---|
| 1. Token matcher | 1h | Extract nouns/verbs from user request, compute overlap score with all skill names+descriptions, return top 5. |
| 2. Prompt injection | 1h | Inject ranked skill list as a "Relevant skills" block before the standard skill-read instruction. |
| 3. Usage tracker | 2h | At session end, log which skills were read to memory store. Query on next session start to adjust ranking. |

Three changes, all in the prompt builder. No skill files touched.

---

## What this changes for the agent

- Before starting, the agent sees a ranked, task-specific skill set instead of relying on its own memory of what skills exist.
- Repeatedly useful skills float to the top automatically. One-shot drafts sink without anyone manually tagging them.
- The skill format stays exactly as it is.