<!-- status: current -->

# The supervisor fleet (`pi-braid-fleet`)

`pi-braid-fleet` is the one command this package installs. It operates a
**supervisor fleet**: a single supervisor process, with no model of its own,
keeping a cap of local node sessions running against one SQLite journal in a
fleet root.

The word "fleet" names this subsystem and nothing else. The worker registry that
`orchestrate` keeps for parallel agents is a pool of workers with its own
registry and lifecycle; the [README](../README.md) calls it a worker pool, and
the two share no journal, no code and no state.

## Install and help

`npm install pi-braid` puts the command at `node_modules/.bin/pi-braid-fleet`.
`pi-braid-fleet --help` prints the command list on stdout and exits 0; a bare
`pi-braid-fleet` does the same. An unknown command prints the usage on stderr
and exits 2, so a script can tell a refusal from an answer.

## The four commands

| Command                                                                | What it does                                                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn <parent\|-> <charter> [flags]`                                  | Registers a node from a charter file and makes sure one supervisor runs. `-` means no parent.                                                   |
| `status [--json]`                                                      | The fleet as the journal and the process table report it: supervisors, nodes, open asks, fences, resident memory. `--json` is the whole record. |
| `inject <node> <text> [--token <ask-token>]`                           | Delivers a message to a node. With `--token` it answers the ask that token belongs to.                                                          |
| `ask <node> <question> [--default A] [--priority N] [--ttl-seconds N]` | Records a question with a token, a default answer and a deadline; the answer path is `inject --token`.                                          |

Every command takes `--root <fleet-root>`, defaulting to `$PI_FLEET_ROOT` or
`<cwd>/.fleet`. The journal lives in that root, so two commands are looking at
the same fleet exactly when they were given the same root.

`spawn` forwards `--cap`, `--model`, `--pi-bin`, `--extension`,
`--supervisor-driver` and `--idle-exit-ms` to the supervisor it starts. A
supervisor that is already answering keeps the flags it was started with, and
`spawn` says so in its output instead of pretending the flags took. `--cap 0`
admits nodes and drives none of them, which is how a fleet can be populated
without a model.

## Delivery tiers

A queued message is never reported as a delivery. `inject` prints which tier it
used, and the inbox row records it:

- **A** - a turn was in flight and the child ran the steered text inside that
  turn (`delivered_tier = 'A'`). Written only from the driver's own
  `steer_delivered` event, because pi's acknowledgement means the text was
  queued, not delivered.
- **B** - the supervisor was up but the node was not streaming, so the message
  waits for the node's next turn.
- **C** - no supervisor was running; the message waits in the journal for the
  next supervisor that drives the node.

A turn retires a message only when the section the turn appends carries it: the
supervisor takes the ids from that section, and checks them against the prompt
before it writes anything. A charter that repeats the operator's instruction
word for word is therefore not read as a delivery - the coincidence is the one
thing this cannot be - and the message keeps waiting for a turn that really
carries it.

When a turn cannot carry a message at all (the node is done, or failed at its
attempt bound), the supervisor stamps the row `undeliverable` and `status`
counts it, rather than leaving a promise nobody keeps.

## Leases

A node is leased to one supervisor epoch at a time, so two supervisors never
drive the same node. The lease is held for as long as its owner answers for it:
exclusivity is the owner's liveness, not a clock, and reconciliation ends a
predecessor's lease only once that owner is gone. A supervisor whose turn runs
long - a tick under write contention can - keeps its node, which is the property
a wall-clock expiry would have broken.

The lease row therefore carries an `expires_at` column that means nothing. It is
kept because the build that shipped schema version 1 writes it by name, so a
store without it is a store that build cannot open; this build neither reads nor
writes it, and a store from the previous version has the column relaxed to
nullable with its stale values cleared the first time it is opened here. Read no
expiry into it.

## Asks and deadlines

An ask is a question a human can answer, with a deadline and a default. When the
deadline passes, the drain answers the ask from its own default and queues that
default as an ordinary message, so the node moves again. The claim and the queue
are one transaction: a supervisor killed between them leaves either both or
neither, and the drain is what a restart runs to recover.

Two supervisors may drain the same root: the claim is a conditional update, so
each overdue ask is answered exactly once and queued exactly once. If the store's
write lock is held by someone else, the drain waits and retries; a pass that
cannot finish is recorded as `store_deferred` (with the pass's name, the
attempts, the wait and the error) and only reported, never thrown at the
process. Because the store is exactly what cannot take that record, it is also
written to `<fleet-root>/store-deferred.json` while the lock is held and moved
into the journal by the first pass that gets through, so a supervisor killed with
the fact in hand still leaves it where `status` reads it. `status` prints both
facts when they exist.

## The journal

One file per fleet root, `<fleet-root>/fleet.sqlite`, in WAL mode with
`synchronous = FULL`. The tables, their columns, the invariants they hold and the
failure each column prevents are documented where they are defined -
[`../scripts/fleet/journal.mjs`](../scripts/fleet/journal.mjs) - and this page
does not restate them. Read them there before writing to a journal by hand.

The store records the schema version that wrote it. Opening a store that records
a version above the running build's is refused with one sentence naming both
numbers, rather than opened and left to fail inside a statement: that store's
shape belongs to a newer build, and the way forward is that build or a new root.
Opening an older store migrates it and records the new version, and the previous
build keeps its access: a rollback can open and write a store this build created,
because the column it needs was kept rather than dropped.

## Node versions

The journal is reached through one module,
[`../scripts/fleet/journal.mjs`](../scripts/fleet/journal.mjs), which is also
where the fleet answers what importing SQLite costs. `node:sqlite` says it is
experimental on stderr, once per process, at the import: true of every 24 release
before 24.15, and no longer true from 24.15, where the module became a release
candidate and stopped saying it. The floor `engines` declares is 24.0.0, so the
answer is installed at that import - the warning withheld by its own type and
text, for the length of the import only, with the emitter restored in a `finally`
so a warning from any other module still reaches stderr. It is not done with
`--disable-warning` or `NODE_OPTIONS`, which remove the whole
`ExperimentalWarning` class for the process and hide those along with it, and it
cannot be done with a `warning` listener at all - Node's default printer is
registered by the runtime and prints whether or not another listener exists.

Both workflows run Node 24, the line `engines` declares, so the gate that reports
red and the gate that decides a release see the same runtime. The answer costs
nothing on 24.15 and above, and goes with its test once the whole supported line
is past it.

## Where the code is

| File                                                                           | What it owns                                                      |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [`../scripts/fleet/cli.mjs`](../scripts/fleet/cli.mjs)                         | The four commands, argv, the help text, the tier reporting.       |
| [`../scripts/fleet/journal.mjs`](../scripts/fleet/journal.mjs)                 | The schema, the claim, the transaction, the busy timeout.         |
| [`../scripts/fleet/supervisor.mjs`](../scripts/fleet/supervisor.mjs)           | The loop, reconciliation, the drain, leases, the control socket.  |
| [`../scripts/fleet/driver-rpc.mjs`](../scripts/fleet/driver-rpc.mjs)           | The driver that runs a node through a real pi child.              |
| [`../scripts/fleet/driver-scripted.mjs`](../scripts/fleet/driver-scripted.mjs) | The deterministic driver the crash drill uses.                    |
| [`../scripts/fleet/tool-guard.mjs`](../scripts/fleet/tool-guard.mjs)           | The pre-execution guard that refuses a repeated effect on resume. |
| [`../scripts/fleet/procs.mjs`](../scripts/fleet/procs.mjs)                     | Process liveness and resident memory, read from the kernel.       |

The guarantee the supervisor is built around is narrower than "it resumes": no
completed effect is repeated and no node is silently lost, across a crash. The
tests that hold it are in
[`../test/runtime/fleet/`](../test/runtime/fleet/), and the crash drill is
[`../test/runtime/fleet/drill.mjs`](../test/runtime/fleet/drill.mjs).
