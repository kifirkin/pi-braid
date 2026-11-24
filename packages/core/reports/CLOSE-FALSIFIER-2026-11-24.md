# A close can record the gate that failed

Report: `packages/core/reports/CLOSE-FALSIFIER-2026-11-24.md`, on branch `worker/close-falsifier`.

This report lands one commit after the revision its result block names. That later commit
carries this file and no source change, so the evidence was read at the revision named and
still describes the branch.

## The two rules as they were

`close-worker` judged every recorded gate row with `findGateRowViolation`
(`packages/core/src/lib/orchestrator/workers.ts`) before storing it.

1. Predicate (d): `if (outcome === "completed" && exit !== 0)` refused a row that exited
   non-zero. A planted control is a command that exits non-zero on purpose, so the one row
   that proves a check can refuse was exactly the row the close would not store. A worker or
   seat could record only gates that had passed and had to describe the control in prose, in
   a commit message or a task summary, where nothing downstream reads it. The register could
   then not tell a close whose gates were proven able to fail from one whose were never tried.
2. Predicate (b): after stripping leading `VAR=value` assignments, the first token was
   resolved with `sh -c 'command -v "$1"'` from the orchestrator process's own directory. A
   worker's `./native/build/<binary>` is valid in the worktree it ran in and does not resolve
   in the seat's directory, so a row was refused although the command ran exactly as written.
   The workaround was to record absolute `/tmp/wt-...` paths, which a future reader cannot
   re-run.

## What changed

**(d) reads the expectation the row declares.** A gate row now carries an optional
`expect?: "pass" | "fail"` (`GateRowExpectation` in
`packages/core/src/lib/orchestrator/workers.ts`), defaulting to `"pass"`. Under a completed
outcome a `fail` row inverts the old rule: its non-zero exit is accepted and stored with the
code it produced, and its zero exit is a (d) violation whose detail says the falsifier proves
nothing. A row that declares nothing, or declares `pass`, keeps today's rule and today's
detail string character for character. Predicates (a), (b), (c) and (e) judge both kinds of
row: a falsifier is a command like any other, so a decorated, unparseable or unresolvable
falsifier row is still refused. The value is shape-checked where `stamp` is checked, so an
unreadable expectation is refused before any write instead of silently reading as `pass`.

**(b) resolves where the command ran.** `findGateRowViolation` takes a `GateRowReadOptions`
argument carrying `expect` and `cwd`, and the close path passes the row's own `cwd` from the
registry entry, so `command -v` runs from that directory. An entry that records no directory
keeps today's look-up. A directory that no longer exists resolves nothing: the look-up falls
back to this process's directory, and the message keeps its existing wording while naming the
directory the row claims.

**Carried end to end.** The `orchestrate` tool's `gates` schema publishes `expect` as a union
of `pass` or `fail` and states what the close does with each. `closeWorker` stores the field
on the row beside `stamp`, and an absent field stays absent so a row that declared nothing
writes none. The close report prints one line per stored row with the mark the row declared
(`ok` for a row that expects to pass, `fail` for a planted control) and says when a row
missed its expectation. `checkWorker`'s `gateSummary` counts each row against its own
declaration and appends how many rows expected to fail. `packages/core/src/lib/orchestrator/index.ts`
exports `GateRowExpectation`, `GateRowReadOptions`, `GATE_ROW_EXPECTATIONS`,
`parseGateRowExpectation`, `gateRowExpectation` and `gateRowExpectationMet`, so the typecheck
surface and any later reader share one definition of the rule.

## New tests

In `packages/core/test/runtime/orchestrator/test-close-gate-wellformedness.mjs`:

- `(d): a falsifier is recorded for the exit it produced, and a green falsifier is the violation`
- `(d) keeps today's refusal and today's detail for a row that expects to pass`
- `(d) is judged only under a completed outcome, whatever the row declared`
- `a falsifier row is still a command: (a), (b), (c) and (e) judge it`
- `the expectation readers default an absent or unreadable field to pass`
- `(b): the first token resolves in the directory the command ran in`
- `(b): a row that does not resolve in that directory is refused, naming it`
- `(b): with no cwd the look-up is this process's, and the detail keeps its shape`
- `(b): a directory that no longer exists is named, and the message is kept`
- `a planted falsifier closes in enforce mode: stored with its code, printed as fail`
- `enforce refuses a falsifier that passed, and stores nothing`
- `a close resolves the worker's own relative row from the worker's cwd`

In `packages/core/test/runtime/lib/test-worker-registry.mjs`:

- `closeWorker stores a row's declared expectation and it survives the read`
- `closeWorker refuses an unreadable expectation without writing`

The existing case `(d): exit 1 is refused under completed and accepted under the other
outcomes` is untouched and green. The new `pass`-row case pins the same detail string in a
second place rather than in place of it.

## The planted control

The control reverts the (d) inversion only: the expectation branch is removed from
`findGateRowViolation` and the unconditional `outcome === "completed" && exit !== 0` rule is
restored, with the cwd fix, the stored field, the tool schema and the report left in place.
`git diff --stat` for the reverted tree:

```
 packages/core/src/lib/orchestrator/workers.ts | 14 +-------------
 1 file changed, 1 insertion(+), 13 deletions(-)
```

Rebuilt with `npm run build -w packages/core`, then the close-gate file:

```
  [fail] (d): a falsifier is recorded for the exit it produced, and a green falsifier is the violation: a control that went red is well-formed evidence
  [fail] a falsifier row is still a command: (a), (b), (c) and (e) judge it: node scripts/check-result.mjs /tmp/close-falsifier-no-such-receipt.jsonl -> {"predicate":"d","detail":"exit 1 recorded under a completed outcome"}
  [fail] a planted falsifier closes in enforce mode: stored with its code, printed as fail: closeWorker: gates[1] fails predicate (d): exit 1 recorded under a completed outcome; cmd: node -e "process.exit(1)" (worker wf-falsifier, outcome completed)
  [fail] enforce refuses a falsifier that passed, and stores nothing: Missing expected rejection.
📊 Results: 23 passed, 4 failed
```

Restored with `git checkout -- packages/core/src/lib/orchestrator/workers.ts`, rebuilt, same
file:

```
📊 Results: 27 passed, 0 failed
```

The four red cases are the ones the inversion is in: the accepted red control, the falsifier
family case, and the two close-path cases. The `pass`-row case stayed green under the reverted
tree, which is what makes it a pin on the old rule rather than a second copy of the new one.

## The predicate (d) census

`closeGateRefusalLogPath()` (`~/.pi/agent/braid/orchestrator/close-gate-refusals.jsonl`) as
read before this change landed:

```
rows: 307 | a=163 b=77 c=13 d=52 e=2 | shadow=268 enforce=39
row range: 2026-10-16T22:59:09.795Z -> 2026-11-24T10:59:15.974Z
predicate (d) rows: 52
(d) range: 2026-10-19T20:23:59.831Z -> 2026-11-24T08:43:23.335Z
```

Rows whose own command line names a control are among the 52, for instance
`sh /private/tmp/skill-authoring/planted-control.sh` and
`node scripts/build-book.mjs --book practice --control caption-orphan`; each was recorded
under a completed close at a non-zero exit. Those two rows are the class this change exists
to admit, and the file keeps them: the count above is the before-picture the next census is
compared against.

## What I could not verify

- A live close through the model-facing `orchestrate` tool in a real seat session. The tool's
  schema and handler are driven here with a fake `ExtensionAPI` and a scratch project, which
  exercises the registered parameters object and the handler's text result, not a model's
  call and not the seat's own registry under `~/.pi/agent/braid/projects/`.
- A registry file written before the field existed, beyond the default. The absence path is
  covered by `gateRowExpectation` reading `pass` and by the `pass`-row case, not by a
  migration test over a real pre-change `workers.json`.
- Whether a seat reaches for a `fail` row voluntarily. The change makes the row storable and
  visible in the close report; it does not make anyone plant a control.
- Whether `verify-and-merge`'s population-stamp read and `check-result.mjs`'s stamp rule need
  to treat a `fail` row differently. A falsifier row carrying a `stamp` is compared like any
  other, and no recorded row pairs the two fields, so no test pins that combination.

## Placement

The expectation lives on the row, not in a separate `falsifiers: [...]` array on the entry,
for three reasons. The row is the unit (d) judges: the predicate reads one `{cmd, exit}` pair,
so a parallel array would have to be joined back by index, which is a second source of truth
that drifts as rows are retried or appended. `gate_evidence` is also the contract a worker's
result block carries: `check-result.mjs` reads `{cmd, exit}` rows, the merge path reads
`stamp` off the same rows, and a field on that row travels through the same schema,
validation, storage and report without a new wire format. And the default is additive: an
absent field reads as `pass`, so every row already in every project registry keeps its
meaning, and no version bump or migration is needed.

## Gate evidence

Run from the worktree on the revision the result block names:

```
npm run typecheck                                                                        exit 0
npm run lint                                                                             exit 0
node packages/core/scripts/check-placement.mjs --strict                                  exit 0 (PASS)
node --test packages/core/test/runtime/orchestrator/test-close-gate-wellformedness.mjs   exit 0 (27 passed, 0 failed)
node --test packages/core/test/runtime/lib/test-worker-registry.mjs                     exit 0 (59 passed, 0 failed)
npm test                                                                                 exit 0 (408 passed, 0 failed)
```

## Result block

```json
{
  "worker": "close-falsifier",
  "spec": "impl",
  "status": "completed",
  "output_file": "packages/core/reports/CLOSE-FALSIFIER-2026-11-24.md",
  "artifacts": [
    "packages/core/src/lib/orchestrator/workers.ts",
    "packages/core/src/lib/orchestrator/index.ts",
    "packages/core/src/extensions/orchestrator/index.ts",
    "packages/core/test/runtime/orchestrator/test-close-gate-wellformedness.mjs",
    "packages/core/test/runtime/lib/test-worker-registry.mjs",
    "packages/core/reports/CLOSE-FALSIFIER-2026-11-24.md"
  ],
  "gate_evidence": [
    { "cmd": "npm run typecheck", "exit": 0 },
    { "cmd": "npm run lint", "exit": 0 },
    { "cmd": "node packages/core/scripts/check-placement.mjs --strict", "exit": 0 },
    {
      "cmd": "node --test packages/core/test/runtime/orchestrator/test-close-gate-wellformedness.mjs",
      "exit": 0
    },
    { "cmd": "node --test packages/core/test/runtime/lib/test-worker-registry.mjs", "exit": 0 },
    { "cmd": "npm test", "exit": 0 }
  ],
  "claims": [
    {
      "claim": "A gate row declaring expect=fail records its non-zero exit under a completed close; the same row at exit 0 is refused with a detail saying the falsifier proves nothing; a row declaring pass or nothing keeps the existing refusal and its detail string.",
      "verified_by": "node --test packages/core/test/runtime/orchestrator/test-close-gate-wellformedness.mjs"
    },
    {
      "claim": "The first token of a row resolves from the worker's own cwd: the close accepts ./bin/tract-check where the worker's directory holds it and refuses it, naming that directory, where it does not.",
      "verified_by": "node --test packages/core/test/runtime/orchestrator/test-close-gate-wellformedness.mjs"
    },
    {
      "claim": "The close report prints a falsifier row as fail, a pass row as ok, and a stored row keeps expect across the registry write and read.",
      "verified_by": "node --test packages/core/test/runtime/lib/test-worker-registry.mjs"
    },
    {
      "claim": "The six gates of this report exit 0 on the branch, the full suite included.",
      "verified_by": "npm test"
    }
  ],
  "source_revision": "56e97fb0a484b603ba3a69995bceb8a0003f7254"
}
```
