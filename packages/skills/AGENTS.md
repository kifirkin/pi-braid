<!-- status: current -->

# pi-braid-skills: Standalone skill pack for pi

This is a **content-only** package. Each skill is a single `SKILL.md` file. It carries the on-demand set for per-project loading; the core set ships with `pi-braid` core (`packages/core/skills`).

## Local contracts

These four rules are non-negotiable. They're enforced by the root `.github/workflows/ci.yml`.

### 1. Content-only: no code in shipped content

- **Allowed:** `SKILL.md`, `README.md`, `AGENTS.md`, `LICENSE`, `package.json`, `.gitignore`, anything under `.github/`.
- **Forbidden in shipped content:** `.js`, `.ts`, `.mjs`, `.cjs`, `.jsx`, `.tsx`, package `dependencies` / `devDependencies`, `node_modules/`, build artifacts (`dist/`, `build/`).
- **Tests:** `test/` is excluded from `files` and not named by `pi.skills`, so it is never shipped or loaded; it may hold `.mjs` test scripts that use only Node built-ins.
- **Why:** Pi loads this package via path or git URL; any code added would duplicate work that belongs in a dedicated extension package. If a skill needs code, it should move to a sibling package of its own.

### 2. No private data

Never commit:

- Absolute filesystem paths (`/Users/<name>/...`, `C:\Users\...`, `/home/<you>/...`) and private home layouts (`~/projects/<private>/...`)
- Usernames (yours or anyone else's)
- API keys, tokens, bearer headers, env-var values with secret-y names
- Internal-only URLs (private proxies, internal staging environments)
- References to specific private projects by name

The rule has two instruments. `check-doc-links` (`packages/core/scripts/check-doc-links.mjs`) rejects a home path outside the product (`~/.pi/...`, `~/pi-braid/...` are the only home paths a doc may name) and any in-repo reference that does not resolve. `test/content-rules.mjs` reads every shipped file and rejects a `pi-<slug>` project name with no `PROJECTS` row, and rejects a row marked private on sight: shipped text may only name a project a reader of this package can open. Naming a new project means adding a row that says where a reader finds it, with the reason; that table is the audit of why every name is public. Neither instrument is a guarantee of clean prose: if you find a new leak shape, extend the fixture or fix the writing habit at the source.

### 3. No project-specific content in `SKILL.md`

Skills are shared across users and projects. Use placeholders for anything user-, engagement-, or environment-specific:

| Concrete value                    | Use this instead                             |
| --------------------------------- | -------------------------------------------- |
| `/Users/<your-name>/projects/...` | `<path>`, `<absolute path>`, `<repo-url>`    |
| `@twitter_handle`                 | `@TARGET_HANDLE`, `@MY_HANDLE`               |
| `6/22/2026` (specific date)       | drop the date, or describe relative time     |
| Reference to engagement X         | drop; skills are domain-general              |
| Reference to private project Y    | drop; mention the technique, not the project |

The `description` field is especially load-bearing - it's what the LLM sees when deciding whether to invoke the skill. Keep it specific to the technique, not to a particular task.

### 4. Frontmatter required

Every `SKILL.md` must start with `---` and carry four contract fields plus the trigger list. The example below passes `node test/skills-contract.mjs` verbatim:

```markdown
---
name: my-skill-name
description: "Use when <the situation the agent is in and the artifact it needs>: <what this skill changes about the output, in one clause>. Not for <the neighbouring job, named>. Under 1024 characters, no trigger list in here."
validated: 2026-10-27
verdict: UNVALIDATED
triggers:
  - <a phrase a user would actually type>
  - <a second phrase, at least two>
---

# My Skill Name

Body...
```

Rules the contract test enforces, each with the failure it prevents:

- `name` equals the directory, in `a-z0-9-`; a mismatch means the catalog and the folder disagree.
- `description` is at most 1024 characters and contains a situation clause (`Use when ...`); a topic list never fires.
- `triggers` holds at least two phrases, each at most 64 characters, and no phrase is shared with another skill: the matcher keeps a bounded list per skill, and a duplicated phrase makes the choice ambiguous.
- No `Triggers:` tail in the description. The reader drops a tail longer than 200 characters and reports nothing, so a tail is a declaration that silently does not exist.
- `validated` is an ISO date, `verdict` is one of the five values.
- `status: deprecated` requires a `successor` and a description that opens with "Deprecated:" - a deprecation that reads as a live instruction is not a boundary.

Any number of additional frontmatter fields is fine as long as they are YAML-valid.

## Adding a new skill

1. `mkdir -p skills/<skill-name>`
2. Write `skills/<skill-name>/SKILL.md` with the frontmatter above.
3. Run `node test/skills-contract.mjs` (it also runs `test/content-rules.mjs`), then `node packages/core/scripts/check-doc-links.mjs` before committing.
4. Push - CI will re-check on every PR.

## Removing a skill

Delete the directory. No other steps needed.

## Cross-repo conventions

When a skill needs executable code, extract it to its own package rather than adding code here. The pattern:

- **Skill content** → a sibling repo under `/Users/<you>/projects/agents/<name>-<topic>/skills/<skill>/SKILL.md`
- **Executable code** → `<name>-<topic>/src/*.mjs` (or `.ts`)
- **The skill ships with both** - pi discovers skill content; the executable parts are called manually or via `npm run` scripts

See the sibling packages for worked examples: skill content lives here, and a package that ships executable code carries its `SKILL.md` and its `src/` together.
