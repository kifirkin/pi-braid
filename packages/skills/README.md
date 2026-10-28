# pi-braid-skills

<!-- status: current -->

Eight skills for the [pi](https://github.com/earendil-works/pi) coding agent: research papers, brand
systems, visual work, and writing that has to land. Install once, usually per project, and the agent
opens a skill when the task matches it.

Skills are instructions, not tools. Installing this pack teaches the agent eight procedures; it
changes what the agent knows how to do, not what it can do.

## Install

```bash
pi install npm:pi-braid-skills
```

The pack is usually wanted per project: add the same spec to that project's `.pi/settings.json`
(the declaration pi reads after you trust the project) rather than to your user settings.

Running from a checkout instead? Register the workspace path in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["file:~/pi-braid/packages/skills"]
}
```

## What you get

| Skill                    | What it does                                                                                                                                         | Use it when                                                                                                              | Status     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `adversarial-engagement` | Five probes that force a real answer out of a scripted one: incongruity, structural irony, world-building, binary-trap evasion, label contradiction  | A reply keeps getting deflected or templated, and the exchange is going in circles                                       | Usable     |
| `design-system`          | Authors a `DESIGN.md` brand system: tokens for color, type, spacing and components, plus the consistency workflow                                    | You are building a brand system, writing a `DESIGN.md`, or enforcing design consistency across a project                 | Usable     |
| `paper-writer`           | Structures and writes LaTeX papers for ML venues: IMRaD, abstract strategy, related work, figures, tables, citations, camera-ready conventions       | You are drafting or revising a NeurIPS, ICML, ICLR or ACL submission, an arXiv preprint, or a workshop paper             | Usable     |
| `visual-creator`         | Creates visuals that survive critique: design principles, color, typography, layout, brand identity, and the create, analyze, validate, improve loop | You are building a UI, designing game assets, making brand material, or producing a visual that needs coherent reasoning | Usable     |
| `visual-validator`       | Design critique with measurable, actionable fixes: sprite assets, game screenshots, UI designs, image quality                                        | You need a visual audited, a UI reviewed, or an image quality call                                                       | Usable     |
| `meme`                   | Static canvas memes with Impact captions, posted through the browser clipboard                                                                       | You want a one-off static image meme                                                                                     | Deprecated |
| `socratic-irony`         | Wit craft: incongruity as the engine, voice archetypes, dramatic structure, and where to stop                                                        | You are writing a roast, satire or sharp critique and need a sharper line                                                | Deprecated |
| `twitter`                | Posts replies on X through browser automation and checks whether the bot answered                                                                    | You are working an X thread with a browser session                                                                       | Deprecated |

Three of the eight are marked deprecated in their own frontmatter: `meme` points at a separate
project for animated work, `socratic-irony` overlaps the `tone-quality` skill, and `twitter` has no
successor. They stay in the pack because their technique sections are useful reference; they are
not what the pack is for.

## How a skill gets used

pi reads each `SKILL.md` frontmatter `description` and decides from that whether to open the file.
You do not select a skill. Two consequences are worth knowing: a skill fires on its description,
not on its folder name, and you can always ask for one by name ("use the paper-writer skill").

## Limits

- pi only. These are `SKILL.md` files; another agent's loader may ignore them.
- No code, no tools, no settings keys. The pack is instruction text.
- Three skills are deprecated (see the table). The other five are the ones to install for.

## License

MIT. See [LICENSE](LICENSE).

## For pack maintainers

Every `SKILL.md` opens with frontmatter: `name` matches its directory, `description` is non-empty
and under pi's 1024-character limit, `validated` is an ISO date, and the `verdict:` field (DEPRECATE
/ IMPROVE) records the last review outcome. The monorepo's contract test enforces those fields
before a release; the tarball does not carry the test. Shared fragment files live in `skills/_shared`
and carry no `SKILL.md`.

Releases are cut from the monorepo: the tarball carries `skills/`, this README, `AGENTS.md`,
`LICENSE` and `package.json`.
