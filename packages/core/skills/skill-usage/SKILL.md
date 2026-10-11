---
name: skill-usage
description: "Measure skill adoption from durable counters and session telemetry: per-skill suggested/loaded/claimed/actual counts, conversion rates, and active/needs-refresh/prune buckets. Use when measuring whether skills are actually used, taking before/after metrics around a skill or scoring change, deciding keep/refresh/deprecate for a skill, or reporting adoption - the skills-subsystem instrument (skill_stats tool, skills-usage.json, injection-tracker). Do NOT use for general research, code search, or project metrics outside the skills subsystem."
validated: 2026-09-09
verdict: KEEP
---

# Skill Usage: Measuring Skill Adoption

The skill-loading problem is unmeasured, not unbroken. This skill turns "skills are barely used" from an owner observation into a number you can act on. It reads telemetry that already exists - no new runtime code required - and emits a per-skill usage table.

The validation-first stance: **a zero-evidence skill must NOT be KEEP.** Every skill is suspect until measured. This skill is the measurement instrument; `meta-improvement` is the evolution engine. Run this first, feed the result to `meta-improvement`.

## When to use

- Checking whether skills are being used (adoption report).
- Deciding keep / needs-refresh / prune for a skill or the whole pack.
- Validating whether a skill improvement changed usage.
- Answering "is skill X used?" with data, not vibes.

## Step 1: Read the session counters (exact, per-session)

Call the `skill_stats` tool. It returns `sessionHasSkillLoad` plus a per-skill map:

```json
{
  "sessionHasSkillLoad": true,
  "skills": { "research": { "suggested": 2, "loaded": 1 } }
}
```

- `suggested` - times the auto-inject whisper **delivered** a suggestion for the skill. The counter moves only after the tracked send path accepted the whisper, so it counts arrivals, not attempts: a suggestion suppressed before delivery consumes no cooldown slot and no count.
- `loaded` - times the skill was loaded: a SKILL.md read via the `read` tool, plus historical `LOADED <name>` probe claims. The probe reply is no longer solicited - the whisper now asks for the read - so `loaded` tracks detected reads for any suggestion made after the change. `claimed` and `actual` record which trigger fired.

This is the only **exact** per-skill signal. It is session-scoped: one session's view. For a cross-session picture, read the durable store in Step 2.

## Step 2: Read the durable counters (cross-session)

`skills-usage.json` under the braid dir holds the all-time per-skill `suggested` / `loaded` / `claimed` / `actual` counters plus `lastAt`; `skill_stats` returns them under `allTime` / `allTimeTotals` alongside the monthly adoption rollup.

To cross-check one session, filter its JSONL for the tracked whisper: entries with `customType: "skills-suggestion"` carry `details.skills` (the names) and `details._braidSource: "skills-auto-inject"`. The stream and the counter are two views of the same event, because the counter increments only on a delivered whisper - a counted suggestion with no entry in the stream is a defect in the counter, not a signal to attribute to the skill.

## Step 3: Session-file floor estimate (coarse, label it as an estimate)

Fallback / cross-check: scan session files under `~/.pi/agent/sessions/` for:

- `list_skills` tool calls (discovery attempts), and
- `read` calls whose path ends in `SKILL.md` (load attempts).

**This is a floor estimate, not a precision signal** - prompt echoes and orchestrator coordination traffic inflate raw counts. Use it to confirm a skill is used at all, never to prove disuse.

## Step 4: Join with an outcome proxy (where available)

Where a turn's reasoning metrics exist (`measureStability`: topic anchor, bigram entropy, self-contradiction), tag each skill-loading turn with a coarse outcome: `stable` (no self-contradiction, anchored) or `unstable`. The goal is not a perfect score - it is a **delta you can compare after a change**.

## Step 5: Emit the table and bucket

Emit a table, one row per skill:

| skill    | suggested | loaded | outcome | bucket |
| -------- | --------- | ------ | ------- | ------ |
| research | 3         | 2      | stable  | active |
| meme     | 0         | 0      | -       | prune  |

Buckets (validation-first):

- **active** - loaded ≥ 1 this measurement window, or loaded with a stable outcome.
- **needs-refresh** - suggested but never loaded (the suggestion is not converting - the description or excerpt is failing to sell the skill).
- **prune** - zero suggestions AND zero loads across the window. Mark deprecated with date + reason (see `DEPRECATED.md` convention in `meta-improvement`), or schedule one adoption test before final removal.

## Step 6: Persist and feed the loop

1. `memory_store` the table (tag `skill-usage`, project-scoped) so the next measurement has a baseline.
2. Hand the `needs-refresh` and `prune` rows to `meta-improvement` - it owns the evolution/archive loop.
3. If a skill is suggested but never loaded, the fix is usually the **description** (the LLM's only pre-load view of the skill) - tighten it, don't rewrite the body.

## Failure modes

- **One session is not a trend.** A single session with zero loads proves nothing; measure across a window (e.g. a week) before pruning.
- **Absence of evidence ≠ evidence of absence.** No counter hit can mean the skill was never relevant, not that it is bad. The honest tag is "unvalidated", not "useless".
- **Don't prune on a whim.** Rotation is scheduled, not one-off: prune → mark deprecated with date + reason → keep the file as reference until the next pack republish.
