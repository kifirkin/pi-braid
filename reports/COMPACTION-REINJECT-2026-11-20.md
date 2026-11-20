# Curated context return after compaction

Status: in progress. Base: `main` at `2c0694c`. Worktree: `/tmp/wt-reinject`, branch
`worker/w1020/compaction-reinject`.

## Why

Pinned in the task brief: arXiv 2608.11242 measures roughly 17% instruction survival through
summarization. A compaction summary that says "follow the project rules" is a paraphrase of a
rule, and a paraphrase is not a rule: the model acts on a summary of the contract instead of the
contract. Today the harness detects the loss and asks the model to re-read:

- `packages/core/src/extensions/core/skills-tool/auto-inject.ts:1721` `stepCompactionReload` reads
  each landed body, compares its 120-char whitespace-flattened head (`bodySignature`,
  `auto-inject.ts:1637`) against the model-visible projection (`activeContextText`,
  `auto-inject.ts:1681`), and on a miss sends one steer line (`formatReloadPayload`,
  `auto-inject.ts:1646`) that names the file and asks for a re-read.
- The line is counted in `recordSkillReload` (`auto-inject.ts:1349`) into `SkillStats.reloads`
  (`auto-inject.ts:1261`).
- The landed-body population is `state.reload.landed` (name to resolved path), written by
  `noteBodyLanded` (`auto-inject.ts:1692`) from a detected `read` of a `SKILL.md`.

A read-after-prompt costs a turn and depends on the model choosing to spend it. This change makes
the harness put the curated bytes back itself, deterministically, in the same cycle that dropped
them.

pi exposes the paths: a landed compaction entry carries
`details: { readFiles: string[]; modifiedFiles: string[] }`
(`@earendil-works/pi-coding-agent/dist/core/compaction/compaction.d.ts:13`). Braid's own cut paths
write the same shape (`compaction.ts:1011`, `compaction.ts:1048`), so the field is populated on
every compaction path, native and braid-synthesised.

## What the harness owes the reading model

1. Curated, not complete: instruction files and the skill bodies this session actually delivered.
   Never a file that merely shares an extension with something read.
2. Bodies whole, files addressed by path. No truncation of instruction text, ever: a body that
   does not fit is named as a pointer, not cut.
3. One delivery per class per compaction, silent when there is nothing to return.
4. The two skill outcomes stay distinguishable: `returned` when the harness put the body back,
   `reloads` when it only asked for a re-read.

## Inventory

Deterministic, from the two records that exist:

- Instruction files: entries of `entry.details.readFiles` whose basename is `AGENTS.md`,
  `CLAUDE.md` or `DESIGN.md`. Read order preserved, deduplicated by resolved absolute path.
- Skill bodies: `state.reload.landed`, minus any whose signature is still in the projection.

The `readFiles` set is a record of what the session read, so it is the right filter. Scanning the
filesystem for instruction files would return files the session never opened, which is the
"complete instead of curated" failure.

## Two owners, no ordering dependency

The compaction curator (context-manager) returns instruction files. The skills extension returns
the skill bodies, because it already owns the landed map, the presence test and the file itself.

Rejected alternative: one sender for both classes. It is the tidier story, and it was the first
plan, but it makes the skills delivery depend on the context-manager extension being loaded (the
reload line works today with context-manager disabled), and it makes correctness depend on the
registration order of two `session_compact` handlers. Two owners whose populations do not overlap
need neither dependency.

Rejected alternative: return the bodies inside the existing reload line as extra text. That
replaces a one-line steer with a multi-kilobyte whisper whose counter (`reloads`) would then mean
two different things.

## Curator module

`packages/core/src/extensions/memory/context-manager/handlers/compaction-curator.ts`

- `CURATED_INSTRUCTION_FILES` = `["AGENTS.md", "CLAUDE.md", "DESIGN.md"]`.
- `CURATED_CONTEXT_MAX_CHARS = 24_000`: about 6k tokens of instruction text, which is what a
  compaction has just freed and far below any reserve. A cap that could re-inflate the context to
  its pre-compaction size would trade a real problem for a worse one.
- `collectCuratedSections({ readFiles, cwd })` returns `{ sections, omitted }` where a section is
  `{ path, text }` and `omitted` is `{ path, reason }` with reason `over-budget` or `unreadable`.
  Pure: it reads files and decides, it never sends.
- `formatCuratedText(sections, omitted)` builds the one message body. A heading per file carries
  the path; the file's bytes follow unchanged. Omitted files are named in one trailing line.
- `reinjectCuratedContext(pi, ctx, entry)` is the side-effecting wrapper: collect, format, send
  once through `sendTrackedMessage` (the house funnel, so the flood cap and the envelope apply),
  and return what it delivered. Silent when no section survives.

Budget rule: take sections in order while the running total fits; the first file that does not fit
is omitted and every later file is omitted too, so the result is a prefix rather than a scattered
selection. This is what keeps "bodies are whole" true without a per-file cap that would silently
cut the largest instruction file, which is usually the most load-bearing one.

## Call site

`packages/core/src/extensions/memory/context-manager/handlers/compaction.ts:1881`
`registerSessionCompactHandler`, after the queued owner message is parked and before the overflow
flags clear. `event.compactionEntry.details.readFiles` is the inventory; no entry or no details
returns early.

## Skills extension

`packages/core/src/extensions/core/skills-tool/auto-inject.ts`

- `SkillStats` gains `returned` beside `reloads`, and `emptySkillStats` gains the same field, so a
  counter cannot land in one write path and be missed in another.
- `recordSkillReturned(ctx, name)` moves `returned` only where a body was actually accepted.
- `stepCompactionReload` becomes: read the body, keep the existing refusals (no landed body,
  signature still present, already announced, unreadable file), then
  - body within `FULL_BODY_MAX_CHARS` and the send accepted: the message carries the body whole,
    with one header line naming the skill and the file, `customType` still `skills-reload`;
  - body over that cap: the existing pointer line, counted `reloads`.
    The two counts move on accepted sends only, which is the existing discipline in this function.
- No durable field is added: `recordDurable`'s vocabulary, the on-disk usage store, its schema
  check and the `skill_stats` documentation are a wider change than this behaviour needs, and the
  session counter is what the two outcomes are read from.

## Tests

One fixture, `packages/core/test/runtime/lib/test-compaction-reinject.mjs`, six cases:

1. Instruction inventory: `readFiles` mixing three instruction files with source files returns
   exactly the three, bodies byte-identical to disk, read order preserved.
2. Deduplication and resolution: the same file named relatively and absolutely returns once.
3. Skill body returned: a delivered body absent from the projection arrives whole in the message
   and moves `returned`, not `reloads`.
4. Present body: a body still in the projection produces no message and no counter move.
5. Ceiling: an instruction file past the budget is omitted and named, and no returned section is a
   truncation of its file.
6. Silence: no details, or a `readFiles` with no instruction file, sends nothing.

## Gates

Planned, in order: targeted `node --test` for the new fixture and the two existing neighbours
(`test-skill-reload-after-compaction.mjs`, `test-skill-stats.mjs`), `npm run typecheck`,
`npm run lint`, `npm run format:check`, then `npm run ci:check` alone as the final step.

Which run is mine: recorded under Evidence below when it runs. A full `ci:check` was active over
`main` at the start of this session; nothing else ran alongside my final gate.

## Open questions

1. `returned` is session-scoped while `reloads` is also durable. A reader comparing the two series
   across sessions sees one and not the other. Making `returned` durable means touching the usage
   store schema, the `skill_stats` reply and its documentation; that is a separate decision, not a
   silent one.
2. The curator's cap is a character count. Token estimation would be more honest and the repository
   already has `estimateMessagesTokens`; it is also more code and a second opinion about the same
   quantity. Left as a character ceiling with the reasoning above.

## Evidence

Targeted, before the full chain:
`node --test test/runtime/lib/test-compaction-reinject.mjs` 6 pass, 0 fail.
`node --test test/runtime/core/test-skill-reload-after-compaction.mjs
test/runtime/core/test-skill-stats.mjs test/runtime/core/test-skill-fullbody.mjs` 19 pass, 0 fail.
`npm run typecheck -w packages/core`, `npm run lint`, `npm run format:check`,
`check:placement --strict`, `check:extension-api --strict`, `check:instruction-strings`,
`check:markers`, `check:prose-punctuation`, `check:suite-coverage`, `check:docs`,
`check:doc-drift`, `check:doc-index`: clean.

Full chain, and which run is mine. All three `ci:check` runs below are mine, each alone on the
machine, the suite lock free before each start:

1. Run 1: `check:source-claims` refused. Not a code defect: `docs/LOCAL_DEV.md` states how many
   fixtures the core runner counts (390) and how many import `node:test` (149), and one new
   fixture moves both. Re-derived from the commands the doc names (391 and 150) and repaired in
   the same commit as the work.
2. Run 2: 390 of 391 core fixtures passed. `lib/test-scan-population-line.mjs` refused because
   `check-doc-links` scanned 120 tracked markdown files against a census of 119: this report was
   the untracked one. Tracking the report removes the disagreement, which is also what makes the
   deliverable survive the worktree.
3. Run 3: the final run, recorded below.

Runs 3 results: recorded after the run, in the commit that follows it. The only difference between
the tree that run 3 read and the tree this file states is the text of this Evidence section.
