<!-- status: current -->

# Changelog

Curated release notes, newest first. This replaces the earlier auto-generated
per-commit dump (5.5k lines). The commit-by-commit record lives in git — the
public `main` is one consolidated commit since the 2026-10-12 consolidation;
the per-iteration series it replaces is archived locally (see "Repository
history" below). Milestones before the 2026-08-29 monorepo snapshot are
summarized below without per-commit references. Deep narrative history is in
[`packages/core/docs/HISTORY.md`](packages/core/docs/HISTORY.md).

Two tag roles, one namespace per package. The namespaces are enforced by
`packages/core/scripts/tag-prerelease.mjs` and `check-release.mjs`: core owns
the bare `v`, every sibling owns `<workspace>-v*`, so a tag names its package
and a tag on one line cannot block another.

- **Core** — legacy `v0.1.1 … v0.39.0`, then the `0.40.0` line: iteration tags
  `v0.40.0-main.N` (package.json `0.40.0-main.N`), release tag `v0.40.0`
  (package.json `0.40.0`). Ordering: `v0.39.0 < v0.40.0-main.1 < v0.40.0`.
- **Providers** — `1.0.x` line; iteration tags `providers-v1.0.x-main.N`,
  release tag `providers-v1.0.x`.
- **Telegram** — `0.1.x` line; iteration tags `telegram-v0.1.x-main.N`,
  release tag `telegram-v0.1.x`.
- **Skills** — `0.2.x` line; iteration tags `skills-v0.2.x-main.N`, release tag
  `skills-v0.2.x`.
- **Contrib** — `0.1.x` line; iteration tags `contrib-v0.1.x-main.N`, release
  tag `contrib-v0.1.x`.

Nothing is retagged retroactively. The legacy core names (`v0.1.4`, `v0.2.0` …)
stay core history and no longer occupy a sibling's release name: past a bare
`v`, the tag path reads only the package's own namespace.

## Repository history

`main` carries a single consolidated commit as of the 2026-10-12 consolidation.
The per-iteration series it replaces (380 commits) is kept outside this
repository, in a local-only ref (`refs/archive/main-pre-squash`) plus an
all-refs bundle; a public clone has the consolidated commit only, so a checkout
that needs line history needs access to that local archive. This file and
[`packages/core/docs/HISTORY.md`](packages/core/docs/HISTORY.md) are the
reader-facing record; the tag scheme above applies unchanged.

---

## Core — 0.42.1 (2026-10-27: the package carries its changelog, a publish checks what it served, and two measured friction classes lose their cause)

### Core

- **The changelog ships with the package.** `npm`'s `files` allowlist is package-relative and the repository keeps
  one changelog at its root, above `packages/core`, so no allowlist entry could name it and an installed `pi-braid`
  carried no changelog at all. A `prepack` step now stages that file at the package root and a `postpack` step removes
  it, so the artifact carries the released tree's own notes rather than a second copy that can drift. The staged path
  is gitignored, so an interrupted pack cannot leave a checkout reading as dirty, and the bytes in the tarball are the
  bytes of the root file.
- **A publish now compares what it served.** `pack-compare.mjs` unpacks two tarballs, normalises the one field that
  cannot be reproducible (`build-info.json`'s `packedAt`) and reports what else differs, with three exit codes so
  "equal", "different" and "could not read" stay distinguishable. `publish.yml` runs it after the publish and after
  the release entry, tag runs only, and **warns** rather than fails: a byte comparison would be permanently red here
  (two packs of one tree differ in hash and size), while the content comparison is exact. The step becomes blocking
  when it has a record of being right on this repository.
- **The provenance writer must be last.** A lifecycle step of the package's own (the changelog staging above) may now
  run before the writer, and the checker identifies the writer by the script that reaches the shared generator rather
  than by whichever `node` script the body runs first. A body that still leaves a command after the writer is refused,
  because anything after it can mutate the record it computed.
- **A missed path names the cheaper instrument.** One steer line per turn, in the whisper family that already
  carries error bursts, when a tool result shows the path did not exist: it names the path and the instrument that
  would have found it (`ls`, `find`, `explore_paths`). Measured before this change: missing-path failures were the
  largest single tool class in this machine's transcripts, two thirds of them in sessions that never listed a tree.
- **Two schemas stop making the model guess.** `list_skills` treats a paging-only call as `action: "list"` instead of
  failing, and argument validation now names the values it would have accepted (the `think` tool's enum and its
  required `decision` field were the two most frequent victims) instead of only saying validation failed.

### Also in this line

- **The session scanner can name its window.** `session-scan.mjs` gained `--since <ISO>`, filtering on each session's
  own recorded start rather than the file's modification time, and every report now prints the cutoff it applied. A
  resumed session's mtime moves while its first prompt does not, which is why a release-window measurement could not
  be re-cut to the same population before this.

## Core — 0.42.0 (2026-10-25: the skills catalog is in the prompt, and work that moves re-points it)

### Core

- **The skills catalog is rendered in the prompt** - the `skills-loading` section
  now lists every visible skill as one `- name: description` row, with the read
  path derived from the skills' own file paths, so a domain match is in front of
  the model instead of behind a tool call it has to decide to make. A thin
  opening prompt carries no domain vocabulary for the keyword scorer, and the
  measured consequence on the class of sessions those prompts open is a skill
  load rate of zero. The section measures 8,903 bytes / 2,226 estimated tokens on
  this repository's 22-skill pack at this repository's own 58-character skills
  path, and 11,366 bytes / 2,842 tokens on a live 27-skill two-pack catalog (a
  55-character install path plus the user-global skills directory), against 756
  bytes / 189 tokens before it: braid suppresses pi's own catalog, so the floor is
  an addition of 8,147 to 10,610 bytes on every request rather than a swap. Both
  are renders, not constants. The section states the catalog's own read root, so
  the byte count follows that root one byte per character — the 55-character
  install path renders 8,900, a 66-character local-packages path 8,911, and a
  path 43 characters longer renders 43 bytes longer — and the worked examples it
  derives from the active tool set move it too: a different tool representing a
  family the section already illustrates is a byte (8,902 with `herdr_agent`
  where this render names `herdr_layout`), and a family joining or leaving the
  active set is a whole example.
- **Work that moves re-points the catalog** - a drift trigger in the `tool_result`
  handler fires one steer line when the session's own read/edit/write calls
  accumulate entries in a new work area, so a catalog rendered against one
  directory re-points at itself when the work moves. Its bounds (two entries,
  twelve calls between fires, three per session, quiet for the same window after
  a skill surface) sit beside the text they point at.
- **The floor has an instrument** - `packages/core/test/runtime/core/session-scan.mjs`
  scans session transcripts and reports the thin-prompt read rate, drift latency,
  and the bytes of skill surface injected per session; the floor text, the drift
  sequence, the instrument and its twin labelled cases are each pinned by a test.

## Core — 0.41.2 (2026-10-25: the runtime floor is Node 24, and a red file prints its own output)

### Core

- **The declared runtime floor is Node 24** - `engines` promised `>=22.19.0` in
  all six manifests while the release ran on the 24 line, so the gate that
  reports red and the gate that decides a release were never the same runtime.
  The floor is `>=24.0.0` in the six manifests, the `ci.yml` matrix runs the line
  `publish.yml` uses, and three requirement tables, two sentences of the telegram
  README and one comment in its client follow it. `node:sqlite` says it is
  experimental, once per process at import, on every 24 release before 24.15, so
  on the floor `fleet status` answered correctly and still wrote a warning nobody
  documented: `journal.mjs` withholds that one warning for the length of its
  import, and is now the fleet's only importer of the module. The CI job's
  timeout goes from 15 to 30 minutes, the allowance the release path already
  gives the same chain.
- **A failing test file prints its own output** - the runner named a red file and
  its totals and dropped the assertion text with the child's streams, so reading
  a red run meant repeating it, through a container on CI. A failing or timed-out
  file now prints the end of its own output under its line, bounded to 40 lines
  and 4,000 characters, with the number of lines it left out and the command that
  prints the rest.

## Core — 0.41.1 (2026-10-25: delivery by the queue section, a lease column nothing reads, a store version)

### Core

- **A queued message is retired only by the section that carried it** - the
  carrier tested the body anywhere in the prompt, so a charter that repeated the
  instruction word for word was read as a delivery even with the queue section
  dropped. Each prompt builder now returns the section it appended together with
  that section's ids, and the carrier checks the section's own sentence and each
  message's line against the prompt. A turn kind that appends nothing carries
  nothing, and the same plant leaves the row `recorded` with no delivery columns.
- **The lease keeps `expires_at`, and no code reads it** - `liveLease` filtered on
  state alone, so a lease a minute past its expiry still kept a second supervisor
  off the node. Making the column authoritative would hand one node to two
  drivers, since a legitimate tick ran 32.7s under write contention against the
  30s the column is written with. It stays nullable and unwritten because the
  schema-1 build names it in its lease INSERT, so dropping it would leave every
  store this build writes unopenable by a rollback.
- **The store records the shape it has and refuses a newer one** - a store
  carrying a schema version above this build's is refused with one sentence,
  rather than opened and failing inside a statement.
- **A deferral is recorded beside the store** - a maintenance pass that met the
  write lock deferred in memory only, the tick then threw `database is locked`
  from the sweep after it, and an overdue ask stayed open with nothing an operator
  could read. Both passes now share a bounded wait and record the deferral in
  `store-deferred.json`, the one place writable while the journal is not; the
  first pass that gets through copies it into the journal and removes the file,
  and `status` prints the deferral it can read and exits non-zero on a store it
  cannot open, so the reason the fleet is idle survives the state that produced
  it.

## Core — 0.41.0 / Telegram — 0.1.6 (2026-10-24: the supervisor fleet ships)

### Core

- **The fleet ships as a command** - `packages/core/scripts/fleet` was in the
  repository and in no tarball: the manifest's allowlist stopped at `dist`,
  `src`, `docs`, `skills` and four top-level files, so the supervisor and its
  four operator commands existed only in a checkout. The allowlist now names
  `scripts/fleet/**`, and a `bin` entry puts them on PATH as `pi-braid-fleet`,
  named for the package because a bare `fleet` can be shadowed by unrelated
  tooling. That entry exposed an entry-point test that could only be true in a
  checkout: npm links a bin as a symlink, so `process.argv[1]` keeps the link's
  spelling while `import.meta.url` names its target, which had made an installed
  command load, match nothing and exit 0 in silence. The guide is
  `packages/core/docs/FLEET.md`.
- **The duplicated-effect guard refuses before the call runs** - a tool call whose
  effect may already have applied is refused, within the run being resumed; a
  queued message is consumed only when a turn's prompt carried it; and tier A is
  written only from a driver's own delivery event rather than guessed at, so a
  steer that was not delivered leaves its message to the next turn.
- **The control channel and the asks** - the control channel keeps its ownership
  straight in and out, an expired ask is claimed and its default queued in one
  transaction, a live owner keeps its turn, and an idle supervisor leaves.
- **A drain waits out the store lock instead of throwing** - the journal installs
  its busy handler before anything that can block, and the drain records what it
  did when it gets through.
- **Packaging is held to a real artifact** - `test-pack-ships.mjs` packs the
  manifest through `npm pack`, reads the tarball's file list, extracts it outside
  the repository, and drives the four commands and a supervisor start from there.

### Telegram

- **The owner's reply reaches the envelope** - `IncomingOwnerMessage` carries an
  optional `replyTo`: the replied message id, whether that message was ours or the
  owner's, and a one-line excerpt capped at 120 characters, read once from the
  update the poller already holds and inherited by every delivery variant (plain
  text, photo, voice, document, and text+document). The envelope renders it
  directly under the sender line, as prose the agent can quote back rather than a
  field to parse, and the excerpt comes from `reply_to_message` itself rather than
  a `getMessage` round trip, so the receive path gains no new failure mode. A
  missing or malformed reply field degrades the reference and leaves the delivery
  untouched.

## Core — 0.40.6 (2026-10-23: version truth, post-compaction resume, the journal, fleet v0, self-tooling fixes)

### Core

- **The instance line names the running pi-core** - it read `pi-core vunknown` on
  every session: the version came from a filesystem walk that resolves the running
  entrypoint and searches its ancestors, and the managed install keeps that
  entrypoint as a plain shell shim in `bin/` with the package in a sibling
  `install/releases/<version>/node_modules` subtree, so the walk always
  exhausted. It now reads the `VERSION` export, which names the library braid is
  loaded into; the walk still supplies the binary, the package folder, and a
  fallback version when the export is absent. The same pass re-derives the
  extension-API guard's frozen surface from the installed declarations (seven
  members it lacked) and removes a fabricated `ExtensionContext` augmentation
  that declared members existing in neither version, inviting calls that would
  compile and do nothing.
- **The journal** - an append-only record a replacement seat can act on. The
  writer owns the sequence number, assigned under the scratchpad's cross-process
  store lock, the write time and the provenance, and refuses a decision without
  its reason, a constraint without an expiry, or an evidence list that is empty
  and not flagged unverified; supersession appends, leaving the earlier line
  byte-identical. A separate checker with its own parser fails per structural
  defect, and with `STALE` when a task was closed with no entry for it. The path
  is derived once, so the writer, the checker and the session-start pointer
  cannot name different files.
- **Deferred compaction obeys one turn-boundary rule** - the rule that decides
  whether a deferred `ctx.compact()` may abort a run at a turn end existed twice,
  as a local predicate and as an inline copy, and both read a missing stop reason
  as loop-done. It moves to `lib/events/turn-boundary.ts`, an allow-list over
  `stopReason`; an unreadable or unrecognized boundary parks, and a caller holding
  no boundary keeps the prior contract. The heartbeat's hand-off into the arm path
  had no witness (deleting the argument left the suite green), so a fixture now
  drives the real scheduler handler and reddens on exactly that deletion.
- **The post-compaction resume** - `resume.json` is filled from the scratchpad
  checkpoint log, and the resume wake stays above the whisper cap that had been
  swallowing it.
- **Fleet v0** - a journal-backed supervisor with four commands and a crash drill
  that measures duplication, in `packages/core/scripts/fleet`.
- **The presend guard joins by normalized id and can cap request bytes** - the
  guard looked a request's model id up under the catalog's own spelling, so a
  route sending `deepseek-v4.1-flash` against a catalog id `deepseek-v4-1-flash`
  resolved to no window, and the arm that exists to stop a doomed send never ran
  for that model. The index answers exact ids first and a lowercased dash-form key
  second, dropping a normalized key that two catalog models would answer
  differently with. A declared `maxRequestBytes` adds a byte arm over the
  serialized payload, and one warn line per request above `reportBytesAbove`
  carries the byte count, the model id and whether a cap exists.
- **One compact instance line** - the line repeated the working directory pi
  injects natively as `<cwd>` and had lost the fields that made older blocks
  useful. It carries the loaded braid install root, the session model and
  provider, the PID, the session id and true skill and memory counts under a
  320-byte cap. The rule is written at the renderer and pinned by fixtures: the
  system prompt is a cached prefix, so only process-stable facts belong there, and
  the volatile statistics stay in the `system_info` tool.
- **Three self-tooling reports that were untrue** - the heartbeat's verification
  counter recognised tool names, so a session whose investigation ran through
  `bash` probes counted as zero; the orchestrator's population-stamp parser
  accepted one lowercase word as a unit, so a real stamp read as unreadable and a
  merge ran with no recorded population; and the turn-end hygiene latch re-armed
  against a 50% bar while the arm that fired was 45%, so one whisper re-injected
  on every turn and the percent ladder never rendered from 45% upward.
- **Reach before the read** - `list_skills` rows carry the price of the read they
  name (lines, bytes, chars, estimated tokens, the file's headings with line
  numbers, and the section count). The heading parse is fence-aware, because 45
  of the pack's 293 heading-shaped lines sit inside code blocks, and measurements
  are memoized on mtime and size, with read failures left uncached.
- **A local voice path, measured** - `scripts/voice-spike/` holds the recorder,
  the resident synthesiser and the batch harness that time the speech path end to
  end on this machine: native throughout (`whisper.cpp`, AudioQueue), because
  neither torch nor onnxruntime installs on Intel macOS.

## Core — 0.40.5 (2026-10-20: package discovery metadata)

### Core

- **The published manifest carries the discovery keyword** - `pi-coding-agent` is
  what npm-driven package directories index on. It had been added to the repo root
  manifest, which is private and never publishes, so the shipped `pi-braid` package
  carried `pi-package` but not this one while all four sibling packages carried both.
  The keyword now lives in `packages/core/package.json`, the manifest the registry
  receives. No code, no behavior, no API change.

## Core — 0.40.3 / Contrib — 0.1.2 (2026-10-20: blank tool inputs, npm: entry resolution)

Two packages moved since the 0.40.2 train. Skills, providers and telegram are
unchanged, and the publish workflow skips them as already on the registry.

### Core

- **npm-pinned extensions are discovered again** - `discoverTopLevelExtensions`
  resolved `npm:` specs only inside the managed install tree of the pi runtime,
  so a workspace whose extensions are pinned by `npm:` name (the supported
  install path) resolved nothing and braid reported no top-level extensions at
  all. The managed root is now searched ahead of the global root and the global
  root is kept as the fallback; a live probe went from 0 discovered to 9 against
  real settings.
- **Blank tool inputs are read as absent, and blank required inputs are refused
  by name** - a client that emits every schema key sends `""` for the unused
  ones. In eight tools that blank was consumed as a value: a blank `limit` and a
  blank `minAge` converted to `0` and disabled the cap they were meant to apply,
  a blank `tag` was stored and rendered as an empty group, a blank `claimId`
  became the tracking key for the rest of the session, a blank `summary` recorded
  an unfindable task as done, a blank `output` answered "no topic drift" for a
  check that never ran, blank `explore_paths` hypotheses produced an empty report
  instead of a usable error. Optional selectors now fall back to their documented
  defaults and required ones are refused with the parameter named.
- **Schema pointers and source contracts stop binding to line numbers** - the
  schema generator resolved each row's evidence on one exact line, so any edit
  above that line failed the build for a key that had not changed; three rows had
  already drifted and `release:check` was blocked behind them. The named line is
  tried first and the file is searched after it, the evidence must still live in
  the named file, and the published `x-source` names the line it was found on.
  The browser screenshot contract asserted a constant that had moved into the
  shared resolver, and its replacement form was satisfied by the import line
  alone; it now asserts the delegation, the resolver's fallback expression and
  the shipped default.
- **Ecosystem crawlers can find the package** - the root manifest carries the
  `pi-coding-agent` keyword the sibling packages already carried, which is what
  the `pi-package` directory source indexes on.

### Contrib

- **Blank tool inputs across the contrib modules** - the browser tools, the
  codebase and diff tools and the healthcheck tool read a blank selector as a
  value, so an empty `query`, an empty path or an empty quality reached the
  implementation; each now resolves through one shared input reader that treats
  a blank field as absent. JPEG capture quality continues to default to 75.

## Core — 0.40.2 / Telegram — 0.1.5 / Providers — 1.0.6 / Contrib — 0.1.1 (2026-10-17: orchestrator close gates, npm-first docs, multi-client tunnels)

The four packages whose shipped content moved since the 0.40.1 train.
`pi-braid-skills` 0.2.2 is the first single-package release of the npm
trusted-publishing path, sequenced separately from this train (its own section
below); its outcome decides whether this section is ever tagged.

### Core

- **The release path is the publish workflow** - `CONTRIBUTING.md` step 5 and
  the `release-pipeline` skill name the tag that releases: `npm install` at the
  root after the manifest bumps, `npm run ci:check` before the tag, an annotated
  `v<core version>` published by `.github/workflows/publish.yml` through npm
  trusted publishing (OIDC, no token in any repository file), and the iteration
  tags (`v<version>-main.N`, `<workspace>-v<version>`) that never publish.
- **Orchestrator close gates** - a close's `files` row that carries a
  population stamp is read against the tree at the revision the stamp names,
  and a count below that revision's tracked-entry census refuses the merge
  before any ref moves; a recorded production write is refused unless the same
  close records every preflight piece its class names; every gate row is read
  for well-formedness at close, in shadow mode by default under the new
  `braid.orchestrator.closeGateWellFormedness` setting. The tool surface prints
  the population comparison beside the outcome line.
- **Provenance in the tarball** - `prepack`/`postpack` write `build-info.json`
  (package name, packed version, commit sha and branch, dirty flag, pack time)
  into every artifact and remove it afterwards, and each manifest's `files`
  allowlist ships it. `packages/core/docs/LOCAL_DEV.md` states the reading rule: `sha` plus
  `dirty == false` is what says a tarball is a clean checkout of a named
  commit.
- **Peer ranges state the pi floor** - the manifests carry `^1.2.0` for the
  `@earendil-works/*` peers and `^1.1.38` for `typebox` instead of `*`, and the
  update pipeline rewrites those ranges alongside the exact pins, so the floor
  moves with the runtime instead of drifting behind it.
- **Docs** - `CONTRIBUTING.md` leads with `pi install npm:pi-braid` (one
  command, no clone, no build) before the contributor flow; cross-package links
  label their target by repository path; the README badge states the peer rule
  instead of a stale minimum; the `TOOLS.md` document rewrites its enablement
  reference, adds a Command catalog of extension slash commands, and gains a
  `network-monitor` row naming `braid.contrib.networkMonitor`; `ROADMAP.md`
  records the per-package tag namespaces and the `tunnel-control` verdict.

### Telegram

- **HTML parse mode auto-selects only on a tag Telegram parses** -
  `hasHtmlTags` now requires a well-formed tag whose name is in Telegram's tag
  set, so a body carrying `<n>` or `<b/>` goes out as plain text, where those
  characters reach the reader literally, instead of selecting HTML and being
  refused whole as an unsupported start tag.
- **Docs and manifest** - the README leads with the `pi install` one-liner, and
  the manifest carries the provenance pair and the peer ranges above.

### Providers

- **README and manifest only** - no source file changed in this release: the
  delta is the README's `pi install npm:pi-braid-providers` one-liner and the
  manifest's version, peer ranges (`*` to `^1.2.0`), provenance pair and
  `build-info.json` entry. The release spends a version number on prose and
  manifest metadata rather than on source.

### Contrib

- **`network-monitor` speaks two clients** - the v2RayTun-only probe becomes a
  client-adapter split (`clients.ts`, `tunnel.ts`), so the watcher reconnects
  v2RayTun over app deep links and Happ over its network-extension profile
  (`scutil --nc stop|start`); `outageThreshold` (default three consecutive
  failed probes) keeps one failed probe from toggling the tunnel, and the
  `braid.contrib.networkMonitor` block is re-read while the extension runs.
- **The per-module off switch holds on both loading paths** - the new shipped
  `module-toggle.ts` reads `braid.contrib.<name>` inside each extension's own
  factory, because pi loads the `pi.extensions` entries directly and never runs
  the bundle; only a literal `false` disables, and an absent key or an
  unreadable settings file reads as enabled.
- **Docs and manifest** - the README's module table names the second client and
  its settings table gains the `networkMonitor` row and the literal-`false`
  rule; the manifest carries the provenance pair and the peer ranges above.

## Skills — 0.2.2 (2026-10-17: pack provenance and README repairs)

- **Provenance in the tarball** — `prepack`/`postpack` write `build-info.json` (name, version, full and short commit sha, branch, dirty flag, pack time) into the pack and remove it after, and the manifest's `files` list ships it, so a packed `pi-braid-skills` names the commit it was packed from.
- **Cross-package README paths** — the prose that says where sibling skills live labels them by their repository path (`packages/core/skills/…`), the form the link rows and the other READMEs already use, instead of the checkout-relative `../core/skills/…`.
- **`v2raytun-reconnect` becomes `tunnel-control`** — the skill gains its second and third clients (Happ, Incy; the v2RayTun arm is validated, the other two refuse until validated), and the README row carries the new name, the three-client description and the `KEEP` verdict.

## Core — 0.40.1 / Providers — 1.0.5 / Skills — 0.2.1 (2026-10-15: gallery metadata repairs)

- **Core README badge** — the pi-coding-agent minimum states `1.2.0` (the current pi line), not the stale `0.85`.
- **Cross-package README links** — links that left their own package in the `pi-braid` and `pi-braid-skills` READMEs now point at the repository on GitHub, so they resolve on the package gallery instead of breaking or landing on unrelated content.
- **Providers manifest** — `pi-braid-providers` declares an `exports` entry, matching its sibling packages.
- **Release date** — the first-public-release heading below carries the true publication date, 2026-10-15.

## Core — 0.40.0 / Telegram — 0.1.4 / Providers — 1.0.4 / Skills — 0.2.0 / Contrib — 0.1.0 (2026-10-15: first public release)

The first npm publication: all five packages go out together at the versions
above.

### Core

- **Prerelease tags come from the derivation, and a check guards the pair** —
  `packages/core/scripts/tag-prerelease.mjs` writes the annotated
  `v<derived version>` tag at HEAD, refusing a detached HEAD, a dirty tree, an
  existing tag, a name that is not a version, and a version that does not sort
  strictly above the highest existing `v*` tag. The derivation moves to
  `packages/core/scripts/lib/version-derivation.mjs`, which the publish path
  imports, so a tarball and its tag cannot disagree about the version they
  name; `release:check` joins `ci:check` and validates the tag against
  `package.json` (annotated, agreeing, ordered per semver.org 2.0.0, build
  metadata ignored). The core base moves to `0.40.0`, above the last released
  tag, and the tag scheme is the one recorded at the top of this file.
- **Vision and document tools offloaded to installed packages** — the contrib
  `vision` extension (`analyze_image`) and `read-document` extension
  (`read_document`, `render_pdf_page`) are removed. Image and document
  capabilities come from the installed `@getpipher/vision` (`describe_image`)
  and `pi-docparser` (`document_parse`, `document_search`,
  `document_screenshot`) instead. Every internal reference — the path-security
  read allowlist, the enforcement investigation/routing/probe sets, SOP
  extraction, the task-boundary signal, heartbeat verification sets, browser
  guidance, tool profiles, and the docs — points at the replacement names, and
  the now-unused `pdf-parse` dependency is dropped.
- **Role merge: maxPowerModel folds into utilityModel** — one key, one
  resolver, one auxiliary tier per chain. Every caller chain drops the
  duplicate tier: verify/hypothesize/think try the merged role first, the
  judges and claim extraction keep it as the cheap first tier, and
  `judge-budget` walks session → utility. The classifier's four
  `modelPreference` values collapse to two orders: `quality` (session first)
  and everything else (role first); `max` and `speed` stay accepted but now
  equal `balanced`. The `"max-power"` tier label leaves
  `ClassificationResult` and critic stats.
- **maxPowerModel deprecated alias** — a settings file that only carries the
  legacy key still loads it under `utilityModel` for one release, with a
  once-per-process notice; the first role write removes the legacy key in the
  same settings transaction, and `/max-power-model` set/show/clear operate on
  the canonical key.
- **visionModel deprecated alias** — `resolveVisionModel` keeps its name and
  the legacy key keeps priority for one release. Without it the chain is the
  session model when image-capable → the merged role's first image-capable,
  route-usable entry → the first available image-capable model. The
  `/vision-model` command warns on use and is removed next release.

- **pi 1.2.0 across the family** — the pinned `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` family moves
  to `1.2.0` in the root manifest and the providers package. The
  whisper-delivery branch test re-points its third-branch stub at 1.2.0's
  run-start entry and asserts that entry exists on the prototype before
  stubbing it, so the next rename is a named failure in the fixture instead
  of a stack trace from inside pi-core (`8dd7fd82`, `c6d40853`).
- **Runtime state resolves through the braid root at call time** — every
  writer that folded `os.homedir()` into a module-load constant now resolves
  `BRAID_HOME` (else `<home>/.pi/agent/braid`) per call, so a pin set after
  import is honoured; a relative or blank `HOME`/`BRAID_HOME` is refused
  with the offending variable named instead of creating state inside the
  current project. The write-decision log, episode, scratchpad, semantic,
  orchestrator lock and worker registries, checkpoints, error log, evidence
  pool, degradation state, analytics metrics, hints, workspace snapshots and
  skills-adoption stores all follow; the adherence, telemetry, tags and
  sessions sinks move under the root; the heartbeat report compares
  realpaths for its entry guard; the error-tracking listener drains its
  refused store at warn instead of surfacing an unhandled rejection; and
  readers that can miss (the error list, the semantic load, the adoption
  rollup) degrade instead of throwing (`5bbdb77f`, `eead4ff3`, `30bcb697`,
  `45066f58`).
- **Module toggles persist in braid's store** — a toggle writes
  `braid.modules` to `braidDir()/projects/<project>/module-overrides.json`
  (temp-file-plus-rename, siblings preserved) instead of creating
  `<cwd>/.pi/settings.json` in a stranger's repository. Reads merge pi's
  agent-directory settings file with braid's store, later wins per key; the
  project-scoped `braid.modules` block is no longer a source, because it is
  pi's file behind pi's project-trust gate and that answer is not available
  while extensions load (`5bbdb77f`, `eead4ff3`).
- **State paths are held by checks, not convention** — a new
  `check-write-scope` scan fails the chain on a production write whose
  target can resolve into the cwd unless the call carries a reasoned
  allowlist entry; containment children drive each package's real writers
  under a pinned `BRAID_HOME` and assert the project tree and the default
  HOME tree stay untouched; and the four copies of the braid-root rule
  (core, telegram, providers, contrib) are compared shape by shape, so one
  package's guard cannot drift from the others (`e91ca9d6`, `f14cb5ef`,
  `f029fb35`).
- **Rotation size notice lands at the turn-end flush** — while a run is
  streaming the notice is sent as a park-class steer, so it is delivered at
  the same turn end instead of queuing on the one-message-per-run-stop lane
  (median delivery latency on the session corpus was about 12 minutes, and
  most notices landed after the agent had already acted on them). An
  unresolved-advisory registry, retired by the message append events, keeps
  a second notice of the same kind from stacking, with a 30-minute TTL for a
  lost event and a clean map at session shutdown; the notice body states the
  age rule, so a header stamp older than the last `context_compress` or
  `finalize` reads as already satisfied (`5038b448`).
- **Once-per-session whisper slot claimed before the first await** — the
  guard was read before an awaited delivery batch and written after it, so
  two overlapping prompt builds both delivered every once-per-session
  whisper and a session start could see the hygiene line twice; the slot is
  now claimed synchronously at block entry (`26fd5e0f`).
- **Doc references and instruction strings are derived, then repaired** —
  `check-doc-drift` derives its subject set from the docs' inline code spans
  and resolves every strong identifier against the source, with a
  `doc-ref-exempt` annotation for deliberate mentions and recorded host and
  package names; a new `check-instruction-strings` walk of emitted string
  units fails on a tool name that is not registered, an action outside its
  tool's enum, or an action quoted for a tool with no action parameter. Both
  run inside `ci:check` and print their counts. The pre-existing findings
  were recorded as baselines (seven doc-reference rows, eleven instruction
  rows) and then repaired: the tool descriptions name
  `context_compress(action=archive)` and `context_navigate(action=...)`
  instead of the retired names, and the docs point at the live `signals.ts`
  exports, the `tool_call` event, `ClassificationResult`,
  `setGlobalLogLevel` and `typeRoots` (`195a8c89`, `199883e0`).

### Telegram

- **MarkdownV2 emphasis converts to HTML, one entity per pair** — a body
  carrying `**bold**`, `__underline__`, `~strikethrough~` or `||spoiler||`
  under `parse_mode: "Markdown"` shipped its markers literal, because the
  guard checked delimiter balance rather than dialect; the delivery format
  now rewrites balanced pairs to `<b>`, `<u>`, `<s>`, `<tg-spoiler>` and
  `<code>`, escapes HTML-reserved characters outside author markup and code
  spans, and reports a per-kind conversion count. A `__x__` pair emits `<u>`
  (it used to emit `<i>`, which no MarkdownV2 pair means); unbalanced or
  identifier-like markers stay literal; the parse_mode schema and tool
  descriptions name the legacy dialect and point at HTML; and an over-cap
  render splits to fit instead of failing at the API (`7e649f5c`,
  `22fe46e6`).
- **State root** — media and pause state move from pi's agent directory to
  `braidDir()/telegram`, with a read fallback to the pre-move files; the
  voice download, poller lock, media, pause and live-update defaults resolve
  through the same root and refuse a root that is not absolute
  (`e91ca9d6`, `f14cb5ef`).
- **Peer dependencies declared** — `@earendil-works/pi-ai` (whose `/compat`
  subpath the pinned `1.2.0` exports) and `typebox` join
  `@earendil-works/pi-coding-agent` as peers, matching core and contrib, so
  a strict-layout install resolves every value import the shipped sources
  make (`typebox` had been a devDependency only).

### Providers

- **State files refuse a root they cannot resolve** — the
  `HOME || USERPROFILE || "."` fallback is gone; a base that is not absolute
  is refused and the caller warns or stays in memory instead of writing
  beside the cwd, the presend flush skips with one warn when the root is
  underivable, and the presend root, key ring and route state resolve
  `BRAID_HOME` at call time (`5bbdb77f`, `eead4ff3`, `f14cb5ef`,
  `f029fb35`).

### Contrib

- **State paths follow the package's braid-root mirror** — observatory
  recordings, browser screenshots, the scraping profile, the reconnect lock
  and the healthcheck probes resolve through the mirror and refuse a
  relative or blank home; the healthcheck writers resolve core's live
  `healthcheckDir()` through `pi-braid/lib` instead of binding the default
  at module load, and the report CLI refuses a relative root with exit 2
  (`e91ca9d6`, `f2413cde`, `f029fb35`).
- **`pi-braid` declared as a peer** — the shipped sources import
  `pi-braid/lib` for the shared classifier, the event and session-start
  helpers, `getExtensionState` and `healthcheckDir`; the package now
  declares the dependency instead of relying on the monorepo's tsconfig
  path mapping.

## Core — 0.3.2-main.18 (2026-09-18: configured context window end to end)

Everything since core `0.3.2-main.17` ships in this release; telegram is
unchanged at `0.1.4-main.3`.

### Core

- **Configured context window enforced end to end** — the configured cap
  (`braid.context.contextLimitTokens`) is plumbed into the session model at
  run start so pi-core's own threshold compaction and overflow detection
  execute the cap; the turn-end act's deterministic slide fires regardless
  of `compaction.enabled`; the single pending-compaction slot became a
  bounded drain-and-coalesce queue that keeps archive anchors; one shared
  token formatter across whispers, context_inspect, and tool feedback; and
  read-only surfaces read other extensions' state through the real session
  store (`6dfd3f67`).
- **Memory write gate** — a review-before-write predicate now fronts the
  episode writers: signal-free tasks are rejected, dead solution fields are
  repaired from the task, and exact/near-repeat (task, solution) pairs are
  deduped against recent episodes (`32de2aba`, `5c319a77`, `2a5ef5fe`).
  Configurable via `braid.memory.writeGate` (enforce/warn, per-site opt-outs);
  an append-only write-decision log plus metrics and junk-scan scripts make
  gate health measurable (`0b1aa6c9`, `cd5e2387`).
- **Recalled memory fencing** — memories recalled into a session are fenced
  as non-user context, so stored notes can no longer masquerade as operator
  instructions (`f76c2d80`).
- **Context management** — live context usage is measured per turn and acted
  on before sessions grow (`698c168e`); compactions only run when the agent
  loop is done (`84b3fad9`); slide and archive move the live working set
  (`7dc0eb25`); a manual compaction is a full stop — the queued flush replay
  is held and swallowed so no assistant turn resumes from pre-compaction
  input (`7203dd73`).
- **Prompt identity refresh** — senior-craft wording, new
  PLACEMENT_DISCIPLINE and SELF_AUDIT blocks, policy sections relocated
  (`0a5246ba`); scanner-clean self-audit wording (`803a45ae`); mirror guard
  and result schema in worker identity (`b66f69ef`).
- **Orchestrator tooling** — worker registry with atomic writes and a
  duplicate guard (`f1bd20ca`); structured worker lifecycle actions and a
  check-worker verdict (`312e7cb7`); the verification judge gained a
  self-state claim class — delivery/liveness claims must cite a probe,
  honest hedging stays exempt (`dad58772`).
- **Skills** — settings-driven session profiles and a boot hint
  (`5226e368`); one-shot skills-boot whisper (`7b8fdad6`); new
  probe-evaluation, misdirection-audit, and placement-discipline skills
  (`3832df99`); the skills package joined the local publish pipeline
  (`6f6b6b66`).
- **Timer recovery scoped to the owning session** — persisted-timer
  restoration no longer crosses session boundaries (`7d3c6f89`).
- **Classifier empty-label fix** on reasoning-capable session models
  (`7e0813f6`); edge/WAF challenge-page dumps redacted from internal request
  bodies (`959ce4e0`).
- **Coverage** — root typecheck and lint now cover all four code packages,
  with surfaced findings fixed (`103f7e79`); dead verification module
  dropped (`c7d5ace1`).
- **Hygiene** — whole-tree private-data scan (`1929e02b`); placement checker
  for provenance tokens, domain literals, and home paths (`8a1b408c`);
  session provenance stripped from comments, tests, and docs, with
  comment-discipline and commit-subject rules added to CONTRIBUTING
  (`599ae15f`); knip dead-code detector adopted report-only (`737f6363`).
- **Docs** — compaction message-loss investigation preserved as a historical
  record (`050e80f9`); skill/suite counts drift-proofed (`61b35d1e`,
  `b6b80f8d`); setup requirements and security policy corrected
  (`9d9b166f`).

### Telegram

- **Voice STT hardening** — an ordered key pool (explicit key, `BRAID_TG_STT_KEYS`, macOS keyring, env candidates) advances on 401/403/429 and quota-class failures and remembers the winner; transcription is bounded to two passes with an ffmpeg-amplified retry; the chat-mode model default moved to a stable performer; the failure line carries diagnostics, never key material (`38bb5ba6`).
- **Long-by-default owner messages** — settings-driven caps replace the one-size truncation (`e8190b4b`).
- **Awareness catalog honesty** — the TG inbound row reports the live poller state instead of asserting unconditional reachability (`82bd2f83`).

### Providers

- **OpenRouter removed** — venice (a0 proxy) is the only registered provider (`bc672e35`).
- **Reasoning-model fixes** — thinking "off" maps to wire-level none (`fcb3e4d9`); developer-role-incompatible qwen backends are marked per model (`0656aa36`).
- **Venice catalog robustness** — cost is always emitted as a finite number so unpriced models can't break the usage path (`0ec40974`).

## Core — 0.3.2-main.17 / Telegram — 0.1.4-main.3 (2026-09-11: swallow-catch triage, dead-export removal, poller self-heal)

- **Swallow-catch triage** — 176 repo-wide swallow sites triaged to zero unexplained; 4 real silent persistence failures now logged (timer savePendingTimers/persistTimerToDisk, enforcement tag persist, budget double-swallow), 39 boilerplate catch comments upgraded to real whys (`fccfef81`); **dead-export removal** — 68 unreferenced exports deleted across 35 files, −717 lines (`6f0daebb` + `ae7a05d4`/`22036a12` follow-ups).
- **Poller self-heal across reloads** — pi-core emits session_shutdown on every agent-session reload; the telegram poller now survives it (intent flag + session_start re-arm) and telegram_send warns when the inbound poller is off at send time (`2937941e`).

## Core — 0.3.2-main.16 (2026-09-11: scanner HOME hardening, legacy-comment cleanup)

- **Scanner HOME hardening** — `check-private-data` throws on missing HOME, providers typescript pin aligned to 6.0.2 (`5f404c82`); **legacy-comment cleanup** — deleted legacy echo comments and step narration from `src/**`, shrinking the shipped dist (`ffd3f2df`).

## Core — 0.3.2-main.15 (2026-09-11: wake-retry hardening, wake-window proof, publish-readiness fixes)

- **Wake-retry hardening** — wake outcome timeout 60s→240s; redelivery deferred during
  pi-core auto-retry via bounded `retryHoldUntil`; wake attempts capped 5→3 with
  `braid.timers.maxWakeAttempts` setting; wake-gate arms on idle input only (`1b0cfed1`).
- **Wake-window proof** — empirical stress fixture (407 lines) proving the prompt-entry
  wake window closed under load: no lost wake, no double delivery, no cross-run leak, hold
  semantics verified. Scheduling pi-core-independence audit: 10 paths INDEPENDENT, 1 ADAPTED,
  2 accepted tested invariants; zero code changes required (`498b3a73`).
- **Publish-readiness** — core tarball: dead `CHANGELOG.md` files entry removed, `docs/`
  now shipped; skills catalog corrected 23→27 in README/AGENTS/SETUP (`effd859e`).

## Telegram — 0.1.4-main.2 (2026-09-11)

- **telegram_send description rewrite** — 1659→983 chars, decision-first with worked
  examples; targets concise-path misprediction (7 mispredicts observed 2026-09-10) (`c22f79c7`).

## Core — 0.3.2-main.14 (2026-09-09: skills rollup, judge chunked evidence, WAF excerpt redaction, surface discipline)

- **Skills rollup** — claimed-vs-actual load counters split, `scoreSkill` retuned,
  needs-refresh descriptions refreshed (`e47e1036`); durable per-session adoption
  records + monthly adoption-rate rollup split worker|orchestrator (`334afdd4`).
- **Judge chunked evidence** — RLM-style chunk summaries for task evidence beyond
  the cap (`955ce1c2`).
- **WAF excerpt redaction** — Venice WAF challenge-page excerpts stripped from
  stored history and the warn sink (`c8255b33`, providers-side `ring-lifecycle.ts`).
- **Surface discipline** — `SURFACE_DISCIPLINE` identity block with lockstep test
  and slop diff-scanner shadow (`bed9b39a`).

## Core — 0.3.2-main.13 (2026-09-05: prompt-builder hygiene + stale-toolResult offloader)

- **Prompt-builder hygiene** — the resources catalog section collapsed to a `list_skills` pointer,
  memory-section counts removed, threshold literals cut from the prompt (they live in the owning
  config), and herdr tool one-liners gated behind herdr availability (−1001 chars baseline).
- **Stale-toolResult offloader** — new `braid.context.staleToolResultOffload` setting, **default
  OFF**: stale tool results are offloaded losslessly to disk and replaced in-context by a stub;
  idempotent and bounded.
- **Hermetic test re-baseline** — 97/97 suites pass with temp-HOME fixtures (no dependence on the
  live agent home).
- **Durable skill adoption counters** — per-skill suggested/loaded counts + lastAt persist across
  sessions in `skills-usage.json`; `skill_stats` gains an all-time section; best-effort writes that
  can never break the suggestion path.
- **Prettier drift cleared repo-wide**; `format:check` added to `ci:check` (root and core);
  config-example documents both context settings (`contextLimitTokens`, `staleToolResultOffload`).
- **Telegram voice STT 401 fix** — chat-mode STT now derives its default baseUrl from the
  userland venice catalog (`venice-catalog-base-url.ts`, mirroring the providers reader) so the
  deployed gateway-era `A0_VENICE_API_KEY` pairs with the gateway that accepts it;
  `BRAID_TG_STT_BASE_URL` still wins, transcriptions mode unchanged.
- **Small-correctness batch** — `prompt_inspect` includeTools/includeSkills now actually
  exclude their sections in braid-composed prompts (the old patterns never matched the braid
  prompt shape and always reported "0 lines removed"); `v2raytun_reconnect`'s rendered one-liner
  no longer truncates mid-sentence; the watchdog tunnel canary probes `getMe` on getUpdates
  failure so sibling-consumer conflicts no longer bark tunnel-down at healthy pollers;
  `context_inspect` surfaces last-compaction loss counters (compacted → kept) in the loss line;
  `context_compress` deep_clean feedback reports an estimated cut like archive/slide.

---

## Core — 0.3.2-main.12 (2026-09-04: config-tunable context limit)

A config-tunable context limit — `braid.context.contextLimitTokens`
(in `~/.pi/agent/settings.json`) caps the effective window braid computes against, while the
provider catalog keeps model truth. One pure resolver (`resolveContextLimitTokens` /
`getResolvedContextWindow` in `lib/config/braid-settings.ts`) owns the precedence: owner cap →
model/provider window → caller default; invalid values are ignored with a once-per-process
warning. All three window consumers read through it:

- **Density evaluator hardcode fixed** — the fast density path divided by a hardcoded 100k
  window and fired density triggers ~3x too early at a 262k window; it now uses the resolved
  effective window (100k only when neither the cap nor the provider window is known).
- **Percent math honors the cap** — context tiers and percent-of-window gates divide by the
  effective window, so percent advisories stay meaningful under an owner cap instead of
  referencing a window the owner has deliberately shrunk.
- New config test `test-context-limit-config.mjs` covers resolver precedence and consumer
  wiring.

---

## Core — 0.3.2-main.11 (2026-09-03: token-gated advisories, heartbeat self-state, rollback guard)

Token-gated advisories plus a heartbeat self-state line, fixing three confirmed production
findings from long-session audits — most importantly that percent-of-window gating is
unreachable on 1M-token windows, where a measured session fired zero high-context advisories
across 154 turns at 150-238k tokens. The agent's self-identity now states honesty explicitly:
"an honest self-aware agent with a metacognitive suite and extras on top of pi."

- **Token-gated advisory path** — the context-lifecycle proposal real-need gate and the
  urgent-bypass were percent-of-window only; at a 1M window they are unreachable. Gates now
  open on EITHER arm — percent (sub-1M windows) or tokens (min(percent, token) semantics):
  actionable at ≥ USAGE_TOKENS_CRITICAL (100k), urgent at ≥ HYGIENE_AUTO_COMPACT_HARD_BACKSTOP
  (140k), escalated wording (archive-or-handoff) at ≥ new USAGE_TOKENS_ESCALATE (200k) — single
  owner context-thresholds.ts. The compact-nudge message and the context-manager audit
  recommendations / branching trigger carry the same token arms. Acting path (auto-compact
  ACT ladder) untouched.
- **Heartbeat self-state line** — every heartbeat summary (tick batcher and the delayed-flush
  builder) gains ONE ≤40-token self-state line right after the clock:
  `self-state: ctx 213K tok · cache 96% · dup 39 · tps-ema 87`. Context tokens are a live read;
  cache-hit share (cacheRead/(input+cacheRead)) is captured per assistant message and lands in
  the context-heartbeat JSONL telemetry; near-duplicate count comes from the density evaluator;
  tok/s trend is the existing EMA. An unavailable metric renders `n/a`, never zero.
- **Auto-rollback test-debug guard** — new `lib/detection/test-burst.ts`
  keeps a bounded per-session ring of tool outcomes fed from the enforcement tool_result handler
  and classifies test-runner bursts (runner commands, pass/fail counts, assertion errors).
  autoRollback — the single DECISION point — now withholds the destructive rewind when the burst
  is test-dominated (≥3 errors, every one test-marked, ZERO non-test failures) and downgrades to
  whisper-only: the degradation advisory still fires (heartbeat + enforcement paths),
  degradation state is not cleared, and genuine degradation with non-test errors rolls back
  exactly as before.
- **Tests (metric pinning)** — `test-advisory-token-gate.mjs` (source scan: advisory gates
  reference token constants; functional: proposal fires at 20%/120k tokens, suppressed at 20%/80k,
  urgent at ≥140k), `test-heartbeat-self-state.mjs` (line format, n/a tolerance, summary
  integration, cache telemetry), `test-test-burst-rollback-guard.mjs` (classifier cases,
  suppression on test-dominated bursts, no suppression when errors span non-test tools,
  autoRollback end-to-end both ways).

---

## Core — 0.3.2-main.10 (2026-09-03: time-awareness)

One owner-timezone clock for everything braid renders, plus the telegram truncation contract
and inbound timestamps. Companion telegram release `0.1.4-main.1`.

- **One local-time formatter** — new `lib/utils/local-time.ts`:
  `formatLocalTime()` renders `HH:MM TZ (UTC±X)` (with optional `YYYY-MM-DD` date) in
  the owner time zone — `braid.timezone` in settings.json, default `Europe/Moscow` —
  and `formatWhisperClock()` renders the compact `HH:MM TZ` header form. Fixed-offset
  abbreviation map (MSK, YEKT, …) because CLDR renders Europe/Moscow as "GMT+3". Every
  braid-facing time string now routes through it; the scattered
  `toLocaleTimeString()` call sites (timer set/list text, timer-reminder "Fired at:")
  are gone.
- **Whisper header timestamps** — the central envelope builder
  `formatWhisperEnvelope()` (whisper-format.ts) renders
  `[braid-whisper - <subsystem> @ 17:05 MSK]`, so every `sendTrackedMessage` whisper
  and the telegram inbound builders carry the generation/send clock: the agent can
  tell a fresh whisper from a stale re-injection. A source-tree scan test pins that
  no hand-built envelope literal can bypass the formatter.
- **Fresh clock** — every heartbeat summary (both builders) prepends
  `now: <YYYY-MM-DD HH:MM TZ (UTC±X)>`; the prompt-builder gains a 30-minute datetime
  drift guard: when >30 min have passed since the last datetime anchor, a one-line
  `datetime-refresh` whisper re-anchors the clock (the re-anchor IS the rate limit —
  exactly one refresh per window). Fixes long sessions reasoning on a
  session-start-stale clock.
- **Timer honesty** — timer fire text now reads
  `set for 16:58 MSK (UTC+3), fired 17:05 MSK (UTC+3) — drift 7m`; the
  set-confirmation and `timer list` render the owner-TZ wall clock with the date.
- **Reachability catalog** — the once-per-session hygiene whisper gains a
  6-channel "can reach you" block (enforcement whispers, heartbeat, watchdog, timers,
  context-lifecycle proposals, TG inbound) with rough cadences, ≤80 tokens.
- **Identity reword** — IDENTITY_INTRO now reads "You are Braid, a
  self-aware agent with a metacognitive suite and extras on top of pi"; README
  taglines match.
- **Telegram truncation contract (telegram 0.1.4-main.1)** —
  `telegram_send` gains explicit `limit` (chars) and `strategy` ("truncate" | "error")
  params. Over-limit WITHOUT an explicit choice now errors to the agent (stating the
  limit + the options: rich:true / shorter text / explicit strategy) — the silent hard
  truncation fallback is gone (zero silent truncations; the crafting distillation
  stays). An explicit `strategy: "truncate"` is the only hard-truncate path and skips
  crafting; `rich:true` split-to-fit is unchanged. Tool description states the limits
  explicitly.
- **Telegram inbound timestamps** — `TelegramUpdate.date` now renders as
  `@ HH:MM TZ` in the `[braid-whisper - telegram]` header of BOTH inbound builders
  (poller + agentic inbox), using the telegram-local mirror of the core formatter
  (the package cannot import core — established watchdog-tunnel mirror pattern;
  parity pinned by its own test).
- Version bump: `0.3.2-main.10`. Telegram version: `0.1.4-main.1` (corrected: a
  `0.1.3-main.1` would have been a semver downgrade from `0.1.4-main.0`).

---

## Core — 0.3.2-main.9 (2026-09-03: context-hygiene enforcement)

- **Real heartbeat telemetry** — the heartbeat tick fed
  `recordTurnMetrics` constants (`avgTurnDurationMs: 1000`, `inputTokens: 0`,
  `memoryUsagePercent: 50`); the entire degradation pipeline ran on
  placeholders. New `lib/telemetry/context-heartbeat.ts` collects live
  context tokens/percent/window (`ctx.getContextUsage`), RSS + heap,
  session-file size, per-class char deltas since the previous tick (density
  walk), injected-whisper pressure, and tokens/sec from the assistant
  message window — one append-only scalar-only JSONL line per tick at
  `~/.pi/agent/braid/telemetry/context-heartbeat.jsonl`. A second hook emits
  the same line on the watchdog engine's wall-clock cadence so idle processes
  are covered. Sink failures are non-fatal; entries are scalar-whitelisted at
  the boundary.
- **Watchdog flap latch + escalation budget** — preserved the
  owner-endorsed first-bark wake-up; killed the repeat storm (measured:
  143 escalations, 55 byte-identical, 33.6k chars = 5.1% of peak context).
  A transient close no longer re-fires the threshold bark nor resets the
  milestone ladder; re-arm requires a 3-consecutive success streak (healthy
  evaluations or LLM successes). A per-session per-condition injection
  budget (12, `WATCHDOG_ESCALATION_BUDGET_PER_SESSION`) leaves only the
  500-milestone rung active once exhausted. Tunnel recovers via its genuine
  `up` event (explicit success); turn-stall's long-cooldown behavior is
  unchanged.
- **Token re-arm for turn-end auto-compact** — the 15-turn
  cooldown allowed 190-415k-token regrowth between compactions (measured
  peaks 191-261k). The turn-end ACT now re-arms whenever tokens ≥ 100k and
  ≥ 3 turns passed since the last attempt, plus an UNCONDITIONAL hard
  backstop at ≥ 140k tokens (`HYGIENE_AUTO_COMPACT_HARD_BACKSTOP`) that
  ignores all spacing — bounds runaway single-tool-result growth. Pre-save
  resume.json + compact mechanics untouched.
- **Auth/balance health recovery** — `recordLlmSuccess` never
  cleared the `auth`/`balance` modes and the probe tick only fired on
  errors, so one 401 burst latched a session forever and heartbeat
  consolidation was skipped permanently (live: the orchestrator session
  latched auth ~19 minutes). Both modes now clear via a bounded probe
  (5-min quiet window → next success proves recovery; a fresh 401
  re-latches instantly — initial escalation NOT weakened) or a 10-success
  streak. New `consolidationSkipsByMode` counter on SessionHealthState
  tracks skipped consolidations per mode.

---

## Core — 0.3.2-main.8 (2026-08-29: pre-publication polish)

- **OOM crash fix (2026-09-01 hotfix)** — pi-core 0.84.4 removed
  `settingsManager` from ExtensionContext; the degradation-detector
  `isCtx()` guard keyed on it, so every heartbeat tick treated the ENTIRE
  ctx object as a metrics entry — embedding the full session graph AND the
  modelRegistry (credentials) into `degradation.json` until
  `JSON.stringify` exceeded the V8 string limit ("Invalid string length")
  and processes grew to multi-GB heaps overnight. Fix: ctx detection now
  keys on `sessionManager`/`modelRegistry` (present in both old and new
  pi-core); metrics entries are built by a scalar WHITELIST copy instead of
  spreading the argument; async-storage refuses to serialize state files
  above 10MB (skips with a loud error instead of OOM-ing); regression test
  `test-degradation-ctx-guard.mjs` pins all three invariants. The polluted
  87MB→525MB `degradation.json` was purged (it also contained live API keys
  — credential sprawl closed).

- **Tool-instruction ownership inversion** — per-tool inventory lines resolve
  by priority: the tool's OWNING package `promptGuidelines` (pi-core native
  seam) → static `TOOL_GUIDELINES` (strategy-only `when / when-not / key
args / caveat` one-liners for all 32 documented tools, synced 1:1 with
  `TOOLS.md` via lockstep test) → `EXTERNAL_TOOL_GUIDELINES` last-resort map
  for unpatched third-party packages (herdr, pi-smart-fetch) → first sentence
  of the tool's own description. No duplication with description text.
- **SKILLS_LOADING strategy contract** — pointer rule (catalog
  one-liner is metadata, not content), mid-task re-list trigger (paginated
  catalog), never-act-from-memory rule, and an explicit when-not test.
  Mechanics (offset clause) deduplicated into the `read` guideline.
- **Telegram double-message fix** — agent-delivery flag: explicit
  `telegram_send` marks the message delivered; live-update `finish()`
  suppresses its auto summary when flagged (`0.1.3-main.0` companion).
- **Watchdog tolerance widened** — poll timeout 30→50 s, `tunnelFailures`
  3→5 (config-overridable).

## Core — 0.3.2-main.7 (2026-08-27)

- prompt-builder archaeology debloat — removed dead whisper/pointer material.
- Compaction originals archive is fully lossless and append-only.
- Telegram inline-keyboard pause/resume landed in the same release.
- Companion telegram release 0.1.3-main.0 shipped together.

## Core — 0.3.2-main.1 … 0.3.2-main.6 (2026-07-27 → 2026-08-25)

- **Monorepo migration** — all five packages (`core`, `skills`, `contrib`,
  `providers`, `telegram`) under npm workspaces; 333 duplicate root files
  removed.
- **API key ring** — generalized multi-key provider rotation with exponential
  backoff, persisted exhaustion state, and self-healing turn retry.
- provider registration rewritten on `createProvider` + request-time key-ring
  auth resolution.
- prompt-builder overhaul — discovery stance, tool-usage pipelines, and a
  once-per-session awareness whisper.
- **Compaction upgrades** — speaker attribution and sliding-window compaction
  (`action=slide`).
- **Skills verdicts applied** — KEEP/IMPROVE/DEPRECATE/MOVE from the
  skills-usage research, with freshness markers.
- `packages/lib` retired into `core/src/lib`; `packages/telegram` added as a
  workspace.

## Core — v0.3.x (v0.3.0 → v0.3.2, 2026-07-23 → 2026-07-25)

- Versioned **local publish pipeline** (`publish-local.mjs`) — `base-branch.iteration`
  scheme, auto-reverts the version bump.
- **v0.3.2** release plus a compact >70% release guard.
- Definition-of-Done invariant and turn-end hygiene/discoverability
  improvements.

## Core — legacy v0.1.1 … v0.39.0 (2026-04-17 → 2026-05-15)

The pre-monorepo line that built the foundation. Highlights:

- Repo carved out of the pi-mono/pi-braid lineage (2026-04-13).
- **Native `web_fetch` + CDP browser automation** with zero external deps.
- Typed **event bus** for cross-extension signals — proactive context
  projection and analytics.
- **Three-memory-stores** — episodes / semantic / heuristics deep merge with
  cross-search and session recall.
- prompt-builder decomposed into `PromptSection` fragments + pointer blocks;
  behavior-modes system dropped for static identity invariants.
- Skills reorg across core/contrib/pack boundaries and contrib split out then
  re-merged.
- pi-ai v0.80 compat — Models-instance holder replaces direct child access.

---

## Providers — 1.0.4-main.1 (2026-09-09: WAF excerpt redaction)

- **WAF excerpt redaction** — Venice WAF challenge-page excerpts no longer reach
  stored history or the warn sink (`c8255b33`); direct-call warn excerpts redacted
  and the self-heal test synthesizes its WAF body (`63782887`); release bump to
  `1.0.4-main.1` from flat `1.0.3` (`e6d9f984`).

---

## Telegram — 0.1.4-main.0 (2026-09-01)

- **Idempotent edit fix** — `editMessageText` treats Telegram's 400
  "message is not modified" as success instead of warning (re-tapping the
  pause-control status button is a no-op, not a failure); regression test
  added.
- **Poller/inbox discipline in promptGuidelines** — `telegram_inbox` and
  `telegram_poller` now carry the getUpdates-singleton rule: while the
  poller runs, manual inbox calls conflict (expected, not a bug); the
  owner's `/telegram enable|disable` commands own the same singleton —
  never blindly re-enable over an explicit disable.

## Telegram — 0.1.x (0.1.0 → 0.1.3-main.0)

- **0.1.0** — bidirectional channel: fetch-based client, `telegram_send`
  tool, inbound long-poll injector.
- **0.1.1** — release refresh.
- **0.1.2** — voice inbound + STT; photo inbound.
- **0.1.3-main.0** — inline-keyboard **pause/resume** control.
