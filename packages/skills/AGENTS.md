<!-- status: current -->

# pi-braid-skills: Standalone skill pack for pi

This is a **content-only** package. Each skill is a single `SKILL.md` file. It carries the on-demand set for per-project loading; the core set ships with `pi-braid` core (`packages/core/skills`).

## Local contracts

These four rules are non-negotiable. They're enforced by the root `.github/workflows/ci.yml`.

### 1. Content-only: no code in shipped content

- **Allowed:** `SKILL.md`, `README.md`, `AGENTS.md`, `LICENSE`, `package.json`, `.gitignore`, anything under `.github/`.
- **Forbidden in shipped content:** `.js`, `.ts`, `.mjs`, `.cjs`, `.jsx`, `.tsx`, package `dependencies` / `devDependencies`, `node_modules/`, build artifacts (`dist/`, `build/`).
- **Tests:** `test/` is excluded from `files` and not named by `pi.skills`, so it is never shipped or loaded; it may hold `.mjs` test scripts that use only Node built-ins.
- **Why:** Pi loads this package via path or git URL; any code added would duplicate work that belongs in a dedicated extension package. If a skill needs code, it should move to a sibling repo (e.g. `pi-looping-clanker`).

### 2. No private data

Never commit:

- Absolute filesystem paths (`/Users/<name>/...`, `C:\Users\...`, `/home/<you>/...`) and private home layouts (`~/projects/<private>/...`)
- Usernames (yours or anyone else's)
- API keys, tokens, bearer headers, env-var values with secret-y names
- Internal-only URLs (private proxies, internal staging environments)
- References to specific private projects by name

The rule is enforced by `check-doc-links` (`packages/core/scripts/check-doc-links.mjs`): it rejects a home path outside the product (`~/.pi/...`, `~/pi-braid/...` are the only home paths a doc may name) and any in-repo reference that does not resolve. There is no separate private-data scanner: the earlier one matched `/Users/<name>/` and `/home/<name>/` but not the tilde form, so it gave a green build while the leak shipped. If you find a new leak shape, extend that resolver or fix the writing habit at the source, and never lean on a scanner as the guarantee.

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

Every `SKILL.md` must start with `---` and include at least `name` and `description`:

```markdown
---
name: my-skill-name
description: "One sentence the LLM uses to decide when to invoke this skill. Be specific and decision-oriented."
---

# My Skill Name

Body...
```

A `triggers:` array in the frontmatter is allowed (used by some skills). Any number of additional frontmatter fields is fine as long as they're YAML-valid.

## Adding a new skill

1. `mkdir -p skills/<skill-name>`
2. Write `skills/<skill-name>/SKILL.md` with frontmatter.
3. Run `node packages/core/scripts/check-doc-links.mjs` before committing: it rejects private home paths and in-repo references that do not resolve.
4. Push - CI will re-check on every PR.

## Removing a skill

Delete the directory. No other steps needed.

## Cross-repo conventions

When a skill needs executable code, extract it to its own package rather than adding code here. The pattern:

- **Skill content** → a sibling repo under `/Users/<you>/projects/agents/<name>-<topic>/skills/<skill>/SKILL.md`
- **Executable code** → `<name>-<topic>/src/*.mjs` (or `.ts`)
- **The skill ships with both** - pi discovers skill content; the executable parts are called manually or via `npm run` scripts

See the separate `pi-looping-clanker` repo for a worked example.
