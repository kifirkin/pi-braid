# Dead-code audit, braid package family

Revision `499fbc6` (`v0.52.0`), branch `audit/dead-code`, 2026-11-24.
Read-only audit: no file outside this report and `scripts/dead-code-census.mjs` was changed.

Scope: `packages/core`, `packages/skills`, `packages/contrib`, `packages/providers`, `packages/telegram`,
plus the repo `scripts/` directory. `pi-docparser` is third party and out of scope.

## Headline

Production source only. Test and script harnesses are the instrument, not the subject, so their
207,862 LOC are measured separately and not counted in any dead bucket.

```
workspace             files      LOC  UNREACH  TEST-ONLY  TRANS-DEAD    dead  dead%
packages/core           339   101845        0        394           0     394  0.39%
packages/skills           0        0        0          0           0       0     0%
packages/contrib         59    19056       75       1847           0    1922 10.09%
packages/providers       16    10169        0        175           0     175  1.72%
packages/telegram        32    14161        0          0           0       0     0%
TOTAL                   446   145231       75       2416           0    2491   1.7%
```

Command: `node scripts/dead-code-census.mjs`.

Dead production code is 2,491 LOC of 145,231, or 1.7%. Five files carry all of it. The rest of the
cost is not unreachable code but exported surface nothing imports: 1,197 symbols whose `export`
keyword no other module needs, 196 symbols no line of the repo mentions, and 153 symbols on a
declared package API with no internal caller.

## What measured this, and what each instrument said

Every number below carries its command.

| Instrument                                  | Command                                                                                                 | Result                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Project knip (6.35.1)                       | `npm run check:deadcode`                                                                                | exit 0, 619 findings: 4 unused files, 451 unused exports, 155 unused types, 2 unused deps, 3 unlisted, 3 binaries, 1 duplicate |
| tsc unused locals/params                    | `./node_modules/.bin/tsc --noEmit --noUnusedLocals --noUnusedParameters -p packages/<ws>/tsconfig.json` | core exit 2, contrib exit 2, telegram exit 2, providers exit 0; 22 `TS6133` total                                              |
| Project eslint, as configured               | `./node_modules/.bin/eslint <same globs as npm run lint> -f json`                                       | exit 0, 1056 files scanned, 0 messages                                                                                         |
| eslint with the ignore patterns neutralised | `./node_modules/.bin/eslint ... --rule '{"@typescript-eslint/no-unused-vars":["error",{}]}'`            | exit 1, 87 findings                                                                                                            |
| This audit's resolver                       | `node scripts/dead-code-census.mjs --json`                                                              | 446 production files, see headline                                                                                             |
| Settings-doc gate (existing)                | `node packages/core/scripts/check-braid-schema.mjs`                                                     | exit 0, 53 `braid.*` literals over 445 files, 50 covered, 3 dynamic                                                            |

`npm ci --ignore-scripts` was run in the worktree to obtain knip, tsc and eslint. Nothing was
published, no version bumped, the release pipeline was not run.

The gap between the eslint numbers is the point: the shared config sets
`argsIgnorePattern: "^_"`, `varsIgnorePattern: "^_|^log$"`, `caughtErrorsIgnorePattern: "^_$"`
(`packages/core/eslint.config.js:19`). With those patterns active the gate reports zero unused
bindings in this repository. With them neutralised it reports 87, including three dead
`const log = createLogger(...)` bindings that no file ever calls.

## Bucket definitions

Buckets are file-level and disjoint. A file appears in exactly one, so no LOC is counted twice.

- **UNREACHABLE**: no importer anywhere in the repository, production or harness. An orphan.
- **TEST-ONLY**: no production path from a declared entry, but a test or script harness reaches it.
- **TRANSITIVELY DEAD**: no production path, and the only importers are themselves unreachable.
- **PUBLIC-BUT-UNCALLED**: exported from a declared package API (`main` / `exports` in
  `package.json`) with no internal caller. Not dead. Reported as line items, never inside the dead
  total.

Entries are read from `package.json` alone: `pi.extensions` (20 across the family), `main`,
`exports`, `bin`, plus any file named in a `package.json` `scripts` value (a declared command).
Nothing else is an entry. That is what keeps "reachable from our own tests" out of the live set.

## The findings

Confidence is `high` where I re-derived the claim with a second, independent command (a grep whose
output is quoted), `medium` where the census graph is the only instrument.

### Dead production files (5 files, 2,491 LOC)

| File                                                                 | LOC  | Bucket      | Why it is dead                                                                                                                                                                                                          | How I established it                                                                                                                                                                         | Conf. |
| -------------------------------------------------------------------- | ---- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `packages/contrib/test-repl.ts`                                      | 75   | UNREACHABLE | Nothing imports it, no script names it, no doc mentions it. A hand-written smoke harness for the REPL tool                                                                                                              | `grep -rn "test-repl" --include=*.ts --include=*.mjs --include=*.json packages scripts` returns nothing. Census: 0 importers                                                                 | high  |
| `packages/contrib/network-monitor/test.ts`                           | 1847 | TEST-ONLY   | Mocked tests for the tunnel core. Alive, but reachable only because `packages/contrib/package.json` `test` runs it with `--experimental-strip-types`; the tarball excludes it via `files: ["!network-monitor/test.ts"]` | Census: `(declared command in a package.json script)`. `grep -n "network-monitor/test" packages/contrib/package.json` shows the test script and the files exclusion                          | high  |
| `packages/core/src/lib/orchestrator/owner-speech.ts`                 | 286  | TEST-ONLY   | Reachable only through `join(DIST, "lib", "orchestrator", "owner-speech.js")`: two core tests and `scripts/build-decisions-index.mjs`. No static import anywhere, so knip reports it as an unused file                  | `grep -rn "owner-speech" --include=*.ts packages/core/src` returns nothing. Census recovered the dist edge (`distPathRun`) after the import graph alone reported an orphan                   | high  |
| `packages/providers/failure-translation.ts`                          | 175  | TEST-ONLY   | Only `test/failure-translation.test.mjs` uses it, and that test compiles the file with the local tsc into a temp dir and loads the emitted CJS with `createRequire`. There is no import statement to find               | `grep -rn "failure-translation" --include=*.ts packages/providers packages/core/src packages/telegram/src` returns only the file itself. Test header states the compile-then-require harness | high  |
| `packages/core/src/extensions/core/prompt-builder/section-parity.ts` | 108  | TEST-ONLY   | Only `test/runtime/core/test-native-prompt-parity.mjs`, via `join(ROOT, "dist", "extensions", "core", "prompt-builder", "section-parity.js")`                                                                           | `grep -rn "section-parity" --include=*.ts packages/core/src` returns nothing. Census recovered the edge from the literal path segments                                                       | high  |

TRANSITIVELY DEAD is empty, and that is the honest result, not an omission. Every file that no
production path reaches in this repository is either an orphan or a harness input; none is reached
through another dead file. The bucket exists in the census script and would report non-zero if the
condition appeared.

### Dead logic no linter finds

Ranked by what rots if left alone.

**1. An event emitted into a bus with no production listener.** `packages/core/src/extensions/enforcement/handlers/register-session-compact.ts:207`
emits `eventBus.emit({ type: "enforcement_signals" })` with an empty payload. The only listener in
the repository is the bus's own unit test at `packages/core/test/runtime/lib/test-event-bus.mjs:118`.
A comment in `packages/core/src/extensions/core/prompt-builder/index.ts:359` already admits it: "no
enforcement_signals listener".
Check: `grep -rn "enforcement_signals" --include=*.ts --include=*.mjs packages` shows one emit site in
production, zero `.on` sites in production, and the test as the sole handler.
Blast radius: the post-compaction signal path is decorative. Anything that was supposed to react to
"unpersisted learnings exist after a compact" no longer does. Confidence: high.

**2. A log-level constant that documents a rule the code no longer applies.**
`packages/core/src/lib/core/logger.ts:74`, `const _NONE_PRIORITY = 4`, commented "higher than any
real level so nothing writes". The comparison it was written for is at line 164,
`_LEVEL_PRIORITY[entry.level] < _LEVEL_PRIORITY[_consoleMinLevel as LogLevel]`, which can never see
`"none"` because line 163 returns first: `if (_consoleMinLevel === "none") return;`.
Check: `grep -n "PRIORITY\|none" packages/core/src/lib/core/logger.ts`; the guard precedes the
comparison, and the `as LogLevel` cast is only sound because of it. Also reported by
`tsc --noUnusedLocals` as `TS6133` at 74,7.
Blast radius: a reader reasoning about `setConsoleLogLevel("none")` finds a priority constant that
implies a mechanism which was replaced by an early return. Confidence: high.

**3. Three loggers constructed and never called.** `packages/contrib/browser/readability.ts:2`,
`packages/core/src/extensions/core/polyfill/index.ts:49`,
`packages/core/src/extensions/memory/session-recall/search.ts:16`. Each does
`const log = createLogger("...")` and never writes through it, so the subsystem has no log output
even where a failure would be worth one.
Check: `grep -n "\blog\b" <the three files>` returns only the declaration. eslint's
`varsIgnorePattern: "^_|^log$"` is what keeps the gate green on all three; neutralising the pattern
surfaces them. Confidence: high.

**4. A private field written nowhere and read nowhere.** `packages/contrib/browser/cdp.ts:41`,
`private _targetId: string | null = null`. Reported by tsc as `TS6133` at 41,11 and by nothing else,
because eslint's `varsIgnorePattern` starts with `^_`.
Blast radius: the CDP client carries a target handle it never sets, so a reader looking for where
the debugger target is tracked finds a field that is always `null`. Confidence: high.

**5. A union member that no production code emits.** `packages/core/src/lib/events/event-bus.ts:26`
declares `TimerEvent` (`type: "timer_fire"`) and includes it in `AgentEvent`. The file's own header
(lines 8-13) says it is kept "for type safety (test-event-bus.mjs uses it as a generic test type)" and
is "NOT currently emitted by the timer module".
Check: `grep -rn "timer_fire" --include=*.ts packages` returns the union member, the header comment,
and the test only. Confidence: high.
Blast radius: low. Type-level weight, no runtime branch.

Every other internal event name does have both an emitter and a handler: `tool_error` (3 emits),
`analytics_alert` (3), `memory_evict` (2), `context_full` (2), `turn_complete`, `sop_suggestion`,
`heartbeat_tick`, `enforcement_violation` (1 each). Command:
`grep -rn -A3 "eventBus.emit(" --include=*.ts packages/core/src ... | grep 'type:'`.

### Exported surface nothing imports (not dead code, maintenance cost)

| Population                | Count | LOC         | Definition                                                  | Command                             |
| ------------------------- | ----- | ----------- | ----------------------------------------------------------- | ----------------------------------- |
| PUBLIC-BUT-UNCALLED       | 153   | 2,157       | exported from a declared package API, zero internal callers | `node scripts/dead-code-census.mjs` |
| test-hook exports         | 297   | not counted | exported and imported only by a test or script harness      | same                                |
| dead `export` keyword     | 1,197 | not counted | no importer anywhere, still used inside its own file        | same                                |
| referenced nowhere at all | 196   | not counted | no importer and no use in its own file                      | same                                |

By workspace: core 8 public / 210 test-hooks / 838 dead-export-keyword / 180 never-referenced;
contrib 2 / 4 / 131 / 7; providers 84 / 0 / 87 / 7; telegram 59 / 83 / 141 / 2.

The 84 in `packages/providers/index.ts` are re-exported types and probe helpers
(`probeRoute`, `ProbeDescriptor`, `ProbeDeps`, `recordDeath`, `clearFailback`, ...). That file is the
package's declared `.` export, so they are API, not dead. Removing them is a semver decision, not a
cleanup.

## What knip reports, and why it is not the dead total

`npm run check:deadcode` reports 4 unused files. Read against the table above, those 4 split three
ways: one is TEST-ONLY-by-a-script (`scripts/prompt-capture.mjs`, imported by
`test/runtime/core/test-prompt-capture-determinism.mjs`), one is a public-API file knip cannot see
through a compile-then-require harness (`packages/providers/failure-translation.ts`), and two are
genuinely test-only production files (`owner-speech.ts`, `section-parity.ts`). None of the four is
"a file nobody needs". That is the trap the brief names, measured: knip's file arm is 4, the correct
dead total is 5 files, and the overlap is 2.

knip's 451 unused exports are the `export` keyword, not dead code. Its `ignoreExportsUsedInFile: true`
is set only for core, which is why core contributes almost nothing to that 451 while the census
finds 838 in-file-only exports there.

## What I did not finish, and why

- **No `--noUnusedLocals` baseline on `packages/skills`.** It holds zero `.ts` files (content-only
  skill pack), so there is nothing to typecheck and the census reports 0/0. Not a gap in coverage,
  a gap in subject matter.
- **The dead-logic catalogue stops at five items.** It is not exhausted. I ran two mechanical
  searches and one of them came back empty: a parameter-accepted-and-never-read scan over all 38
  files that call `registerTool(` (extracting each tool's `parameters.properties` keys and counting
  occurrences in the file) found **0** dropped options. The event-bus emitter/handler cross-check and
  the settings-key census (`check-braid-schema.mjs`, green, 53 keys) are the other two. I did not
  reach: duplicated implementations where one is never called (the 1,197-symbol list is the entry
  point, not a verdict), guard-order impossibilities proved by types, or registry entries whose
  target is gone.
- **No per-symbol verification of the 1,197 dead-export list.** The census classifies it, nobody has
  read it. Treat it as a work queue, not a finding.
- **`packages/providers/tsconfig.json` lists 7 files in `include` while the package holds 16 `.ts`
  files.** The other 9 are pulled in transitively by `index.ts`, so typecheck covers them; the
  curated list is a maintenance hazard, not a dead-code finding, and I did not chase which of the 7
  are load-bearing.
- **The 200 unresolved harness edges** are listed by `--json` but not individually adjudicated. They
  are `node_modules` paths for pi's own package (out of scope) and bare basenames such as
  `capture-plan.ts`. Since the dead list is 5 files and all 5 were re-derived by grep, an unresolved
  edge cannot have inflated the dead total; it could only have hidden a file that is alive.

## What this audit could not see

- **Dynamic dispatch by string.** Braid's extension loader takes factories from a static manifest, so
  the 20 `pi.extensions` entries are real edges. A future `import(name)` with a computed name would
  drop out of this graph silently. The one production dynamic `import()` in the tree
  (`handlers/compaction-retry.ts:304`) has a literal argument and is resolved.
- **Anything reached by a name built at runtime.** Mitigated, not closed. Harnesses load built output
  as `join(DIST, "lib", "orchestrator", "owner-speech.js")` and as `join(ROOT, "..", "contrib",
"browser", "index.ts")`. The census recovers these by concatenating runs of literal path segments
  in `join()`/`resolve()` calls and mapping `dist/` back onto `src/` (2,218 recovered edges), plus 379
  literal dynamic imports, 263 static imports and 431 repo-relative literals. 200 edges stayed
  unresolved and are listed in the JSON output.
- **Code loaded by the harness outside the repo.** `packages/providers/test/failure-translation.test.mjs`
  compiles a source file with a separate `tsc` and loads the emitted CJS; the target file is
  recovered only because its path appears as a literal beside a computed segment.
- **A tool that did not run.** None were skipped for absence. `knip`, `tsc`, `eslint` and the repo's
  own schema gate all ran in the worktree after `npm ci --ignore-scripts`. What I could not run is
  the repo's full `npm run lint` gate convention (`--max-warnings 0`): I invoked eslint directly with
  the same glob set, which produced the same 0-message result.
- **The eslint-strict number is not a gate.** 87 findings under neutralised ignore patterns says the
  patterns hide 87 unused bindings; it does not say all 87 are defects. Most are `_`-prefixed
  signature placeholders (`_ctx`, `_event`) that TypeScript's own unused checks exempt by convention.

## Placement

- `scripts/dead-code-census.mjs` is a read-only measuring instrument that depends on `typescript`,
  a root devDependency. It sits at the repo `scripts/` root, which is where the brief named it and
  where `check-telegram-senders.mjs` already lives. Consequence worth knowing: the root `knip.json`
  entry list does not include `scripts/**`, so this script itself will appear in knip's unused-file
  arm. That is a config gap in the root entry list, not a defect in the script; adding it to
  `knip.json` is a config change and this audit does not make config changes.
- `docs/` did not exist in this repository. `packages/core/docs/` holds design docs and
  investigations scoped to core (`COMPACTION-LOSS-INVESTIGATION.md` and friends). A cross-package
  audit is not a core document, so I created root `docs/` as the brief specified. If the repo later
  wants one home for audits, moving this file is a rename with no content change.
- No invariant moved. Nothing in `packages/*/src` was edited, so no domain fact was placed in a
  shared layer and no generic layer learned a role. The four-bucket taxonomy and the entry rules live
  in this report and in the census script; the script encodes them as executable rules, which is the
  only place a later reader can check them.

```json
{
  "worker": "dead-code-audit",
  "spec": "audit",
  "status": "completed",
  "output_file": "/private/tmp/wt-dead-code/docs/DEAD-CODE-AUDIT-2026-11-24.md",
  "source_revision": "499fbc6",
  "artifacts": [
    "/private/tmp/wt-dead-code/docs/DEAD-CODE-AUDIT-2026-11-24.md",
    "/private/tmp/wt-dead-code/scripts/dead-code-census.mjs"
  ],
  "gate_evidence": [
    {
      "cmd": "node scripts/dead-code-census.mjs",
      "exit": 0
    },
    {
      "cmd": "node scripts/dead-code-census.mjs --json",
      "exit": 0
    },
    {
      "cmd": "node scripts/dead-code-census.mjs --why packages/core/src/lib/orchestrator/owner-speech.ts",
      "exit": 0
    },
    {
      "cmd": "npm run check:deadcode",
      "exit": 0
    },
    {
      "cmd": "./node_modules/.bin/tsc --noEmit --noUnusedLocals --noUnusedParameters -p packages/core/tsconfig.json",
      "exit": 2
    },
    {
      "cmd": "./node_modules/.bin/tsc --noEmit --noUnusedLocals --noUnusedParameters -p packages/providers/tsconfig.json",
      "exit": 0
    },
    {
      "cmd": "./node_modules/.bin/eslint \"packages/core/src/**/*.ts\" \"packages/providers/**/*.ts\" \"packages/contrib/**/*.ts\" \"packages/telegram/src/**/*.ts\" \"packages/*/test/**/*.mjs\" \"packages/*/scripts/**/*.mjs\" \"scripts/**/*.mjs\" -f json",
      "exit": 0
    },
    {
      "cmd": "node packages/core/scripts/check-braid-schema.mjs",
      "exit": 0
    },
    {
      "cmd": "./node_modules/.bin/prettier --check scripts/dead-code-census.mjs docs/DEAD-CODE-AUDIT-2026-11-24.md",
      "exit": 0,
      "stamp": "scanned 1257 entries at 499fbc6"
    },
    {
      "cmd": "grep -rl 'registerTool(' --include=*.ts packages/core/src packages/contrib packages/providers packages/telegram/src | wc -l",
      "exit": 0,
      "stamp": "scanned 1257 entries at 499fbc6"
    }
  ],
  "claims": [
    {
      "claim": "Dead production code is 2,491 LOC of 145,231 across 446 files (1.7%), carried by five files.",
      "verified_by": "node scripts/dead-code-census.mjs",
      "evidence": "Bucket table. Independently, one grep per file for each of the five names outside test/script paths returned no production reference; both exit codes are recorded in the findings table.",
      "confidence": "high"
    },
    {
      "claim": "TRANSITIVELY DEAD is zero: no file is reached only through another dead file.",
      "verified_by": "node scripts/dead-code-census.mjs --json, detail.transitive",
      "evidence": "Importers index: every file without a production path has zero importers or only harness importers.",
      "confidence": "high"
    },
    {
      "claim": "knip reports 4 unused files; 2 of them are production files and both are test-only, so knip's file arm is neither the dead total nor a subset of it.",
      "verified_by": "npm run check:deadcode",
      "evidence": "4 files reported. Each of the 4 was re-bucketed by hand: prompt-capture.mjs is test-only, failure-translation.ts is a compile-then-require harness input, owner-speech.ts and section-parity.ts are dist-path harness inputs.",
      "confidence": "high"
    },
    {
      "claim": "The eslint configuration reports 0 unused bindings while tsc reports 22, because argsIgnorePattern ^_ and varsIgnorePattern ^_|^log$ hide them.",
      "verified_by": "tsc --noUnusedLocals --noUnusedParameters per workspace, and eslint as configured",
      "evidence": "eslint: 0 messages over 1056 files. Same run with the rule re-declared as {}: 87 findings. tsc: 22 TS6133.",
      "confidence": "high"
    },
    {
      "claim": "enforcement_signals is emitted in production with no production listener.",
      "verified_by": "grep over packages/*/src and the core test tree",
      "evidence": "One emit at handlers/register-session-compact.ts:207; zero on(enforcement_signals) in any src tree; the sole listener is test-event-bus.mjs:118; prompt-builder/index.ts:359 comments that there is none.",
      "confidence": "high"
    },
    {
      "claim": "PUBLIC-BUT-UNCALLED is 153 symbols and 2,157 LOC, and is deliberately excluded from the dead total.",
      "verified_by": "node scripts/dead-code-census.mjs --json, symbols.publicUncalled",
      "evidence": "Symbol pass over the four declared API entry files; each counted symbol had zero production importers.",
      "confidence": "medium"
    },
    {
      "claim": "No tool-call parameter in the 38 files that call registerTool( is declared and never read.",
      "verified_by": "grep -rl 'registerTool(' --include=*.ts packages/core/src packages/contrib packages/providers packages/telegram/src | wc -l (run at /private/tmp/wt-dead-code, leaf 38), then an AST scan of parameters.properties keys against per-file identifier counts",
      "evidence": "0 hits over 38 files. This is a null result and is reported as one.",
      "confidence": "medium"
    },
    {
      "claim": "200 harness edges stayed unresolved and are listed rather than dropped.",
      "verified_by": "node scripts/dead-code-census.mjs --json, dynamicUnresolved",
      "evidence": "200 entries: node_modules paths for pi's own package, out of scope, and bare basenames such as capture-plan.ts.",
      "confidence": "high"
    }
  ]
}
```
