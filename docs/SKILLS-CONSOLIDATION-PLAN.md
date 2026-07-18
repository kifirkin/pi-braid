<!-- status: forward-looking -->

# Skills Consolidation Plan

**Status:** Planned (pre-execution). Target: one session.
**Problem:** 24 skills scattered across 3 packages with no organizing principle.
**Goal:** All skills in `pi-braid-skills`, no `skills/` folder in `pi-braid` or `pi-braid-contrib`.

---

## Current Layout

| Package | Skills | Location |
|---------|--------|----------|
| `pi-braid` (v0.3.0) | 7 | `skills/` in repo root |
| `pi-braid-contrib` (v0.1.0) | 8 | `skills/` in repo root |
| `pi-braid-skills` (v0.1.0) | 9 | `skills/` in repo root |

### pi-braid (7 skills)
```
agent-testing/    SKILL.md (7613 bytes) — agent behavior testing
healthcheck/      SKILL.md (1811 bytes) — diagnostic
meta-improvement/ SKILL.md (4824 bytes) — skill writing
pi-reference/     SKILL.md (3859 bytes) — pi SDK reference
software-engineer/SKILL.md (2796 bytes) — coding procedures
subagent/         SKILL.md (18898 bytes) — pi subagent spawning
tone-quality/     SKILL.md (10432 bytes) — writing quality
```

### pi-braid-contrib (8 skills)
```
code-refactoring/ SKILL.md (5469 bytes) — code restructuring
code-search/      SKILL.md (2608 bytes) — search tool selection
documentation/    SKILL.md (3525 bytes) — doc generation
dox/              SKILL.md (4021 bytes) — AGENTS.md hierarchy
openspec/         SKILL.md (7733 bytes) — spec writing
process-control/  SKILL.md (4027 bytes) — long-running processes
research/         SKILL.md (5425 bytes) — web research
vcs-tools/        SKILL.md (3094 bytes) — version control
```

### pi-braid-skills (9 + _shared)
```
_shared/                      engagement-fundamentals.md
adversarial-engagement/       SKILL.md (16405 bytes)
design-system/                SKILL.md (16491 bytes)
meme/                         SKILL.md (5976 bytes)
paper-writer/                 SKILL.md (10658 bytes)
socratic-irony/               SKILL.md (13696 bytes)
twitter/                      SKILL.md (14967 bytes)
visual-creator/               SKILL.md (18442 bytes)
visual-validator/             SKILL.md (5212 bytes)
```

---

## Why Consolidate

1. **Discoverability** — user can't see all available skills at a glance; they're hidden across package boundaries
2. **Maintenance** — adding a skill requires deciding *which* package, an irrelevant choice
3. **Updates** — a skill living in braid requires a braid release to update
4. **Installation** — users need 3 packages for "all skills" when they should need 1
5. **Precedent** — ponytail model: one repo, one `skills/` directory, consumed by any infrastructure

---

## Target Layout

```
pi-braid-skills               ← ONLY package with skills/
  skills/
    _shared/engagement-fundamentals.md
    adversarial-engagement/SKILL.md
    agent-testing/SKILL.md
    code-refactoring/SKILL.md
    code-search/SKILL.md
    design-system/SKILL.md
    documentation/SKILL.md
    dox/SKILL.md
    healthcheck/SKILL.md
    meme/SKILL.md
    meta-improvement/SKILL.md
    openspec/SKILL.md
    paper-writer/SKILL.md
    pi-reference/SKILL.md
    process-control/SKILL.md
    research/SKILL.md
    socratic-irony/SKILL.md
    software-engineer/SKILL.md
    subagent/SKILL.md
    tone-quality/SKILL.md
    twitter/SKILL.md
    vcs-tools/SKILL.md
    visual-creator/SKILL.md
    visual-validator/SKILL.md
  AGENTS.md
  README.md
  LICENSE

pi-braid                      ← NO skills/ folder
  src/
  docs/
  scripts/
  package.json (no "pi.skills", no "skills/" in files)

pi-braid-contrib              ← NO skills/ folder
  browser/
  codebase/
  diff/
  ...
  package.json (no "pi.skills", no "skills/" in files)
```

---

## Step-by-step Execution

### Step 1: Move pi-braid skills → pi-braid-skills

**Source:** `pi-braid/skills/*/` → **Target:** `pi-braid-skills/skills/*/`

Move 7 directories:
- `agent-testing/`
- `healthcheck/`
- `meta-improvement/`
- `pi-reference/`
- `software-engineer/`
- `subagent/`
- `tone-quality/`

**Command:**
```bash
cd ~/projects/agents/pi-braid
for d in skills/*/; do
  mv "$d" "../pi-braid-skills/skills/$(basename $d)"
done
```

### Step 2: Move pi-braid-contrib skills → pi-braid-skills

**Source:** `pi-braid-contrib/skills/*/` → **Target:** `pi-braid-skills/skills/*/`

Move 8 directories:
- `code-refactoring/`
- `code-search/`
- `documentation/`
- `dox/`
- `openspec/`
- `process-control/`
- `research/`
- `vcs-tools/`

**Command:**
```bash
cd ~/projects/agents/pi-braid-contrib
for d in skills/*/; do
  mv "$d" "../pi-braid-skills/skills/$(basename $d)"
done
```

### Step 3: Remove skills/ from pi-braid package.json

**File:** `pi-braid/package.json`

Changes:
- `"pi.skills"` — remove the `"skills/": ["./skills"]` entry entirely
- `"files"` — remove `"skills/"` from the list

**Verification:** After removal, `pi-braid` no longer ships any skills. The prompt-builder will show `Resources: 0 skills` unless pi-braid-skills is also installed.

### Step 4: Remove skills/ from pi-braid-contrib package.json

**File:** `pi-braid-contrib/package.json`

Changes:
- `"pi.skills"` — remove `"./skills"` from the `"skills": ["./skills"]` list
- `"files"` — remove `"skills/"` from the list

### Step 5: Update pi-braid-skills package.json

**File:** `pi-braid-skills/package.json`

The `"pi.skills"` config already points at `./skills`. No change needed — the new directories are under `skills/` so they're auto-discovered.

May need to verify no file-size limits or other constraints.

### Step 6: Verify pi-braid-skills AGENTS.md

**File:** `pi-braid-skills/AGENTS.md`

Check if any rules reference specific skill names in a way that assumes a subset. Likely no change needed since AGENTS.md is about repo conventions, not enumerating skills.

### Step 7: Update pi-braid docs

**File:** `pi-braid/docs/SETUP.md`

- Update the "Skills" section (currently lists 7 skills as "braid ships 7 skills")
- Update the companion packs table — merge the two companion pack rows into one
- Update the combined install example to remove `pi-braid-skills` and `pi-braid-contrib` as separate lines (they're now all in one pack, though the contrib extensions still need their own package)

**File:** `pi-braid/AGENTS.md`

- Update any reference to skills location
- The "Build & Test" section mentions nothing skills-specific, should be fine

### Step 8: Remove empty skills/ directories

After moves:
- `pi-braid/skills/` — should be empty or contain only `.DS_Store`. Remove.
- `pi-braid-contrib/skills/` — same. Remove.

**Verify:**
```bash
ls -la pi-braid/skills/        # should not exist or be empty
ls -la pi-braid-contrib/skills/ # should not exist or be empty
```

### Step 9: Test skill discovery

```bash
# In pi-braid-skills, verify all 24 skills are present
cd ~/projects/agents/pi-braid-skills
find skills/ -name "SKILL.md" | wc -l
# Expected: 23 (24 skills - 1 _shared which has no SKILL.md)
# Actually: _shared/engagement-fundamentals.md is not a skill, it's a shared fragment.
# So 23 SKILL.md files.
```

### Step 10: Verify typecheck + tests

```bash
cd ~/projects/agents/pi-braid
npm run typecheck && npm test
# Expected: 42/42 tests pass, typecheck clean
```

---

## What the prompt-builder does — and doesn't — need to change

The prompt-builder is **skill-agnostic**. It never references specific skill paths or names. The `<available_skills>` block and Resources section are built from whatever `skillCount` and `SkillEntry[]` pi provides at runtime.

**No code changes needed in:**
- `skills-section.ts` — reads skills from pi's skill loader
- `resources-section.ts` — reads skills from passed context
- `instance-composition.ts` — passes through skill data
- `index.ts` — orchestrates sections
- `inspect.ts` — only strips the skills block on request

**Only documentation changes.**

---

## Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| User has pi-braid without pi-braid-skills → no skills loaded | Medium | Medium | Update SETUP.md prominently; include error-check in session-start discoverability |
| File moved during active session | Low | Medium | User needs to re-add pi-braid-skills to settings.json; existing sessions unaffected |
| _shared/engagement-fundamentals.md not loaded as skill | None | None | _shared/ has no SKILL.md, it's a fragment included by reference from other skills. No action needed. |
| In-flight runnable check in a skill references braid paths | Low | Low | Skills are markdown-only; no code references. Subagent skill mentions spawning pi processes which works from any package. |

---

## Migration for users

After consolidation, users who have this in their `settings.json`:

```jsonc
{
  "packages": [
    "file:~/pi-braid",
    "file:~/pi-braid-skills",
    "file:~/pi-braid-contrib"
  ]
}
```

Will have **all 24 skills** automatically (pi-braid-skills already covers everything, contrib covers extensions). No settings change needed if they already have all three packages.

Users with only `pi-braid` installed will see **0 skills** until they add `pi-braid-skills`.

---

## Post-consolidation roadmap

After this consolidation is done, the next phase is:

1. **pi-braid-lib design** — clean infrastructure library (logger, extension-state, event-names, braid-paths, model-resolver, language-hint, workspace-snapshot)
2. **Input polisher extraction to contrib** — now depends on pi-braid-lib existing
3. **// braid: debt markers** — adopt ponytail's ceiling+upgrade-trigger convention on enforcement handlers
4. **Publish pi-braid-skills** — npm package with semantic versioning, matching ponytail's distribution model