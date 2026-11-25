# No-bash tools: filter, sink, feed

Measured at `611ab55` in a throwaway worktree on branch `worker/nobash/no-bash-tools`.

## What this is

A census of 121,097 bash calls over 60 days and 1,660 sessions (instrument
`census-bash-usage.mjs`, report research/NO-BASH-TOOL-INVENTORY-2026-11-22.md in the docs repository,
read for this work and not re-run here) classified the calls a tool could absorb. `run` already
covers the bare command, the heredoc and the output cap. Three classes had no tool: filtering a
producer's stream (22,013 calls, 18.2%), redirecting a stream to a file (19,308 calls, 15.9%), and
feeding one program's stdout into another (17,844 calls, 14.7%). This change adds those three as
argv-shaped tools, and each one is checked against the shell form it replaces rather than against a
description of it.

Those three figures are the census's, at its own revision of the corpus. They are quoted to say
which gap each tool closes; the tables below carry the commands that produce their numbers.

## Files touched

Declared before the first edit. Files marked "(outside the lock list)" are existing files the work
needed; nothing else outside the declared set was written.

| Path                                                                  | Class                 | Why                                                                                                                                                                |
| --------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/extensions/core/filter/index.ts`                   | new                   | the `filter` tool: schema, handler, rendering                                                                                                                      |
| `packages/core/src/extensions/core/filter/filter.ts`                  | new                   | the in-process readers (`head`, `tail`, `grep`, `wc -l`)                                                                                                           |
| `packages/core/src/extensions/core/sink/index.ts`                     | new                   | the `sink` tool: schema, handler, rendering                                                                                                                        |
| `packages/core/src/extensions/core/sink/sink.ts`                      | new                   | target resolution and the write itself                                                                                                                             |
| `packages/core/src/extensions/core/feed/index.ts`                     | new                   | the `feed` tool: schema, handler, rendering                                                                                                                        |
| `packages/core/src/extensions/core/feed/feed.ts`                      | new                   | the two-stage refusals and the hand-off                                                                                                                            |
| `packages/core/test/runtime/core/test-argv-tools.mjs`                 | new                   | the fixture that holds every bar below                                                                                                                             |
| `docs/NO-BASH-TOOLS-2026-11-24.md`                                    | new                   | this report                                                                                                                                                        |
| `packages/core/src/extensions/manifest.ts`                            | in the lock list      | three entries beside `run-tool`                                                                                                                                    |
| `packages/core/test/runtime/core/`                                    | in the lock list      | the fixture's directory                                                                                                                                            |
| `packages/core/src/extensions/core/run-tool/run.ts`                   | outside the lock list | the runner's stdin accepts bytes, a refusal names the tool that asked, and the offload copy and the stream-shape mapper moved here so four tools share one of each |
| `packages/core/src/extensions/core/run-tool/index.ts`                 | outside the lock list | calls the two moved helpers instead of keeping its own copies                                                                                                      |
| `packages/core/TOOLS.md`                                              | outside the lock list | three catalog rows and the two derived counts                                                                                                                      |
| `packages/core/src/extensions/core/prompt-builder/tool-guidelines.ts` | outside the lock list | three reflections, which the catalog parity fixture requires to equal the catalog rows                                                                             |
| `packages/core/src/extensions/core/AGENTS.md`                         | outside the lock list | the sub-extension table is the nearest contract for `core/`; `run-tool/` was missing from it and is added in the same table                                        |
| `packages/core/AGENTS.md`                                             | outside the lock list | the documented-tool count                                                                                                                                          |
| `packages/core/src/extensions/context-management/README.md`           | outside the lock list | the same count, restated                                                                                                                                           |
| `packages/core/README.md`                                             | outside the lock list | the extension count, re-derived from the manifest                                                                                                                  |
| `packages/core/docs/LOCAL_DEV.md`                                     | outside the lock list | the core fixture population, re-derived from the runner                                                                                                            |

Nothing was pushed, tagged or merged. `package-lock.json` was not touched and no install was run.

## The three tools

### `filter`

Runs one program and applies one filter to its stdout in this process. The filter is a reader over
the capture file; no second program is started, and the program's bytes are never decoded unless the
filter needs text.

| Parameter                  | Required         | Meaning                                                      |
| -------------------------- | ---------------- | ------------------------------------------------------------ |
| `argv`                     | yes              | the program and its arguments, one element each              |
| `through`                  | yes              | `head`, `tail`, `grep` or `wc`                               |
| `pattern`                  | only for `grep`  | the line pattern; a JavaScript regular expression, not a BRE |
| `lines`                    | no, default 10   | the line count for `head` and `tail`                         |
| `cwd`, `env`, `timeout_ms` | `timeout_ms` yes | as `run`                                                     |
| `max_output_bytes`         | no               | the same cap and the same refusal message as `run`           |

Two arguments are refused rather than ignored: a `pattern` with a reduction that cannot read it, and
`lines` with `wc`, which counts every line.

The producer's exit code is the answer the tool reports, and a failing producer is an error result.
The shell form differs here: `producer | head` answers with `head`'s status, so a producer that
exited non-zero looks like success. Byte equality is unaffected.

`tail` scans backwards from the end of the file, so its line count is exact at any file size and it
holds one chunk; `head`, `grep` and `wc` stream forward and hold one chunk.

### `sink`

Runs one program and writes its stdout and/or stderr to files.

| Parameter                  | Required         | Meaning                                            |
| -------------------------- | ---------------- | -------------------------------------------------- |
| `argv`                     | yes              | the program and its arguments                      |
| `stdout_to`, `stderr_to`   | one of the two   | destination paths, resolved against the tool's cwd |
| `cwd`, `env`, `timeout_ms` | `timeout_ms` yes | as `run`                                           |

Both paths are reported with the byte count written to each. A stream that is not redirected is
shown in the result under the default cap. Destinations are checked before the program starts, as
the shell checks a redirection before exec: a missing directory, a directory in place of a file, and
two destinations that resolve to one path are refusals, and a refused call starts no program.

`sink` has no `max_output_bytes`: the parameters this tool needs carry none, because a redirected
stream does not pass through the model. The stream it shows instead is bounded by the default cap.

### `feed`

Runs one program whose stdin is another program's stdout.

| Parameter                  | Required         | Meaning                                        |
| -------------------------- | ---------------- | ---------------------------------------------- |
| `from`                     | yes              | the producer's argv                            |
| `to`                       | yes              | the consumer's argv                            |
| `cwd`, `env`, `timeout_ms` | `timeout_ms` yes | for both stages; the timeout bounds each stage |
| `max_output_bytes`         | no               | applies to the consumer's streams              |

The consumer's exit is the tool's answer; the producer's exit, duration and byte count are reported
beside it. The producer runs to completion before the consumer starts, so the pipe cannot deadlock
and a consumer that exits early cannot leave the producer blocked. The producer's stream is held in
memory for that hand-off, and one past `MAX_FEED_BYTES` (33,554,432) is refused with its size named
rather than buffered.

## Bars, measured

Every row below was produced by `packages/core/test/runtime/core/test-argv-tools.mjs`, which runs the
tool and the shell form on the same producer in the same directory. The byte counts are the two
streams' own sizes, taken from the comparison the assertion makes.

### B1: `filter` reproduces the bash form

Producer `lines.txt`, ten newline-terminated lines (`alpha` … `kappa`).

| Shell form                   | Tool call                                   | Tool bytes | Shell bytes | Bytes equal             |
| ---------------------------- | ------------------------------------------- | ---------- | ----------- | ----------------------- |
| `cat lines.txt \| head -n 3` | `filter { through: "head", lines: 3 }`      | 17         | 17          | equal                   |
| `cat lines.txt \| tail -n 3` | `filter { through: "tail", lines: 3 }`      | 17         | 17          | equal                   |
| `cat lines.txt \| grep ta`   | `filter { through: "grep", pattern: "ta" }` | 31         | 31          | equal                   |
| `cat lines.txt \| wc -l`     | `filter { through: "wc" }`                  | 3          | 9           | same integer, see below |

`wc -l` is the one row where byte equality cannot hold: BSD `wc` pads a single count to eight
columns and GNU `wc` does not, so the padding is a property of the local binary, not of the count.
The fixture asserts the exact integer (`10`), the tool's bytes (`"10\n"`), and that the shell's
output trimmed equals the tool's (`"      10"` and `"10"`), which pins the difference to whitespace.

A final line with no newline is measured too: for `a\nb\nc` and `tail -n 2` the tool's stream is the
shell's three bytes (`"b\nc"`), and the rendered section carries one newline the stream does not
have, which is the display convention every captured stream in this family follows. The fixture
asserts both facts.

### B2: `sink` writes what the redirect writes

Producer `node prog.js` writes `stdout-bytes-ü` (15 bytes, one two-byte character) and
`stderr-bytes` (12 bytes). The same program runs twice: once under
`node prog.js > shell-out 2> shell-err`, once through `sink`.

| Stream | Tool file bytes | Shell file bytes | Bytes equal |
| ------ | --------------- | ---------------- | ----------- |
| stdout | 15              | 15               | equal       |
| stderr | 12              | 12               | equal       |

The reported counts (`stdout_bytes` 15, `stderr_bytes` 12) equal the files' own sizes, and the
result text names each absolute path with its count. A second case redirects stdout only: the file
holds `kept`, the stderr stream is shown in the result, and no `stdout` stream is reported because
it was written rather than shown.

### B3: `feed` passes bytes

The producer is `cat in.bin` over one mebibyte built deterministically with a lone carriage return
at offset 100, a NUL at 101, and bytes UTF-8 cannot carry. The consumer hashes its stdin and prints
the digest and the length.

| Measure                     | Value                                           |
| --------------------------- | ----------------------------------------------- |
| producer bytes              | 1,048,576                                       |
| bytes the consumer saw      | 1,048,576                                       |
| digest the consumer printed | `5c822b6a…8094c`, equal to the payload's sha256 |
| producer exit reported      | 0                                               |

A second case sends `one\ntwo\nthree\n` through `from: ["cat","in.txt"], to: ["cat"]` and asserts
the consumer's stdout is that text byte for byte. A third asserts the answer is the consumer's exit
(the producer exits 4, the consumer 0, the result is not an error and the text reports `from: exit 4`).

### B4: no shell surface

The fixture drives every operator through every tool. Fifteen cases for the single-argv tools, and
ten more for `feed` (each operator in `from` and in `to`), plus a shell command string.

| Tool     | Operators refused                    | Refusal names                               |
| -------- | ------------------------------------ | ------------------------------------------- |
| `filter` | `\|`, `&&`, `;`, backtick, `$(`      | `argv[1]` and the quoted element            |
| `sink`   | the same five                        | `argv[1]` and the quoted element            |
| `feed`   | the same five, in `from` and in `to` | `from[1]` or `to[1]` and the quoted element |

Quoted, verbatim:

```
refused: argv[1] carries "|". filter executes argv directly and never through a shell, so the
operator would be a literal argument. Argument: a|b
```

```
refused: argv[1] carries ";". sink executes argv directly and never through a shell, so the
operator would be a literal argument. Argument: a;b
```

```
refused: to[1] carries "$(". feed executes argv directly and never through a shell, so the
operator would be a literal argument. Argument: a$(b)
```

```
refused: argv[0] is a shell and argv carries -c, so this is a command string rather than a program
call. filter does not hand commands to a shell. Use bash, or pass the program and its arguments
directly.
```

The tool name in those messages comes from the caller through `RunContext.toolName`; the message
text and the operator list are `run`'s, so a fifth argv tool inherits both by passing its name.

### B5: the cap is the existing cap

| Case                              | Producer                    | Result                                                                                                |
| --------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `filter` past the cap             | 1 MiB through `grep .`      | `truncated: true`, 1,048,577 bytes, shown 2,036, dropped 1,046,541, offload file 1,048,577 bytes      |
| `feed` past the cap               | 1 MiB through `cat`         | `truncated: true`, 1,048,576 bytes, shown plus dropped equal the stream, offload file 1,048,576 bytes |
| `filter` below `MIN_OUTPUT_BYTES` | `max_output_bytes: 1023`    | refused, message equal to `run`'s for the same value                                                  |
| `feed` above `MAX_OUTPUT_BYTES`   | `max_output_bytes: 1048577` | refused, message equal to `run`'s for the same value                                                  |

The cap-refusal assertion does not compare against a copied literal: the fixture calls `run` with the
same value and asserts the two results' text are equal.

```
refused: max_output_bytes must be an integer from 1024 to 1048576; got 100.
```

```
refused: max_output_bytes must be an integer from 1024 to 1048576; got 1048577.
```

The constants are imported, not restated: `boundStream`, `DEFAULT_OUTPUT_BYTES`,
`MIN_OUTPUT_BYTES`, `MAX_OUTPUT_BYTES`, `MAX_TIMEOUT_MS`, `describeStream` and `offloadText` all come
from `run-tool/run.ts`, and the fixture asserts the default is 51,200.

The producer ceiling:

```
refused: from wrote 35651584 bytes, past the 33554432-byte limit this tool holds in memory before it
starts the consumer. Send it to a file with sink and read that file, run a producer that writes less,
or use bash if a live pipe is what you need.
```

### B6: the tools arrive where `run` arrives

The manifest registers `filter`, `sink` and `feed` as three entries immediately after `run-tool`,
none of them `alwaysOn`, each with its factory and description; the fixture asserts the ids, the
order, the factory and the absence of `alwaysOn`. In the full core suite the fixture passes as
`core/test-argv-tools.mjs`, and the three fixtures that police this surface pass unchanged:
`test-manifest-consistency.mjs` (every extension directory has a manifest entry and no entry is
dangling), `test-tool-exposure-deferral.mjs` (nothing outside the deferred inventory is deferred),
`test-tool-pipelines.mjs` (the catalog rows and `TOOL_GUIDELINES` are the same set with the same
strings).

## The planted control

A bar that cannot redden is not a bar, so the `head` reader was broken and restored, and the
fixture run at each step.

**Red.** `filter.ts`, the head branch of `forwardFilter`, changed from `linesWritten >= request.lines`
to `linesWritten >= request.lines + 1000`, then `npm run build`:

```
  ✖ head keeps the same bytes as `cat lines.txt | head -n 3` (40.487117ms)
  AssertionError [ERR_ASSERTION]: bytes differ in length:
  through head: kept 10 lines (57 bytes)
ℹ tests 39
ℹ pass 38
ℹ fail 1
```

**Restored.** The original file back in place, `npm run build`, same command:

```
ℹ tests 39
ℹ pass 39
ℹ fail 0
```

Exactly one case moved, and it is the `head` bar. The sed-free restore was checked by re-running the
whole fixture, not by trusting the copy.

**Second sensitivity, for B3.** The whole point of `feed` is that the pipe carries bytes, so the
hand-off was changed once from `stdin: input.bytes` to `stdin: input.bytes.toString("utf8")`:

```
  ✖ hands a binary producer stream to the consumer unchanged (306.141682ms)
    actual: 'c1e1ffdb14671f379b8e0bbbd63d6bc074e831ae7dade87faebf97f816897908 2097148\n'
    expected: '5c822b6aef67015f73c91acf8ae41b77ac0adf822d05b0c9912cc7fba038094c 1048576\n'
```

A UTF-8 round trip turns 1,048,576 bytes into 2,097,148 and changes the digest, so the assertion is
red on the defect the widening of `RunRequest.stdin` exists to prevent. Restored, rebuilt, 39 of 39
green again.

## Gates

Run from the worktree, in this order, at the tree that was committed.

| Command                                   | Exit | Tail                                                                                                                                                                       |
| ----------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                       | 0    | `pi-braid-telegram@0.3.2 typecheck` / `tsc --noEmit`                                                                                                                       |
| `npm run lint`                            | 0    | eslint over the four source globs and the fixture globs, no findings                                                                                                       |
| `npm test`                                | 1    | `407 passed, 2 failed, 0 timed out in 5m28s`; the two failures are pre-existing, below                                                                                     |
| `npm run check:placement -- --strict`     | 1    | `Placement check (strict): 1269 tracked files scanned of 1269 tracked at worker/nobash/no-bash-tools`; `Totals: 2 hit(s) reported, 359 excluded`; both pre-existing, below |
| `npm run check:extension-api -- --strict` | 0    | `346 files, 244 ctx accesses, 0 unclassified`                                                                                                                              |
| `npm run check:doc-dates`                 | 0    | `Doc dates gate: PASS (0 residue hits)`                                                                                                                                    |
| `npm run check:source-claims`             | 0    | `clean - 7 stated count(s) re-derived from 4 document(s)`                                                                                                                  |
| `npm run check:doc-drift`                 | 0    | `Derived doc references: 125 doc(s), 0 queued fix(es) (0 row(s))` (the span and identifier counts move with this file's own backticks, so they are not quoted)             |

The fixture on its own, at the committed tree:

```
node test/runtime/core/test-argv-tools.mjs
ℹ tests 40
ℹ pass 40
ℹ fail 0
ℹ duration_ms 923.728977
```

The scoped legs of the chain were also run and all exit 0: `check:docs`, `check:instruction-strings`,
`check:doc-links`, `check:prose-punctuation`, `check:suite-coverage`, `check:deps`, `check:labels`,
`check:schema`, `check:settings-docs`. The full `npm run ci:check` is the seat's run at merge, not
this worker's.

The block at the end of this file carries the rows that pass. The two rows above that exit 1 are
not in it, because a close reads every row as a claim that the command passed; their exits and their
diagnosis are recorded here instead.

### Two red gates at the base revision, not from this change

`check:placement --strict` exits 1 on two ISO-date tokens in `scripts/dead-code-census.mjs` (lines 5
and 808), which reference the audit file in `docs/`. Both are in the base tree:

```
# in the worktree at this branch
Placement check (strict) — 1269 tracked files scanned of 1269 tracked at worker/nobash/no-bash-tools
  Totals: 2 hit(s) reported, 359 excluded

# in the primary checkout at main
node packages/core/scripts/check-placement.mjs --strict
Placement check (strict) — 1261 tracked files scanned of 1261 tracked at main
  Totals: 2 hit(s) reported, 359 excluded
```

The same two hits in both, and this change adds none: its files report 0 provenance-token, 0
domain-literal and 0 owner-path hits (the population grew by the eight files declared above, 1261 to
1269).

`lib/test-placement-budget.mjs` and `lib/test-placement-summary-line.mjs` fail because they run that
gate and require exit 0. Both fail identically in the primary checkout at the base revision:

```
node packages/core/test/runtime/lib/test-placement-budget.mjs
  ✖ stays within budget on the current tree
ℹ tests 3, pass 2, fail 1

node packages/core/test/runtime/lib/test-placement-summary-line.mjs
exit 1
```

Both files are outside the declared file set and were not touched.

### A third red gate at the base revision: `check:journal`

`npm run check:journal` exits 2 with `findings: ABSENT 1, UNRESOLVED 5, ROTATED 10, DANGLING 0`. The
findings are journal entries naming paths outside either root: /tmp/my-cap-gate.mjs,
reports/ADVERSARIAL-INSTRUMENTS-2026-11-20.md and an older
~/.pi/agent/braid/journal/journal-2026-11-20.jsonl from before the rotation. The gate resolves each
against the tree it runs in. The same run in the primary checkout at the base revision
exits 2 with the same findings, so the red is state in the braid journal rather than anything in
this tree. It is reported here and not touched: the journal lives in the braid home, not in the
repository.

## Placement

- **The cap, the capture pipeline and the offload are one implementation, in `run-tool/run.ts`.**
  `boundStream`, the four constants, `describeStream`, `offloadText`, `executeArgv`, `findRefusal`
  and `capturePathFor` live there, and `run`, `filter`, `sink` and `feed` all call them. A second
  implementation of the cap would be a second answer to "how much of this stream does the model
  see", and the brief names that as a defect.
- **The destructive-verb guard stays in `lib/tools/workspace-guard.ts`.** `findRefusal` passes
  `DESTRUCTIVE_VERBS` to `findWorkspaceEscape`; the three new tools get the guard by calling
  `findRefusal`, so one verb set and one escape message serve four tools. A tool with its own verb
  set would pass it to the same mechanism, which is the extension point the guard already exposes.
- **The refusal text is the caller's, the rule is shared.** `RunContext.toolName` decides which tool
  the message names; the operator list, the glob rule and the shell-string rule stay one copy. The
  same channel relabels a `feed` stage (`from[1]`, `to[1]`).
- **What each tool owns is what only it knows.** `filter/filter.ts` owns the four readers (their
  bounds, their line semantics, the `wc` count); `sink/sink.ts` owns destination resolution (the
  checks the shell performs before exec); `feed/feed.ts` owns the two-stage refusals and the byte
  hand-off. None of these is shared with another tool, and none of them re-implements the cap.
- **Registration, the catalog and the prompt row are three mirrors with one test holding them
  equal.** `manifest.ts` wires the extension ids; `TOOLS.md` is the catalog a reader browses;
  `TOOL_GUIDELINES` is the line the prompt renders. `test-tool-pipelines.mjs` requires the last two
  to be the same tool set with identical strings, so a row added to one and not the other fails a
  test rather than drifting.
- **Counts are derived, never remembered.** 34 extensions is the manifest's `id:` count (README),
  37 documented tools is the catalog's row count (TOOLS.md twice, `AGENTS.md`, the
  context-management README), and 409 fixtures and 168 `node:test` files are the runner's own
  `--list` (LOCAL_DEV). Each was re-derived after the change with the command the gate re-runs.
- **Two homes were rejected.** A `lib/tools/streams.ts` would make a lib module import
  `boundStream` from an extension directory, inverting the layering the package states; an
  `argv-tools/` namespace directory would read as an extension that is not one (a directory under
  `core/` without an `index.ts` is invisible to the manifest-consistency check). The shared pieces
  already have a home in `run-tool/run.ts`, which is where a fifth argv tool should look first.

## What this did not measure

The census classes that remain, with the census's own counts (its instrument, its corpus revision;
not re-run here because the corpus is live and a re-run answers a different question):

- **A chain, `&&` or `;`: 97,241 calls (80.3%).** Two `run` calls or a script file; still not one
  call. `feed` closes only the two-stage pipe.
- **A pipe into something other than `head`/`tail`/`wc`/`grep`: 43,412 calls (35.8%).** `sort`,
  `uniq`, `cut`, `jq`, `awk` and `rg` are not reductions this tool implements. `filter` covers four
  of the consumers the census named.
- **A redirect into `/dev/null`: 24,404 calls (20.2%).** `sink` writes a file; discarding a stream
  has no tool. It is a redirect class the census counts separately from redirect-into-a-file.
- **Command substitution inside a command's arguments** (the much larger part of the 17,844
  substitution calls): `feed` covers a whole producer stream as a consumer's stdin, not
  `git commit -m "$(cat msg)"`. That shape stays bash.
- **Loops.** The census's shape table does not separate a loop from a chain, so no count for loops
  alone exists in it and none is stated here.
- **Both streams into one file.** Refused by `sink` by name (`one-target`), because interleaving with
  no ordering is not something a tool can report honestly. The census does not count this shape
  separately either; it sits inside the 19,308 redirect calls.
- **A final line with no newline, for `head`.** Measured for `tail`, `grep` and `wc`; `head` shares
  the same reader but the case was not run against the shell. The reader's behaviour is one code
  path, and the fixture covers the other three.
- **`grep` semantics beyond a plain pattern.** The pattern is a JavaScript regular expression, so
  `\(`, `\|` and back-references mean what they mean in JavaScript and not what they mean in a
  basic regular expression. The fixture compares one literal pattern; nothing here claims BRE
  compatibility.
- **Windows.** `run` spawns detached on POSIX and falls back to a direct kill elsewhere; nothing in
  this change was exercised on a platform without a POSIX process group.

## Result block

`check-result.mjs` reads this block from the session transcript. The revision names the commit whose
tree the measurements were read at. This file was edited after it (the block, this note, and one
section added from a later gate run), so the branch tip differs from that commit in this file only:
`git diff 5e4e57f HEAD --stat` names one path.

```json
{
  "worker": "nobash",
  "spec": "impl",
  "status": "completed",
  "source_revision": "5e4e57f",
  "output_file": "/tmp/wt-nobash/docs/NO-BASH-TOOLS-2026-11-24.md",
  "artifacts": [
    "packages/core/src/extensions/core/filter/index.ts",
    "packages/core/src/extensions/core/filter/filter.ts",
    "packages/core/src/extensions/core/sink/index.ts",
    "packages/core/src/extensions/core/sink/sink.ts",
    "packages/core/src/extensions/core/feed/index.ts",
    "packages/core/src/extensions/core/feed/feed.ts",
    "packages/core/test/runtime/core/test-argv-tools.mjs",
    "packages/core/src/extensions/manifest.ts",
    "packages/core/src/extensions/core/run-tool/run.ts",
    "packages/core/src/extensions/core/run-tool/index.ts",
    "packages/core/TOOLS.md",
    "packages/core/src/extensions/core/prompt-builder/tool-guidelines.ts",
    "packages/core/src/extensions/core/AGENTS.md",
    "packages/core/AGENTS.md",
    "packages/core/src/extensions/context-management/README.md",
    "packages/core/README.md",
    "packages/core/docs/LOCAL_DEV.md"
  ],
  "gate_evidence": [
    {
      "cmd": "npm run typecheck",
      "exit": 0
    },
    {
      "cmd": "npm run lint",
      "exit": 0
    },
    {
      "cmd": "node test/runtime/core/test-argv-tools.mjs",
      "exit": 0
    },
    {
      "cmd": "node test/runtime/core/test-run-tool.mjs",
      "exit": 0
    },
    {
      "cmd": "node test/runtime/core/test-tool-pipelines.mjs",
      "exit": 0
    },
    {
      "cmd": "node test/runtime/core/test-tool-exposure-deferral.mjs",
      "exit": 0
    },
    {
      "cmd": "node test/runtime/test-manifest-consistency.mjs",
      "exit": 0
    },
    {
      "cmd": "npm run check:extension-api -- --strict",
      "exit": 0
    },
    {
      "cmd": "npm run check:doc-dates",
      "exit": 0
    },
    {
      "cmd": "npm run check:source-claims",
      "exit": 0
    },
    {
      "cmd": "npm run check:doc-drift",
      "exit": 0
    },
    {
      "cmd": "npm run check:docs",
      "exit": 0
    },
    {
      "cmd": "npm run check:prose-punctuation",
      "exit": 0
    },
    {
      "cmd": "npm run check:doc-links",
      "exit": 0
    },
    {
      "cmd": "npm run check:suite-coverage",
      "exit": 0
    },
    {
      "cmd": "npm run check:commit-subjects",
      "exit": 0
    },
    {
      "cmd": "git ls-files | wc -l",
      "exit": 0,
      "stamp": "scanned 1269 files at 5e4e57f"
    }
  ],
  "claims": [
    {
      "claim": "filter reproduces head, tail and grep byte for byte, and wc -l's integer",
      "verified_by": "node test/runtime/core/test-argv-tools.mjs",
      "predicts": "the filter cases compare 17, 17 and 31 bytes equal and the run prints 40 pass",
      "evidence": "17/17, 17/17 and 31/31 bytes equal; wc asserts 10 against the shell's 10"
    },
    {
      "claim": "sink writes the shell redirect's bytes and reports the files' own sizes",
      "verified_by": "node test/runtime/core/test-argv-tools.mjs",
      "predicts": "the sink case compares 15 and 12 bytes equal and reports counts equal to the files' sizes",
      "evidence": "stdout 15/15, stderr 12/12, details equal statSync sizes"
    },
    {
      "claim": "feed passes bytes through the pipe, not a UTF-8 round trip",
      "verified_by": "node test/runtime/core/test-argv-tools.mjs",
      "predicts": "the consumer prints the payload's sha256 over 1,048,576 bytes",
      "evidence": "1,048,576 bytes in, same sha256 out; the string hand-off turned it into 2,097,148 bytes"
    },
    {
      "claim": "the head bar reddens when the reader is broken and returns to green when restored",
      "verified_by": "node test/runtime/core/test-argv-tools.mjs with the head bound planted",
      "predicts": "the head case fails with 38 pass 1 fail, and restored the run exits 0 with 39 pass",
      "evidence": "planted lines+1000 bound: 38 pass 1 fail; restored: 39 pass 0 fail"
    },
    {
      "claim": "all five shell operators are refused by all three tools with the stage and element named",
      "verified_by": "node test/runtime/core/test-argv-tools.mjs",
      "predicts": "the run exits with 25 refusals naming argv[1], from[1] or to[1]",
      "evidence": "5 operators through filter, sink and feed's from and to"
    },
    {
      "claim": "the output cap is run's cap, including its refusal message",
      "verified_by": "node test/runtime/core/test-argv-tools.mjs",
      "predicts": "the offload files hold 1,048,577 and 1,048,576 bytes and the refusals equal run's text",
      "evidence": "truncation files hold those sizes; cap refusal text equal to run's for 1023 and 1048577"
    },
    {
      "claim": "the catalog, the prompt reflections and the registered tools are the same set",
      "verified_by": "node test/runtime/core/test-tool-pipelines.mjs",
      "predicts": "the fixture exits 0 with TOOLS.md and TOOL_GUIDELINES both carrying 37 rows",
      "evidence": "test-tool-pipelines.mjs and test-manifest-consistency.mjs exit 0; check:doc-drift re-derives 37 documented rows"
    },
    {
      "claim": "the two red gates are red at the base revision, not from this change",
      "verified_by": "npm run check:placement",
      "predicts": "the gate reports the same count in both trees: 2 hits and 359 exclusions",
      "evidence": "same totals at main (1261 files) and here (1269); the two placement fixtures fail identically in the primary checkout"
    }
  ],
  "blocked_reason": null,
  "next": "The seat's ci:check at merge. The two pre-existing placement hits in scripts/dead-code-census.mjs (lines 5 and 808) are outside this work and need their own decision."
}
```
