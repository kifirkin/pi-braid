<!-- status: current -->

# Local Development

How to develop pi-braid locally, publish it into the pi agent home
(`~/.pi/agent/local-packages`), and wire the published package into pi.
For one-time setup, the full install-path catalog, and module toggling see
[SETUP.md](SETUP.md).

## Prerequisites

| Tool | Version       | Verify                     |
| ---- | ------------- | -------------------------- |
| Node | ≥ 24.0        | `node --version`           |
| npm  | bundled       | `npm --version`            |
| git  | any           | `git --version`            |
| pi   | peer-resolved | `which pi && pi --version` |

The Node floor is the `engines` field in every workspace manifest; the pi floor
is the `@earendil-works/*` peer range in the same manifests (a caret on the
family the seat runs, kept moving by the update pipeline). If this table and a
manifest ever disagree, trust the manifest.

## Monorepo layout

Five npm workspaces under `packages/`:

| Workspace            | Package              | Loads via                    |
| -------------------- | -------------------- | ---------------------------- |
| `packages/core`      | `pi-braid`           | `pi.extensions`, `pi.skills` |
| `packages/skills`    | `pi-braid-skills`    | `pi.skills`                  |
| `packages/contrib`   | `pi-braid-contrib`   | `pi.extensions`              |
| `packages/providers` | `pi-braid-providers` | `pi.extensions`              |
| `packages/telegram`  | `pi-braid-telegram`  | `pi.extensions`              |

pi loads a workspace through the `pi.extensions` / `pi.skills` fields in its
`package.json` - there is no auto-discovery. `packages/core` declares
`pi.skills` for the core set it ships, and `packages/skills` declares
`pi.skills` for the on-demand pack (see the collision rule below).

## Everyday commands

From the repo root:

```bash
npm install            # installs all workspaces (peer-resolves the pi packages)
npm run typecheck      # all four code packages
npm run build          # compile core to dist/
npm test               # build + runtime test suites (core)
node packages/core/scripts/run-tests.mjs --jobs 1 --timings  # the same files serially, with durations
npm run lint           # ESLint over all four code packages
npm run format         # prettier --write .
npm run format:check   # prettier --check .
npm run check:docs     # every in-scope .md has a status marker
npm run check:doc-drift # current-state docs must not reference APIs missing from code
npm run check:deps     # layer-boundary check
npm run check:source-claims # every count a doc states is re-derived from the tree
```

The counts these documents state are re-derived, not copied.
`packages/core/scripts/source-claims.json` holds the counts the gate governs - the
file and line each one is written on, a pattern that reads it out of that line,
and the command that derives it from the tree - and `npm run check:source-claims`
re-runs every command and fails on a disagreement. A count no command re-derives
is not enrolled: a measurement (a duration, a load average) belongs to the run
that produced it, and a figure in a released changelog belongs to that release.

The core runtime suite runs its files in a bounded pool: the machine's own
parallelism, at most eight. The width is a flag, so the same files can be run
one at a time when a failure needs the serial order, and their durations can
be printed or written for a comparison between two widths:

```bash
node packages/core/scripts/run-tests.mjs --jobs 1   # one file at a time
node packages/core/scripts/run-tests.mjs --timings  # per-file durations, slowest first
node packages/core/scripts/run-tests.mjs --timings-json=/tmp/timings.json
```

`PI_TEST_JOBS` sets the width without the flag. Results always print in
fixture order, so the per-file lines of two runs of the same tree match; the
summary line carries the run's own wall clock, so it differs whenever the run
did, and a diff between two widths should compare the file lines rather than
the tail. The cost of that order is that a slow file at the head of the walk
holds every later line, so a run that has printed nothing for 30 seconds says
once which file it is waiting on.

Per-workspace variants use the workspace flag, e.g.
`npm run build -w packages/core`, `npm test -w packages/providers`.

The combined gate is `npm run ci:check` (docs, drift, deps, format,
typecheck, tests).

### Fixtures and process groups

The runner starts each file in its own process group and signals the group: at
the file's cap with `SIGKILL`, and the same on `SIGINT`/`SIGTERM`. A fixture's
own helpers therefore stay in that group, so nothing a helper starts outlives
the run: the group is killed when the file settles or reaches its cap.

The file settles when its output pipes close, not when its process exits. A
helper that inherits the file's stdout keeps that pipe open after the file
exits, so the runner still counts the file as running; if the helper outlives
the cap, the file is reported as a timeout even though its own exit code was 0.
Give a helper its own stdio, or wait for it to exit, before the fixture exits.

A helper spawned with `detached: true` calls `setsid()`, leaves the group, and
outlives the run that started it: no group signal reaches it. One fixture needs
that escape - `test/runtime/fleet/test-supervisor-recovery.mjs` fabricates an
owner and an orphaned turn, and `detached: true` is what keeps those processes
from being the fixture's own children, since a zombie child keeps its group
answering a liveness check long after the kernel killed the process. It reaps
each of them by pid when it is done, and an interrupt caught while that file is
in flight leaves nothing longer-lived than its own `sleep 30`, which ends
itself. Any other fixture that escapes the group owes an explicit cleanup on
every exit path, the interrupt one included.

### Fixtures and their own temp directory

Every runner that spawns fixture files gives each file its own `TMPDIR` and
removes that tree when the file settles, and on `SIGINT`/`SIGTERM` too. A
fixture's `mkdtemp` then writes inside the sandbox instead of the machine's
temp directory: a case that never cleans up after itself, or a file killed at
its cap, which cannot clean up, costs one tree the runner already owns.
`packages/core/scripts/run-tests.mjs` and
`packages/telegram/test/run-tests.mjs` both do this; the telegram runner also
derives its per-file `BRAID_HOME` and poller-lock pins from that same temp
root, so nothing a child writes to temp lands outside the sandbox.

The signal path needs a runner that is not blocked in a synchronous spawn:
a JS signal handler cannot run while `spawnSync` waits, so a blocking loop
only cleans up after the file it was waiting on has already returned. The
core runner's pool and the telegram runner's per-file `spawn` both keep the
loop free for the handler.

When you change a runner, count the fixture-named directories under `$TMPDIR`
before and after a full run. A non-zero delta is the leak this rule prevents.

### New fixtures: use `node:test`

A new fixture is written on `node:test`. The runner does not care which style a
file uses - 159 of the core suite's 400 fixtures already use `node:test` - so the
reason is the failure the other style produces. A hand-rolled helper that calls
`fn()` without awaiting it discards the case's promise, so an `async` case runs
detached and the file can print its green tally before that case settles, with
the exit code computed from a counter the case never reached. `node:test` cannot
take that shape. Existing files are not rewritten for style; a file with async
cases that a synchronous helper discards is fixed when it is touched, by
awaiting the helper's call or by moving to `node:test`.

### What the count counts

The runner walks every `.mjs` under `test/runtime` and counts each file that
exits 0 as a passed fixture, so a module the walk sees and no case ever judges
would still add one to the summary line. A shared helper in `test/runtime/lib/`
is exactly that: the fixtures import it, it registers nothing, and it asserts
nothing when the runner loads it on its own.

Those modules are declared in `test/runtime/fixture-manifest.json`, under
`notFixtures`, each with the reason it is not a fixture. The runner neither runs
nor counts a declared module, and says so where it introduces the count. The
reason is required, so a module leaves the count with one on record, and
`node packages/core/scripts/run-tests.mjs --list` prints the whole population
with the declarations beside it, running nothing.

`npm run check:suite-coverage` holds both halves of that declaration. A counted
module must register a case with `node:test`, assert from `node:assert` while it
loads, or call a function it declares at load (the hand-rolled harness that
names its own cases and sets the exit code). A declared module must be none of
those, because a declaration that names a real fixture keeps a test out of the
run. A new helper therefore fails the gate until it is declared, and a declared
helper that grows a case fails it until it is taken back into the count.

### One suite at a time

The runner takes the repository's suite lock before it starts a file, so a second
full suite waits for the first and then refuses instead of running beside it.
The lock is one file, `<git-common-dir>/pi-braid/suite.lock`, shared by every
worktree of the checkout - two worktrees of one repository contend for the same
file - and its record carries the holding pid, host, start time, command line,
working directory and git revision. `lib/suite-lock.mjs` holds the policy.

A run that finds the lock held prints the holder's fields and gives up after
`PI_SUITE_LOCK_WAIT_MS` (30s by default); `PI_SUITE_LOCK_MODE=refuse` refuses at
once, and a refusal exits 75 with the same fields plus the command that opens the
file. A lock whose pid is gone, or whose age is past
`PI_SUITE_LOCK_CEILING_MS` (2h by default), is reclaimed with a line saying which
rule fired; a lock taken on another host is never reclaimed, it is reported. The
lock is released on exit, on a failing file, on a thrown error and on
SIGINT/SIGTERM, so a crashed run does not wedge the checkout - and a SIGKILL,
which no hook can catch, is what the reclaim rule is for.

`npm test -w packages/core` reaches the same lock through the runner: the
workspace's test script is `node scripts/run-tests.mjs --build`, and `--build`
runs `npm run build` after the lock is taken, because the build begins with
`rm -rf dist` and a second suite's clean would delete the dist a live suite's
fixtures import. To see what is holding it:

```bash
# who holds it: pid, host, start, command line, cwd, revision
cat "$(git rev-parse --git-common-dir)/pi-braid/suite.lock"
# queue for the holder instead of giving up at the default bound
PI_SUITE_LOCK_WAIT_MS=600000 npm test
```

A lock left behind by a SIGKILL needs no hand: the next run reclaims it by the
dead-pid rule. A lock from another host is the one case a person releases.

A run inside the holder - a fixture that spawns the runner over a bench - is not
contention: it inherits `PI_SUITE_LOCK_TOKEN` and proceeds. `PI_TEST_ROOT` runs a
bench tree rather than the suite and takes no lock at all. `PI_SUITE_LOCK_FILE`
points the device at another file, which is how the tests exercise it.

### Regressions against a baseline

The suite says whether anything is broken now. A merge needs a second answer:
whether the change broke something nobody was looking at, and the only honest
evidence for that is a before-set taken on the tree the change lands onto plus
the same enumeration run again afterwards.

```bash
# on the base tree, before the branch lands
node packages/core/scripts/check-regressions.mjs --baseline /tmp/baseline.json
# after it lands
node packages/core/scripts/check-regressions.mjs --check /tmp/baseline.json
```

`--baseline` runs the suite and writes one row per fixture: its path, the
outcome the runner judged, and the tally the fixture printed about itself when
it printed one. `--check` runs the same enumeration and exits 1 when a fixture
that passed in the baseline failed, timed out, is gone from the tree, or is
still green while running fewer cases than it did. It exits 2 rather than 1
when the baseline cannot ground the comparison: unreadable, taken over another
tree, or taken on a line of history this tree does not descend from.

The baseline records the revision it was taken at. A baseline from an ancestor
of the current revision is accepted with the distance printed, because that is
what a merge produces: the baseline on the base branch, the branch landed, the
comparison over the merged tree. A baseline from any other revision is refused.

A fixture a change means to remove or rename is declared, not silently dropped:

```bash
printf '%s' '[{"path":"core/test-old.mjs","why":"the case moved into core/test-new.mjs"}]' > /tmp/exempt.json
node packages/core/scripts/check-regressions.mjs --check /tmp/baseline.json --exempt /tmp/exempt.json
```

A row with no `why` is refused, and an exemption that silenced nothing is
reported as stale rather than carried year to year. The run takes the suite
lock, so it refuses beside another suite instead of sharing the machine with
one, and it never widens the population it reads: a behaviour with no fixture is
outside what it compares, and every verdict says so.

`--root <dir>` points both modes at another tree and `--jobs <n>` sets the pool
width. That is how the file's own fixture drives it over a bench instead of the
suite: a run from inside a suite refuses the default root rather than starting a
second full suite inside the first.

## Standing preferences

A standing preference is a rule that has to fire at a moment, not when an incoming
message happens to resemble it. The store is `<braid home>/preferences.json`: one
entry per rule, and each entry names the surface that has to be in play for the
rule to apply.

```json
{
  "version": 1,
  "entries": [
    {
      "id": "telegram-buttons-single-word",
      "surface": "telegram",
      "rule": "Button labels carry a single word, never a description.",
      "since": "<YYYY-MM-DD>",
      "source": "owner message",
      "contradicts": ["telegram-buttons-with-descriptions"],
      "examples": ["A", "B", "C"]
    },
    {
      "id": "reply-language-english",
      "surface": "reply",
      "rule": "Write every reply in English.",
      "since": "<YYYY-MM-DD>",
      "source": "owner message"
    },
    {
      "id": "unbound-no-flattery",
      "surface": null,
      "unbound": true,
      "rule": "Answer without flattery.",
      "since": "<YYYY-MM-DD>",
      "source": "owner message"
    }
  ]
}
```

Fields: `id`, `surface` (`null` plus `"unbound": true` when the rule is bound to
nothing), `rule`, `since` (a date, or a timestamp whose date part is kept),
`source`, and optional `contradicts` (ids) and `examples`. A store version this
build does not read is refused whole rather than read halfway, and an entry that
does not parse is counted with its reason.

Presence is decided by the tool set, never by reading the conversation. The
surfaces are `telegram`, rendered when `telegram_send` is enabled, and `reply`,
in play whenever a turn is, because a prompt is only built for a turn that is
about to be written. A rule naming any other surface is not rendered: the
section logs it once. Adding a surface means adding it to `SURFACE_BINDINGS` in
`packages/core/src/extensions/core/prompt-builder/preferences-section.ts`, with
the tools that carry it.

The markdown file is a projection of the store, and the gate keeps the two equal:

```bash
node packages/core/scripts/check-preferences.mjs            # hold the store and the projection together
node packages/core/scripts/check-preferences.mjs --render   # write <braid home>/preferences.md from the store
```

The gate refuses a rule with no surface and no `unbound` mark, two rules on one
surface that contradict (declared in either direction), a `contradicts` id that
is not in the store, an entry the reader cannot use, a store version it does not
read, and a projection that carries a rule the store lacks or misses one it has.
It reads the entry contract from the built module, so `npm run build` has to run
before it. The store library is `packages/core/src/lib/preferences/store.ts`.

This instrument does not read or migrate memory entries. A preference may also
live in the memory stores; those are retrieved by association and are a separate
surface with its own path.

## Provider failures on demand

Three provider behaviours decide how a turn ends, and none of them can be
summoned from a real endpoint on request: a 429 before the answer, a stream that
stops before `[DONE]`, and a normal answer assembled from deltas. Testing any of
the three against a paid provider costs money, needs that provider to fail on
cue, and reads a different answer on every run.
`packages/core/scripts/emulated-provider.mjs` is a local `node:http` server that
speaks the OpenAI chat-completions dialect and plays one of them:

```bash
node packages/core/scripts/emulated-provider.mjs --mode retry --port 8787
```

It prints the provider block to paste, the settings line the chosen mode needs,
and one line per request as it arrives. `--help` lists the flags; `--reply` and
`--failures` change the answer and how many 429s precede it.

### Which file the config goes in

A provider block pasted into `settings.json` does nothing: `providers` is read
from `models.json` in the agent directory (`~/.pi/agent/models.json`, beside
`settings.json`), and a session started with the block in the wrong file exits
with `Error: Unknown provider "emulated"` and makes no request. `settings.json`
is where `retry` lives.

```jsonc
// ~/.pi/agent/models.json
{
  "providers": {
    "emulated": {
      "baseUrl": "http://127.0.0.1:8787/v1",
      "api": "openai-completions",
      "apiKey": "emulated",
      "models": [{ "id": "emulated-model" }],
    },
  },
}
```

`apiKey` is required and the server never checks it: it is there so the client
has a key to send, and the fixture pins that the value arrives as a bearer
header. Leave it out and a turn reaches no request at all - one probe sat for
fifteen seconds printing nothing - so paste the block with the key in it.

### What each mode makes reproducible

| `--mode`    | the wire                                                                     | what it makes reproducible                 | `~/.pi/agent/settings.json`                  |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| `normal`    | role chunk, content deltas, `finish_reason: stop`, usage, `[DONE]`           | a whole answer assembled from deltas       | not needed                                   |
| `retry`     | `--failures` 429s carrying `retry-after-ms`, then a complete answer          | a 429 absorbed inside one turn             | `{"retry": {"provider": {"maxRetries": 2}}}` |
| `truncated` | content deltas, then the connection ends before `finish_reason` and `[DONE]` | end of body must not read as end of answer | `{"retry": {"enabled": false}}`              |

The `retry` row's setting is load-bearing: `retry.provider.maxRetries` has no
default, so without it the first 429 is the turn's outcome. The `truncated` row
turns the turn-level retry off because nothing can complete that turn, and each
re-attempt is another request.

Reach it like any provider:

```bash
pi --provider emulated --model emulated-model "say hello"
```

`GET http://127.0.0.1:8787/__status` returns the mode, the requests answered and
the 429s still owed as JSON. `GET http://127.0.0.1:8787/v1/models` answers the
dialect's list shape with the one id the completions route serves; pi does not
ask for it on a `models.json` provider, so it is there for a human with curl and
for any client that lists before it streams.

`test/runtime/providers/test-emulated-provider.mjs` drives that same config
through the runtime over RPC and pins the three behaviours: one request and a
whole answer for `normal`, 429 then 200 and a whole answer for `retry`, one
request and an error for the same 429 with no retry setting, and content plus an
error for `truncated`. It runs with `--no-extensions`: on this checkout a nested
session that loaded the extension pack (`-e dist/index.js`) produced one
watchdog status event and no provider request in 90 seconds, so an arm that
loaded it would pin braid's startup instead of this server. To watch braid
itself, run the `pi` command above from a real session.

## Two install modes

### 1. Live symlink (default for active development)

Source edits are reflected after a rebuild - no repack, no reinstall staleness.

```bash
# from the pi-braid repo root
npm run build
cd ~/.pi/agent/local-packages
npm install file:<absolute-path-to-your-checkout>/packages/core
# -> creates a symlink; pi follows it to source dist/index.js
```

Or the canonical `npm link` flow:

```bash
cd <absolute-path-to-your-checkout>/packages/core && npm link
cd ~/.pi/agent/local-packages && npm link pi-braid
```

> pi-braid loads `./dist/index.js` (compiled), NOT `.ts`. After editing
> source you MUST `npm run build` for changes to take effect, even with a
> symlink.

### 2. Versioned tgz snapshot (reproducible / CI)

Use when you want a pinned, semantically-versioned artifact:

```bash
npm run publish:local
```

## Local publish flow

`publish-local.mjs` (wired as `npm run publish:local` and friends at the repo
root) packs a workspace, installs the tarball into
`~/.pi/agent/local-packages`, and leaves the repo untouched.

```bash
npm run publish:local                # core (the default at the repo root)
npm run publish:local:skills         # skills pack
npm run publish:local:contrib        # contrib pack
npm run publish:local:providers      # providers
npm run publish:local:telegram       # telegram
# or per-workspace: npm run publish:local -w packages/telegram
```

What the script does, in order:

1. Derives the release version (see scheme below) and temporarily bumps the
   workspace's `package.json`.
2. Runs the package's pre-pack gates (`typecheck`, then `build`, when the
   package defines them - the markdown-only skills pack defines neither).
3. Runs `npm pack` and copies the tarball to `~/.pi/agent/local-packages`
   (override the destination with the `LOCAL_PKG` env var).
4. Preflights the install with a resolution-only dry run (mutates nothing;
   peer conflicts and missing file: targets surface here), then installs:
   the previously extracted copy of the package is renamed to a backup and
   the destination manifest bytes are snapshotted, so a failed install
   restores both - the old install stays loadable and the tarball stays in
   the destination for retry - while a successful one removes the backup.
   Either way the install can never stay stale.
5. Restores the pristine `package.json` bytes and deletes the tarball from
   the package tree - the working tree ends clean.

Version scheme: `<base>-<branch>.<iteration>`

- `base` = the workspace's current `package.json` version (e.g. `0.40.0`)
- `branch` = the git branch, sanitized to `[a-zA-Z0-9.-]`
- `iteration` = commit count on the branch since `main`/`master`

Example: `0.40.0-main.17`. When `package.json` already carries a full
versioned release string (e.g. `0.40.0-main.17`), it is used verbatim instead
of being double-suffixed.

### Provenance in the tarball

Every artifact carries `build-info.json` - package name, packed version, commit
sha and branch, dirty flag, pack time (`scripts/build-info.mjs` is the one
generator). It is written by each workspace's `prepack` (`scripts/pack-provenance.mjs`),
expanded into the `files` allowlist of every package, and removed by `postpack`,
so an `npm publish` pays the same step a plain `npm pack` does and the checkout
ends as it started. `publish-local` reads git before the version bump and
writes the record from that read, so the recorded `dirty` is the pre-bump
state; it carries the `BRAID_PROVENANCE_DEFER` marker into the pack, and the
prepack step keeps a record only under that marker, because the temporary bump
would otherwise read as a dirty tree. A record a killed pack left
behind is regenerated from a fresh read - a matching version and commit are not
enough to defer to.

Read the record to tell two builds of the same version apart, and to check what
a stranger installed: `sha` plus `dirty == false` is the pair that means the
tarball is a clean checkout of a named commit - a version string identifies
neither.

## Upstream pi update pipeline

`update-pipeline.mjs` codifies the full update run for the pair - the braid
extension pack and the pi runtime it hosts on:

```bash
npm run release:update                   # plan (default): read-only, prints what would change
npm run release:update:verify            # static half of the smoke checklist against the installed pair
npm run release:update:apply -- --yes    # real sequence; runtime untouched
npm run release:update:runtime -- --yes  # real sequence plus `pi update` (last)
```

Default mode writes nothing. It resolves the upstream pi version, compares it
against the repo pins and the local-packages resolution, and prints the target
version, every pin it would change (file, field, from -> to), the braid version
bump, the publish commands, the runtime command, and the rollback commands. The
host-family peers are pins here too: each workspace manifest declares the
`@earendil-works/*` peers (and `typebox`) as an explicit caret floor, and the
plan rewrites those ranges alongside the exact pins, so the floor moves with
the runtime instead of drifting behind it.

The local-packages trap: braid resolves the pi family from
`~/.pi/agent/local-packages`, and those resolutions are not what its peer ranges
control. Installing a new braid tarball NEVER moves those copies - the
explicit pins in `local-packages/package.json` must be realigned to the
upstream version as their own step. That is why `--apply` aligns both sides,
then republishes braid, and why the runtime update is always last and only runs
with `--apply --runtime`.

`--apply` requires `--yes`: without it the script refuses before doing any work
and names the edits, installs, and publishes it would have performed. The run
reconciles both sides - it rewrites the repo pins and then runs `npm install` at
the repo root, so the repo's `node_modules` and lockfile follow the pins and a
re-run of `plan` reports no repo drift, then it aligns the local-packages pins
and installs them.

`--apply` stages the rollback directory
`<local-packages>/backup-<date>-pre<ver>/` before it writes anything: the
installed `pi-braid*` copies plus a `VERSIONS.txt` carrying the restore
commands (restore each backed-up directory over `node_modules/<name>`, then
`npm install` in local-packages, then `npm install -g` the previous runtime
version). The backup is staged, not exercised.

`--verify` runs the static half of the smoke checklist against the installed
pair - installed braid versions vs the repo manifests, repo pins vs the
installed pi-family copies, dist/entry files present, extension paths named in
settings resolve, and each installed package's `build-info.json` sha - and
exits non-zero when an item fails. The live-session items (a timer firing
end-to-end with drift reported, delivery exactly once, no duplicate-instance or
load warnings, third-party extension tools, a readable key-ring state file) are
printed as a checklist for a real session; the script never drives one, because
a nested pi session launched from a script has stalled the seat before.

## Wiring a published package into pi

Register the installed paths in `~/.pi/agent/settings.json`:

```jsonc
{
  "packages": ["~/.pi/agent/local-packages/node_modules/pi-braid"],
}
```

Add the other workspaces the same way
(`node_modules/pi-braid-contrib`, `node_modules/pi-braid-providers`,
`node_modules/pi-braid-telegram`). `pi-braid-skills` is the on-demand skill
pack, registered in the settings file of the project that wants it rather than
globally. Restart pi after editing settings.

Verify inside pi:

- braid's tools appear in `<Available tools>` (memory, timer, scratchpad, …).
- the core skill set appears in `<available_skills>`.
  `find packages/core/skills -name SKILL.md | wc -l` counts it at any time -
  that count is what `<available_skills>` should list. Registering
  `pi-braid-skills` adds that pack's skills on top.

If pi asks you to trust a package path, approve it; trust decisions are
recorded per path in the agent home.

## Skills-collision rule

- **Two workspaces declare `pi.skills`.** `packages/core` (`./skills`) ships
  the core set with pi-braid; `packages/skills` (`./skills`) carries the
  on-demand pack. `contrib`, `providers`, and `telegram` must NOT have a
  `pi.skills` entry.
- If you add a skill, put it in the tier that owns it:
  `packages/core/skills/<name>/SKILL.md` for the core set,
  `packages/skills/skills/<name>/SKILL.md` for the on-demand pack. pi keys
  skills by name, so one name in both tiers collides.

### Debugging collisions

If pi reports `"<skill>" collision`, the first copy registered won and the later
one was skipped (`loadSkills` in pi-core keys skills by name and reports the <!-- doc-ref-exempt: pi-core skill loader named as the collision source -->
winner and loser paths):

1. Check `local-packages/node_modules/pi-braid/package.json` - it declares
   `pi.skills` (`./skills`) and the installed package carries that directory. A
   copy without `pi.skills` is a stale tarball from before the core set moved
   in; re-run the symlink install (mode 1 above).
2. Confirm the installed `pi-braid` points at its own `skills/` directory and
   `pi-braid-skills` at the on-demand pack - the two tiers ship separately.

## Removing a local install

```bash
cd ~/.pi/agent/local-packages
npm uninstall pi-braid        # or: rm -rf node_modules/pi-braid
```

Then remove the matching entries from `~/.pi/agent/settings.json`.
