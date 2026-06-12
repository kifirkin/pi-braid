# Session Handoff — 2026-06-12 (prompt-builder skills fix)

Follow-up to `docs/SESSION-HANDOFF-2026-06-12.md`. This session fixed two
related bugs in the prompt-builder skills section.

## Last commit on main

`dfca48ec` — `fix(prompt-builder): use systemPromptOptions.skills and drop fragile relevance scoring`

Working tree clean. 32/32 tests pass, typecheck clean, build clean.

## What got done

One commit, one file, 75 insertions / 169 deletions:

**`src/extensions/core/prompt-builder/index.ts`**

1. **Skills were missing.** `reconstructSkillsSection` was calling
   `loadSkills({ skillPaths: [], includeDefaults: true })` directly. That
   only walked `~/.pi/agent/skills/` and `<cwd>/.pi/skills/`, so it missed
   all 22 skills registered by the `pi-braid-skills` package via the
   `pi.skills` field in its `package.json`. (And any other package
   skills, `.agents/skills`, CLI `--skill` paths, settings.json skills.)

   Fix: source skills from `event.systemPromptOptions.skills`, the fully
   resolved list the SDK's resource loader already produced. This is the
   canonical pattern documented in pi's `extensions.md` for
   `before_agent_start` ("Use it when your extension needs to make deep,
   informed changes to the system prompt while respecting user-provided
   configuration"). Verified in SDK source: `agent-session.js:645`
   `const loadedSkills = this._resourceLoader.getSkills().skills;` flows
   directly into `systemPromptOptions.skills`.

2. **The relevance-scoring machinery was broken.** `SKILL_TRIGGERS` +
   `SKILL_RELATIONS` + `scoreSkillRelevance` + `MAX_VISIBLE_SKILLS = 8`
   together hid ~15 skills behind a `*N more skills are available*`
   hint, but the hidden skills had no `filePath` in the prompt — the
   agent could not actually `read` them. The hint was a lie.

   Fix: drop the whole relevance/cap/relations experiment. Now
   `formatSkillsWithLineCounts` emits every resolved skill (filtered
   only by `disable-model-invocation`, matching native) alphabetically
   with its full `filePath`, line count, and section headings. The
   agent can `read` any of them on demand.

### Removed

- `SKILL_TRIGGERS` map (17 skills × 5-7 keywords)
- `SKILL_RELATIONS` map (7 entries)
- `scoreSkillRelevance` function (50 lines)
- `MAX_VISIBLE_SKILLS = 8` cap
- `hiddenCount` hint
- `collectProjectContextStrings` orphaned helper (32 lines)

### Kept (the braid enhancements worth keeping)

- Per-skill `<lines>` and `<sections>` metadata — useful for the agent
  to size up a skill before reading the full file
- FilePath-keyed cache for the formatted section (invalidated on
  `RESOURCES_DISCOVER` event so `/reload` and session replacement pick
  up new skills)

## Verification record

| Check | Result |
|-------|--------|
| `npm run typecheck` | exit 0, clean |
| `npm run build` | exit 0, dist generated |
| `npm run test` (32 tests) | 32/32 passed |
| Compiled `dist/extensions/core/prompt-builder/index.js` | shows new code path |
| SDK source confirms `event.systemPromptOptions.skills` carries the resolved list | `agent-session.js:645` |
| End-to-end simulation | 23 skills (22 from `pi-braid-skills` + 1 user) appear with full paths, vs 1 before |
| pi docs quote backing the canonical pattern | `extensions.md` `before_agent_start` section |

## Inert config that could be cleaned up later

`~/.pi/agent/skills-config.json` lists 16 "activeSkills" and a
`latentCapabilities` block. It is NOT referenced anywhere in
`src/` (grep returned zero hits), so it's harmless dead data. Safe to
delete if you want a tidy home dir; the prompt-builder never read it.

## Follow-up for the next session (low priority)

The user mentioned wanting the **whole prompt-builder deeply understood
and refactored** later. The current handler still constructs identity,
tools, project-context, L1 environment, OpenSpec context, contrast
mode, INTERACTION_STYLE, appendSystemPrompt, date, and cwd from
scratch on each `before_agent_start`. The proper simplification (which
follows the same canonical pattern we used for skills) is to take
`event.systemPrompt` as the base and surgically replace only the
braid-specific sections. Out of scope for this session, but the
approach is proven by the skills fix.

## Quick-start for the next session

When you open a fresh chat:

1. **git log --oneline -3** — see commit `dfca48ec` on top of `455223e3`
2. **This file** — current state
3. Start a pi session and ask it `cat ~/.pi/agent/skills/ | head` then
   `cat <one-skill-path>` — confirm the new system prompt lists all
   22 skills from `pi-braid-skills` with full paths
4. Optionally: read this file's "Follow-up" section if the user wants
   to proceed with the prompt-builder deep refactor
