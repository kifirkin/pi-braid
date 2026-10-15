<!-- status: current -->

# pi-braid-skills

Skill pack for the [pi](https://github.com/earendil-works/pi) coding agent. This workspace (`packages/skills`) ships **only** markdown content - one `SKILL.md` per skill - with no shipped code and no runtime dependencies. It carries the **on-demand** set for per-project loading; the always-available core skill set ships with `pi-braid` (`packages/core/skills`). Its `test/` directory holds the frontmatter contract test and is not shipped. Pi loads each `SKILL.md` through its skill discovery mechanism and uses the frontmatter (`name`, `description`) to decide when to invoke a skill.

## Install

```bash
pi install npm:pi-braid-skills
```

Or register the workspace in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["file:~/pi-braid/packages/skills"]
}
```

## What this does not do

- It ships no code and no runtime dependencies - only `SKILL.md` markdown.
- It does not decide when a skill runs. pi's discovery and the model select from each skill's
  `description` frontmatter.
- It does not add tools to the session; skills are instructions, not capabilities.

## Activation preconditions

- pi must support skill discovery (this package declares `pi.skills`).
- The workspace registered under `packages`, or installed with `pi install`.

## What's here

Each skill carries its own `validated:` freshness date (when that skill was last reviewed, so the dates differ per skill); the `verdict:` field (DEPRECATE / IMPROVE) records the outcome of the skills-usage review. The field's full enum (DEPRECATE / IMPROVE / KEEP / MOVE / UNVALIDATED) is enforced by the contract test; the values in use here reflect the on-demand set this pack carries today. Links point at each skill's current home: `skills/…` in this pack, `../core/skills/…` in the core package, and `v2raytun-reconnect` as a machine-local skill with no in-repo path.

| Skill                                                                                                                           | Verdict     | What it does                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`adversarial-engagement`](skills/adversarial-engagement/SKILL.md)                                                              | IMPROVE     | Break through stuck interactions. Five tools - incongruity, structural irony, world-building, binary-trap evasion, label-contradiction probes - for forcing genuine computation when the obvious move is being deflected. |
| [`agent-testing`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/agent-testing/SKILL.md)                   | KEEP        | Test agent behavior programmatically: pi RPC-mode event parsing, Python/JS test harness patterns, benchmark comparisons.                                                                                                  |
| [`braid-reference`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/braid-reference/SKILL.md)               | UNVALIDATED | Braid's own doc index: roots, the owning doc per domain (context policy, timers, workers, telegram, prompt, memory, skills, release, health, extensions/polyfill), the gaps, and the doc gates.                           |
| [`code-refactoring`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/code-refactoring/SKILL.md)             | IMPROVE     | Move files, rename symbols, and update imports at scale with ast-grep (`sg`) and the TypeScript compiler. Absorbed `code-search` (merged 2026-08-16).                                                                     |
| [`code-search`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/code-search/SKILL.md)                       | MOVE        | Search-tool selection for code work: ast-grep (`sg`) vs ripgrep for search, refactoring, and codemods.                                                                                                                    |
| [`design-system`](skills/design-system/SKILL.md)                                                                                | IMPROVE     | Author a `DESIGN.md` brand identity file: design tokens, color/typography/spacing/component scales, enforcement workflow.                                                                                                 |
| [`documentation`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/documentation/SKILL.md)                   | IMPROVE     | Analyze a repository and generate architecture documentation, README.md, or a full documentation ecosystem.                                                                                                               |
| [`dox`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/dox/SKILL.md)                                       | KEEP        | Maintain the AGENTS.md hierarchy - agent-maintained living documentation tree with pre-edit walk and post-change update.                                                                                                  |
| [`healthcheck`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/healthcheck/SKILL.md)                       | IMPROVE     | Agent self-diagnostic: validate tools and capabilities, clean up stale processes.                                                                                                                                         |
| [`herdr-topology`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/herdr-topology/SKILL.md)                 | KEEP        | Deep Herdr topology guidance: workspace/tab/pane model, opaque IDs, agent lifecycle, orchestrator field procedures (fresh restart, staged-prompt verification, pane hygiene).                                             |
| [`meme`](skills/meme/SKILL.md)                                                                                                  | DEPRECATE   | Generate static memes programmatically for X via Canvas API and browser CDP; animated/collaged GIFs moved to pi-looping-clanker.                                                                                          |
| [`meta-cognition`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/meta-cognition/SKILL.md)                 | KEEP        | Close the loop on every action - observe, evaluate, adapt, persist. Signal-to-action mappings for enforcement whisper families.                                                                                           |
| [`meta-improvement`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/meta-improvement/SKILL.md)             | KEEP        | Create new skills, run self-improving experiments, and measure skill performance.                                                                                                                                         |
| [`misdirection-audit`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/misdirection-audit/SKILL.md)         | UNVALIDATED | Classify misdirected work from a placement scan, domain-literal grep, and prompt-capture diff; one ledger row per instance, recurrence promotes a class to a gate.                                                        |
| [`paper-writer`](skills/paper-writer/SKILL.md)                                                                                  | IMPROVE     | Structure LaTeX-based ML research papers for arXiv - IMRaD, academic tone, methodology, result interpretation.                                                                                                            |
| [`placement-discipline`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/placement-discipline/SKILL.md)     | UNVALIDATED | The placement workflow: name the layer, keep domain facts out of shared layers, the required `## Placement` report section, the ledger, and the tamper-test habit.                                                        |
| [`pi-reference`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/pi-reference/SKILL.md)                     | KEEP        | Complete reference for pi's architecture, configuration, and internals.                                                                                                                                                   |
| [`probe-evaluation`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/probe-evaluation/SKILL.md)             | UNVALIDATED | Design and score behavioral A/B probes so a null is informative: pre-registered rubric and decision rule, control-arm sanity, blinding, power, Wilson intervals and Fisher exact.                                         |
| [`release-pipeline`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/release-pipeline/SKILL.md)             | IMPROVE     | Generic local npm release pipeline for braid packages: build, pack, install to local registry, verify.                                                                                                                    |
| [`research`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/research/SKILL.md)                             | KEEP        | Research topics, verify facts, and find information online - web search, direct page fetching, fact-checking, literature review.                                                                                          |
| [`skill-usage`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/skill-usage/SKILL.md)                       | KEEP        | Measure which skills are actually loaded/read/suggested - per skill and per session. The adoption-measurement instrument feeding `meta-improvement`.                                                                      |
| [`socratic-irony`](skills/socratic-irony/SKILL.md)                                                                              | DEPRECATE   | Wit/irony writing craft - Schopenhauer's incongruity, voice archetypes, the ethical perimeter; backed by `_shared/engagement-fundamentals.md`.                                                                            |
| [`software-engineer`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/software-engineer/SKILL.md)           | KEEP        | Universal protocol for any coding task: analyze, decompose, execute, verify. Debugging, implementation, and code review.                                                                                                  |
| [`subagent-orchestration`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/subagent-orchestration/SKILL.md) | KEEP        | Coordinate multi-agent work: spawn workers, manage lifecycles, signal between agents, transfer context, handle errors.                                                                                                    |
| [`subagent-verification`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/subagent-verification/SKILL.md)   | IMPROVE     | Verify changes by spawning an isolated subagent before merging.                                                                                                                                                           |
| [`tone-quality`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/tone-quality/SKILL.md)                     | KEEP        | Apply four diagnostic dimensions (directive density, cognitive reasoning density, voice artifacts, epistemic calibration) when writing any text.                                                                          |
| [`twitter`](skills/twitter/SKILL.md)                                                                                            | DEPRECATE   | Post replies and check bot responses on X via browser automation.                                                                                                                                                         |
| `v2raytun-reconnect`                                                                                                            | UNVALIDATED | Check and restore a dropped v2RayTun (DataBridges) macOS VPN tunnel rootlessly via the app's own deep links. Machine-local skill; not shipped in this pack.                                                               |
| [`visual-creator`](skills/visual-creator/SKILL.md)                                                                              | IMPROVE     | Create production-quality visuals - UI, game assets, brand materials, illustrations. Pairs with `visual-validator`.                                                                                                       |
| [`visual-validator`](skills/visual-validator/SKILL.md)                                                                          | IMPROVE     | Rigorous visual validation with designer-level critique and actionable fixes with measurable deltas.                                                                                                                      |
| [`voice-replies`](https://github.com/kifirkin/pi-braid/blob/main/packages/core/skills/voice-replies/SKILL.md)                   | UNVALIDATED | Send Telegram VOICE replies via edge-tts (RU/EN/HE) → ffmpeg ogg/opus → Bot API `sendVoice`.                                                                                                                              |

How to read the verdict:

- **KEEP**: accurate as written; use it as-is.
- **IMPROVE**: accurate but with a known gap; a revision is planned.
- **UNVALIDATED**: shipped without a completed review pass. Usable, but weigh its claims like any unverified content.
- **DEPRECATE**: superseded or withdrawn; retained for reference only.
- **MOVE**: merged or relocated into another skill; the file is a redirect.

> **Restored 2026-09-07.** `herdr-topology`, `code-search`, `meme`, `socratic-irony`, and
> `twitter` - culled or merged in the 2026-08-16 research round - were relocated back into the
> pack by owner directive (latest bytes from the installed 0.1.1 pack; `code-search` ships as a
> redirect stub). Originals remain reachable in git history. Their `verdict:` values are the
> audit values in each `SKILL.md`; restoration did not change them.

Shared reference files (not skills, not in the catalog):

- [`_shared/engagement-fundamentals.md`](skills/_shared/engagement-fundamentals.md) - philosophical and compositional foundations backing `adversarial-engagement`.

## Installation

This package is loaded by pi. Two ways:

### As a local path

Add the skills workspace to your pi settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": ["~/.pi/agent/pi-braid/packages/skills"]
}
```

### From the monorepo

`packages/skills` is one of the five pi-braid workspaces. Register the
workspace path explicitly (pi does not auto-discover npm workspaces):

```json
{
  "packages": [
    "file:~/pi-braid/packages/core",
    "file:~/pi-braid/packages/skills"
  ]
}
```

See the root [`README.md`](https://github.com/kifirkin/pi-braid/blob/main/README.md) for the full workspace map.

Pi discovers the skills in `skills/` automatically (see `package.json` → `pi.skills`).

## The contract

Every file in this repo must obey four rules. They're enforced by the monorepo CI (`.github/workflows/ci.yml` - doc status, doc drift, deps, private-data scan, typecheck, tests).

The rules:

1. **Content-only.** No `.js`, `.ts`, `.mjs`, or `.cjs` files anywhere. Skills are markdown.
2. **No private data.** No absolute filesystem paths, usernames, API keys, internal-only URLs, or env-var secret values in any committed file. The scanner enforces this.
3. **No project-specific content in `SKILL.md`.** Use placeholders (`TARGET_BOT`, `MY_HANDLE`, `<path>`, `<repo-url>`) for anything that names a specific engagement, target, user, or local layout. <!-- doc-ref-exempt: placeholder convention named by the rule -->
4. **Frontmatter required.** Each `SKILL.md` must start with `---` and include at least `name` and `description`.

See [`AGENTS.md`](AGENTS.md) for the full set of local contracts.

## Releases

Releases are cut from the monorepo; the published pack contains `skills/` only (markdown). No scripts live in this package.

## How this relates to pi-braid

`packages/skills` is the skill workspace of the pi-braid monorepo:

| Package                                | Role                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/core`                        | The metacognitive extension suite (memory, enforcement, cognitive, self). Code + its own skills. |
| **`packages/skills`** (this workspace) | Content-only skill pack. Lightweight, no runtime deps.                                           |
| `packages/contrib`                     | Code-only extension modules (browser, diff, …). No skills.                                       |
| `packages/providers`                   | Venice (agent-zero proxy) provider + multi-key ring.                                             |
| `packages/telegram`                    | Bidirectional Telegram channel.                                                                  |

## License

MIT. See [`LICENSE`](LICENSE).
