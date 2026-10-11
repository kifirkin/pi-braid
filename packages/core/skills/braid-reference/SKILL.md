---
name: braid-reference
description: "Find braid's own documentation: context policy and compaction, timers and wakes, workers and the orchestrator registry, the Telegram channel, prompt and discipline rules, memory stores, the skills catalog, release and install paths, health maintenance, extensions and the polyfill. Use when a question is about braid internals, before editing braid, or when a braid behavior needs its owning doc named instead of guessed."
validated: 2026-10-08
verdict: KEEP
---

## trigger: "braid docs, pi-braid documentation, braid context policy, braid compaction bands, braid timers and wakes, braid workers, orchestrator registry, braid telegram channel, braid prompt rules, braid memory stores, braid skills catalog, braid release, braid install paths, braid health maintenance, braid extension, polyfill"

# Braid Reference

Where braid's own knowledge lives, and which file owns which question. Two readers use this: an agent answering a question about braid, and a contributor about to edit braid. For the second, the owning `AGENTS.md` chain is a binding contract - read it before the first edit (the `dox` skill defines that tree).

## Step 1: resolve the roots

Braid ships as separate packages, and docs live under each package root. Find the roots once, then read every path below as `<package root>/<path-after-the-package-name>`.

| Root       | Contains                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `core`     | `docs/`, `src/`, `skills/` (the core skill set), `AGENTS.md`, `README.md`, `TOOLS.md` (checkout) |
| `skills`   | the on-demand pack: `skills/<name>/SKILL.md`, `README.md`, `AGENTS.md`                           |
| `telegram` | `README.md`, `docs/`                                                                             |

This file sits at `<core>/skills/braid-reference/SKILL.md`, so the core root is two levels up. The core skill set ships with the core package; the `skills` package root carries only the on-demand pack; machine-local skills such as `v2raytun-reconnect` live in `~/.pi/agent/skills/`.

```bash
# 1. core root — two levels above this SKILL.md
cd <skill-dir>/../..

# 2. pack root — monorepo layout first, then the installed layout
ls ../skills/skills/ 2>/dev/null || ls ../pi-braid-skills/skills/ 2>/dev/null

# 3. every registered package path, whatever the layout
grep -A10 '"packages"' ~/.pi/agent/settings.json
```

In the monorepo the roots are `packages/core`, `packages/skills`, `packages/telegram`. In an installed tree the npm packages sit side by side under one `node_modules/` (for example `~/.pi/agent/local-packages/node_modules/pi-braid` next to `pi-braid-skills`).

## Step 2: the topic index

Paths below are checkout paths: strip the leading `packages/<name>/` and prepend that package's root. The `Shipped` column says whether the file is in the published tarball (`npm`) or exists only in a checkout (`checkout`).

| Topic                                                                             | Doc                                                                                                                                                                                                                                                                                                                                                                            | Shipped  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| What braid is, install paths, module toggling, storage                            | `packages/core/README.md`, `packages/core/docs/SETUP.md`                                                                                                                                                                                                                                                                                                                       | npm      |
| First walkthrough: anatomy of an extension, writing one                           | `packages/core/docs/BEGINNERS.md`                                                                                                                                                                                                                                                                                                                                              | npm      |
| Context policy: window, reserve, bands, caps, offload                             | `packages/core/docs/CONTEXT-POLICY.md`                                                                                                                                                                                                                                                                                                                                         | npm      |
| Context map: contexts, owners, seam registry, where state lives                   | `packages/core/docs/CONTEXT-MAP.md`                                                                                                                                                                                                                                                                                                                                            | npm      |
| Context automation: proposals, policy engine, cooldown                            | `packages/core/src/extensions/memory/context-lifecycle/AGENTS.md`                                                                                                                                                                                                                                                                                                              | npm      |
| What compaction loses and which guards exist                                      | `packages/core/docs/COMPACTION-LOSS-INVESTIGATION.md`                                                                                                                                                                                                                                                                                                                          | npm      |
| Timers, wakes, wake retry, wake-delivery alerts                                   | `packages/core/src/extensions/scheduling/timer/AGENTS.md`                                                                                                                                                                                                                                                                                                                      | npm      |
| Workers, the `orchestrate` tool, locks, merge verification                        | `packages/core/skills/subagent-orchestration/SKILL.md`                                                                                                                                                                                                                                                                                                                         | npm      |
| Telegram channel: live update, pause control                                      | `packages/telegram/docs/live-update.md`, `packages/telegram/docs/pause-control.md`                                                                                                                                                                                                                                                                                             | npm      |
| Telegram package overview: tools, env vars, components; turn-complete auto-notify | `packages/telegram/README.md`, `packages/telegram/docs/turn-complete-notify.md`                                                                                                                                                                                                                                                                                                | npm      |
| System prompt composition, identity, whisper sections                             | `packages/core/src/extensions/core/prompt-builder/AGENTS.md`                                                                                                                                                                                                                                                                                                                   | npm      |
| Enforcement: whisper cap, dedup, nudges, verification judge                       | `packages/core/src/extensions/enforcement/AGENTS.md`                                                                                                                                                                                                                                                                                                                           | npm      |
| Memory stores: episodes, semantic, heuristics                                     | `packages/core/src/extensions/memory/three-memory-stores/AGENTS.md`, `packages/core/src/extensions/memory/AGENTS.md`                                                                                                                                                                                                                                                           | npm      |
| Skills: the core set and the on-demand pack, catalog, adding a skill              | `packages/skills/README.md`, `packages/skills/AGENTS.md`                                                                                                                                                                                                                                                                                                                       | npm      |
| Release, publish, install paths, upstream pi updates                              | `packages/core/skills/release-pipeline/SKILL.md`, `packages/core/scripts/update-pipeline.mjs` (plan -> pins -> publishes -> runtime update), `packages/core/scripts/publish-local.mjs` (one target per run, core by default; republish every package whose content changed), `packages/core/docs/LOCAL_DEV.md`, `packages/core/docs/SETUP.md`, `packages/core/CONTRIBUTING.md` | npm      |
| Health maintenance, checkpoints, self-repair                                      | `packages/core/src/extensions/self/health-maintenance/AGENTS.md`                                                                                                                                                                                                                                                                                                               | npm      |
| Extension loading, manifest, module toggles, the polyfill                         | `packages/core/AGENTS.md`, `packages/core/src/AGENTS.md`, `packages/core/src/extensions/core/AGENTS.md`                                                                                                                                                                                                                                                                        | npm      |
| Every tool and command braid adds                                                 | `packages/core/TOOLS.md`                                                                                                                                                                                                                                                                                                                                                       | checkout |
| Roadmap (forward-looking) and history                                             | `packages/core/docs/ROADMAP.md`, `packages/core/docs/HISTORY.md`                                                                                                                                                                                                                                                                                                               | npm      |

Related skills in the core set: `dox` (the AGENTS.md tree), `placement-discipline` (which layer owns a fact), `release-pipeline` (the local publish flow), `skill-usage` (adoption measurement), `pi-reference` (pi core, the layer braid extends).

## Gaps: no shipped doc yet

Do not improvise around these; say the topic has no shipped doc and name the substitute.

| Topic                                                                   | Where to look instead                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Worker registry internals: admission, lifecycle, result verdicts, locks | source headers in the core package: `packages/core/src/lib/orchestrator/`, `packages/core/src/extensions/orchestrator/index.ts` |
| Compaction defaults inside pi-core (reserve math, keep-recent window)   | not braid's to own: the `pi-reference` skill, then pi-core's own compaction doc                                                 |
| Research reports, audits, worker reports                                | a separate braid-docs repo, NOT shipped with any package: background, never the contract                                        |

## Reading a long doc without flooding the session

1. Headings first: `grep -n '^#'` on the file, then `read` with `offset`/`limit` for the section you need.
2. Oversized tool results are flushed to disk by braid itself (capture cap 262144 chars, `braid.context.toolResultSizeCap`): the transcript keeps a stub naming `<braid home>/offload/<sessionId>/<toolName>-<toolCallId>.txt`, and retrieving it costs one `read` - no re-fetch, nothing lost.
3. A file too big to read whole (PDF, docx, HTML) goes through `document_parse`; when the text layer is missing or the layout is the point, `document_screenshot` renders one page as an image.
4. Never pull a whole doc into context to answer a question about one section of it.

## Before you edit braid

- Read every `AGENTS.md` on the route from the repo root to the path you touch, then update the nearest owner after the edit.
- A doc change is a status decision: `current` (describes the code as it is), `forward-looking`, `aspirational`, or `historical`. `npm run check:docs` fails on a missing or unknown marker; `npm run check:doc-drift` fails when a `current` doc names an API the code does not have.
- Every file path in this skill resolves and carries an authority marker - `<!-- status: … -->` for docs, frontmatter for a `SKILL.md` - and `npm run check:doc-index` fails when one stops resolving, ships where the table says checkout, or loses its marker. A doc that is not in the topic table has no address; add the row in the same commit as the doc.
