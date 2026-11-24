<!-- status: current -->

# Tool adoption: what the session corpus says was called

`packages/core/scripts/tool-usage-census.mjs` reads the recorded session corpus
and answers the question the tool catalog cannot: which tools were called, how
often they failed, and what each one wrote into the context. A tool is registered,
documented and reflected in the prompt whether or not anyone reaches for it, and a
guideline costs tokens on every turn. This is the reader that says which ones earn
that.

```bash
npm run report:tool-usage -- --inventory <names.txt> --json <census.json>
```

The census below was read from a corpus of 3,455 session files and 4.8 GB across
ten months. Every figure carries the snapshot it came from, because the corpus is
live: the session that produced this report is part of it.

## The corpus this reads

|                                      |                                |
| ------------------------------------ | -----------------------------: |
| session files read                   |                          3,455 |
| project directories                  |                            484 |
| bytes read                           |                         4.8 GB |
| sessions with at least one tool call |                          2,658 |
| sessions with no tool call           |                            797 |
| unparseable lines                    |                          2,192 |
| span                                 | February 2026 to November 2026 |

Three exclusions and one inclusion, each a measured quantity rather than a
convention:

- **`sessions/archive/` is skipped**: 1,306 files. One archived benchmark session
  in that tree records 34,964 `finalize` calls, which would be 7 per cent of every
  call count in this report and none of it task work. `--include-archive` counts
  it, so the choice can be reversed and measured.
- **`<project>/archives/` is read**: 584 files. These are copies of a project's own
  sessions, and a copy is exactly what call-id deduplication exists to collapse.
  Skipping them would have hidden how much of the corpus is repetition; reading
  them shows it is 9,166 occurrences against 499,443.
- **Id-less call parts are counted apart**: the corpus had none, so the totals below
  are complete on that axis.

The corpus is not braid's traffic. It holds every harness that wrote to this
machine's pi session directory over ten months: pi with braid, other agent CLIs
writing `Bash`, `Write` and `Glob`, MCP servers, and the contributed packages. That
is a feature for an adoption question (a tool is measured against real work) and a
trap for a share (half this corpus was never in a position to call `orchestrate`).

## The join, and the two rules that decide it

A call is a content part `{type: "toolCall", id, name, arguments}` inside an
assistant message. A result is a whole entry whose `message.role` is `toolResult`,
carrying `toolCallId`, `toolName`, `isError`, `durationMs`. The join key is
`toolCallId`.

`--pair-check <session>` reports that population for one file before any figure in
this census is trusted. On a known session it reads:

```
call parts: 96 (unique ids: 96, id-less: 0, duplicate ids: 0)
result entries: 96 (id-less: 0)
unpaired calls: 0
dangling results: 0
name disagreements: 0
isError results: 5
```

**Rule one: an id alone is not the call.** Several harnesses and routers wrote to
this corpus, and they do not agree on id shape. In a 250-file sample, 32,374 calls
carried a completion-scoped id (`chatcmpl-*`), 8,858 carried `call_<hex>`, 871
carried `call_functions.<tool>:<n>`, 333 carried a positional
`functions.<tool>:<n>`, and 200-odd carried no usable id at all. Positional and
empty ids recur in unrelated sessions, so keying on the id alone merges two
different calls into one and loses the second. The census collapses two occurrences
only when they agree on id **and** name **and** the timestamp of the message that
carried them.

That rule has a cost, and the census prints instead of hiding it. The reader
reports both counts from one pass, `uniqueCallsByIdOnly` beside `uniqueCalls`:
481,150 calls under an id-only key and 490,351 under the key this report uses, a
difference of 9,201. That difference is what an id-only key silently merges, and
it is a property of the two rules rather than of the snapshot.

The figures in the rest of this report come from a read nine minutes earlier,
which counted 490,277 unique calls. The report uses that upper bound because a
merged call is a silent loss inside every per-tool row, while a double count is
visible in the duplicate total. Of the 499,443 raw occurrences in that read: 9,166
collapsed into 8,941 keys, 2,139 ids were reused for calls that differ and were
kept apart, 489,707 calls found a result, 570 did not, 524 results found no call,
and 32 results disagreed with the name on their call.

**Rule two: an error rate is over paired calls.** A call with no result has no
recorded outcome, so it is not a failure and not a success. 570 orphans and 524
dangling results are the size of that blind spot.

## Adoption of the documented inventory

`packages/core/TOOLS.md` is the package's tool catalog: 34 rows, 25 registered by
braid and 9 pi builtins. Extracted between its markers, that table yields exactly
34 names, and 33 of them were called at least once. The one that was not is
`powershell`, which the catalog itself marks as the Windows shell, and this
machine runs macOS. So the honest finding is not a gap in the catalog. It is that
every tool the package documents for this platform has been exercised by real
work.

| Tool                 |   Calls | Sessions | Error rate | Median result chars | Total payload |
| -------------------- | ------: | -------: | ---------: | ------------------: | ------------: |
| `bash`               | 249,094 |    2,459 |       5.6% |                 523 |        365.4M |
| `read`               |  74,077 |    2,483 |       1.7% |               2,551 |        360.3M |
| `edit`               |  40,372 |    2,088 |      12.5% |                 110 |          5.7M |
| `write`              |  14,735 |    1,975 |       0.6% |                  96 |          1.7M |
| `scratchpad`         |  13,068 |    1,925 |       0.5% |                 372 |         28.3M |
| `grep`               |  10,531 |      622 |       2.2% |                 537 |         30.5M |
| `timer`              |   5,372 |      241 |       2.2% |                 239 |          1.2M |
| `orchestrate`        |   4,629 |      164 |       2.8% |                 825 |          7.0M |
| `think`              |   3,972 |      673 |       4.8% |                 851 |          4.6M |
| `memory_store`       |   3,022 |      979 |       1.6% |                  43 |          0.2M |
| `finalize`           |   1,966 |    1,109 |       1.9% |               1,492 |          3.2M |
| `verify`             |   1,243 |      607 |       2.3% |                 117 |          0.9M |
| `memory`             |   1,063 |      638 |       0.2% |               3,454 |          5.5M |
| `find`               |   1,011 |      345 |       2.0% |                  35 |          0.7M |
| `ls`                 |   1,005 |      389 |       4.0% |                 116 |          0.3M |
| `list_skills`        |     925 |      641 |       7.2% |              12,880 |         10.8M |
| `session`            |     556 |      142 |       1.1% |               1,191 |          1.8M |
| `system_info`        |     299 |      242 |       0.0% |                 378 |          0.2M |
| `workspace_snapshot` |     165 |      151 |       0.0% |                 335 |          0.1M |
| `session_health`     |     161 |       68 |       0.0% |                 241 |          0.1M |
| `prompt_inspect`     |     136 |       66 |       0.7% |               2,305 |          0.8M |
| `verify_claim`       |     115 |       48 |       0.0% |                  56 |         0.01M |
| `health_maintenance` |     115 |       61 |       0.0% |                  45 |         0.01M |
| `tool_search`        |      81 |       56 |       0.0% |               1,901 |          0.2M |
| `hypothesize`        |      60 |       34 |       5.2% |               1,111 |          0.1M |
| `explore_paths`      |      35 |       27 |       0.0% |               1,087 |          0.1M |
| `set_tool_profile`   |      17 |        7 |       0.0% |                 246 |         0.01M |
| `skill_stats`        |      16 |       13 |       0.0% |               5,754 |          0.1M |
| `run`                |      15 |        5 |       0.0% |                 650 |         0.03M |
| `topic_drift`        |       6 |        6 |       0.0% |                  33 |        traces |
| `conflict_qa`        |       4 |        2 |       0.0% |                  38 |        traces |
| `behavior`           |       2 |        1 |       0.0% |                  76 |        traces |
| `error`              |       2 |        1 |       0.0% |                 124 |        traces |
| `powershell`         |       0 |        0 |        n/a |                 n/a |           n/a |

Two rows are worth a second look. `run` was added in commit `7faf50c` ("one program
and its argv, without a shell", 16 November 2026), which first ships in v0.45.0, and
the corpus shows the 15 calls all landing in November, in 5 sessions. A tool can be
present, documented and reflected in the prompt and still be reached for less than
twice a day. `error` is documented and was called twice, in one session.

## Concentration, and what the payload costs

Two tools carry two thirds of the work: `bash` and `read` are 323,171 of 490,277
calls (65.9%) and 725.7M of 904.1M characters of tool output (80.3%). Nothing in the
long tail comes close, and the tail's median payload is what makes it cheap.

The cost metric in this census is characters of text a result wrote into the
context, not tokens. `packages/core/docs/SESSION-COST.md` measures tokens; this
measures payload, which is the part a tool author controls.

Three rows that cost more than their call count suggests:

- **`list_skills`**: 925 calls, median 12,880 characters, 10.8M total. That is 12
  kilobytes per call for a catalog a caller already has in the prompt, and it is
  the largest per-call payload of any braid tool. If one tool in this census needs
  its output trimmed, it is this one.
- **`memory`** (the unified `action=` tool): 1,063 calls, median 3,454 characters,
  5.5M total, against `memory_store`'s 43 characters. The unified reader returns
  records; the writer returns a receipt. Both are doing what they say.
- **`finalize`**: 1,966 calls, median 1,492 characters, and 3.2M characters in
  total: receipts written in the session where the call means the work already
  ended.

Wall clock, from the results that recorded a duration: 418.8 hours inside tool
calls, of which `bash` is 401.9 hours. The corpus spent 17 days of its life inside
the shell.

What that shell was used for, by first token of the command: `cd` 166,883 (67.0% of
all bash calls), `grep` 13,316, `ls` 9,041, an environment prefix 6,809, `echo`
5,047, `cat` 4,086, `sed` 3,591. Two of those are worth naming. A `grep` tool exists
and got 10,531 calls while 13,316 bash calls began with `grep`. A `sleep` tool exists
and got 2,676 calls while 3,535 bash calls began with `sleep`. A persisted working
directory is doing more work than either.

## What fails, by signature

Signatures are error text with UUIDs, hex ids, paths, quoted spans and digit runs
removed, so one failure mode reads as one row. Grouping is lossy; the first
occurrence of each signature is kept verbatim in the JSON for the same reason.

**`edit`, 5,036 errors over 40,372 calls (12.5%)**: the highest error rate of any
tool with more than a thousand calls, and 66% of it is one failure mode wearing
four spellings.

| Count | Signature                                                          | Window     |
| ----: | ------------------------------------------------------------------ | ---------- |
| 1,951 | `could not find the exact text in <path>`                          | Feb to Nov |
| 1,187 | `could not find edits[<n>] in <path>`                              | Mar to Nov |
|   138 | `no changes made, the replacement produced identical content`      | Feb to Nov |
|   102 | `found <n> occurrences of edits[<n>], each oldText must be unique` | Mar to Nov |

The tool is not broken. The caller's anchor was wrong, 3,331 times, and each one
cost a round trip. This is the single largest source of wasted calls in the corpus,
and it is a prompt problem rather than an implementation problem.

**`bash`, 13,926 errors over 249,094 calls (5.6%)**: mostly the shell reporting
reality rather than breaking.

| Count | Signature                                                       | Window                 |
| ----: | --------------------------------------------------------------- | ---------------------- |
| 2,196 | `(no output) command exited with code <n>`                      | Feb to Nov             |
|   782 | `command timed out after <n> seconds`                           | Feb to Nov             |
|   372 | `command auto-denied: recursive force delete ...`               | Sep 2026 to Nov 2026   |
|   221 | `command aborted`                                               | Feb to Nov             |
|   198 | `cat: illegal option -- a`, an option macOS `cat` does not have | Feb to Oct             |
|   131 | `bash blocked: classified as dangerous (heuristic)`             | 27 May to 15 June 2026 |

**`read`, 1,285 errors (1.7%)**: 866 `ENOENT`, 214 reads past end of file, 98
`EISDIR`. Every one of those is a pre-flight check the caller could have made.

**`herdr_agent`, 576 errors (5.7%)** and `herdr_pane`, 407 errors over 4,462 calls
(9.1%): after `edit`, the contributed fleet pair carries the two highest failure
rates among tools with more than a thousand calls, and `herdr_agent`'s failure
vocabulary moved. `agent prompt produced no observed state change within <n> ms`
fires 119 times between late July and 6 October, then never again, while `timed out
waiting for agent status` starts in July and continues to November. A message that
stops mid-corpus is a change in the tool, not in the work.

**`list_skills`, 67 errors (7.2%)**: every one is `- action: must have required
properties action`. The schema demands a property whose only useful value is the
one the caller meant, and 67 calls were spent learning that.

Two populations are counted but not worth a table. `scratchpad` failed 14 times the
same way (`action` must equal a constant, an enum of one). And 956 calls carried a
tool name that is not an identifier at all, 942 of them an empty name: those are
malformed calls from a model emitting arguments where a name belongs, and they
failed by construction.

## Three sessions where use changed behavior

Each record below is reproducible with one command against the same corpus:
`--trace-tool <name>` for a call, `--trace <text>` for a result.

**1. First use.** `context_compress` was first called on 2 April 2026 at 12:14, in
this session file:

```
2026-04-02T05-50-48-024Z_2488716e-96ef-40d6-aee5-75858f4ea04e.jsonl
```

It went on to 1,263 calls across 291 sessions, last seen today. Its first call and
its latest are the same shape, which is what a tool that fits its work looks like:
no learning curve visible in the corpus, no error class that needed a fix before it
became routine.

**2. A failure surfaced, and it was not the tool's.** On 25 September 2026 at 07:42,
a `bash` call returned `Command auto-denied: recursive force delete anchored at an
absolute or home path`. That text does not come from braid and does not come from
the model: it is composed at `extensions/permission-gate/rules.ts:70` of
`@aliou/pi-guardrails`, a third-party extension installed on this machine, from a
rule whose description is `recursive force delete` (`src/shared/config/defaults.ts:94`).
The first refusal landed in:

```
2026-09-25T07-32-36-668Z_01a0d77a-fcbb-7617-97dc-aab97026258f.jsonl
```

By the end, 484 commands were refused across 336 sessions, 373 of them carrying
this rule's text. Two things follow. A corpus census that did not chase the string
would have reported these hundreds of `bash` failures as a tool defect. And the
guard was installed into the middle of nine months of traffic, so every refusal
after it is a call that the previous eight months would have executed: the corpus
dates the guard's install to the day, which no configuration file on disk does.

**3. A fix confirmed by silence.** The `edit` and `write` tools carried an
enforcement that refused any edit before the file had been read. It fired 151 times
in 16 sessions between 28 March and 21 April 2026, and the last refusal was:

```
2026-04-21T06:28:13.591Z  2026-04-19T13-16-01-368Z_019da5e2-3fd8-755d-b27c-484dc3b63e2e.jsonl
```

The string is absent from v0.52.0 source and from the installed package, and the
corpus holds 27,987 `edit` calls and 10,429 `write` calls dated after that last
refusal, with no occurrence of it among them. That is the whole confirmation
available: the code is gone, and seven months of traffic never asked for it again.
What the corpus cannot say is whether removing it was right, only that removing it
was complete.

## The long tail: names with no catalog row

302 distinct identifier-shaped tool names were called. 269 of them have no row in
`TOOLS.md`, and that number needs its parts before it means anything:

- **Contributed and third-party tools**, which the catalog covers in its appendix
  rather than its table: `browser_*` (15 names, 19,684 calls), `herdr_*` (4 names,
  17,238 calls), `fetch_content`, `web_search`, `codebase_tree`, `repl`,
  `healthcheck`, `mcp__*` servers.
- **Braid handler families** exposed by tools whose per-action form predates the
  unified ones: `context_*` (13 names, 3,460 calls), `memory_*` (17 names, 668 calls
  beside `memory_store`'s 3,022 and `memory`'s 1,063), `plan_*` (11 names, 476),
  `task_*` (6 names, 293), `goal_*` (9 names, 278), `telegram_*` (4 names, 2,621).
- **Foreign harness names**: `Bash`, `Write`, `glob`, `curl`, `sed`, `head`, `tail`,
  `mkdir`, `pkill`, `npm`. These are other agents writing into the same directory.
- **Names that are not tools**: `scratpad`, `scatchpad`, `planscratchpad`,
  `memorecall`, `finalise`, `edits`, `gash`, `tilth`. Each is one or two failed calls
  where a model guessed at a name. Their failures are real and cheap, and they are
  the only direct evidence in the corpus of the tool name being guessed rather than
  read.

The concentration is the finding, not the count. **127 of the 302 names were called
in at most two sessions, together 919 calls: 0.19% of the corpus.** Meanwhile 32
tools appear in 100 or more sessions. A registry that grows by name with this shape
ends up carrying names almost nobody calls, and each of them is a line in every
session's prompt.

## History: corpus span and the version trail

Version attribution is the weakest part of this report, and the reason is a fact
about the repository, not a limitation of the reader.

|                                           |                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| first corpus timestamp                    | 2026-02-03                                                               |
| last corpus timestamp                     | 2026-11-24                                                               |
| first commit reachable in this repository | 2026-10-12 (`9128aef`, pre-release history consolidated into one commit) |
| tags                                      | 95, from `v0.40.0` (2026-10-15) to `v0.52.0` (2026-11-24)                |

No session file records the harness version that wrote it (`{"type":"session",
"version":3}` is the schema version, not the package), and no state file on this
machine carries a dated version. So a call can be attributed to a release only two
ways: by the tag window it falls inside, or by locating the behavior in the tree and
finding the commit that introduced it.

Both were used. `run` is attributed by commit (`7faf50c`, first tag `v0.45.0`), and
that is the only per-release attribution this corpus supports with a date. The
other two behavioural claims are attributed by presence and absence in v0.52.0
rather than by release: the explore-before-edit enforcement is gone, and the
`@aliou/pi-guardrails` refusal is present. Eight of the corpus's ten months precede
any tag or any reachable commit, so "which version introduced this" has no answer
for most of what this report shows.

## Placement

**Layer changed.** One reader at `packages/core/scripts/tool-usage-census.mjs` and
this document at `packages/core/docs/`. The reader belongs in the package that owns
the corpus: its sibling `build-corpus-index.mjs` reads the same directory for the
`session` tool, and the rules it encodes (which tree, which entry shape, how to
join a result) are the same rules. The document lives in the package's gated docs
directory, where `check-doc-status`, `check-doc-dates`, `check-prose-punctuation` and
`check-private-paths` read it.

**Domain literals added to generic layers.** None. The reader compiles in no project
name, no home path and no machine detail beyond the corpus location it computes from
`os.homedir()`. The tool inventory is not scraped from the tree: it is read from a
file the caller names (`--inventory`), because the catalog has an owner
(`TOOLS.md`) and a second extractor would be a second answer. The one project word in
the code is the literal `archive` in the default skip list, which is a directory name
in the corpus contract rather than a fact about a project.

**What remains unverified.** Whether the 9,201 calls the id-only rule would have
merged are repetition or distinct work. The difference is exact and printed by the
same run, but which end is true is not knowable from the files, and no second census
of tool calls exists on this machine to hold it against. A second, larger question
is open by construction: nothing here measures availability, so no row above is an
adoption rate over the sessions where the tool could have been called.

## What these numbers cannot answer

- **Availability.** pi does not persist the system prompt, and the active tool set
  depends on module enablement, settings and the session's role. A tool used in 164
  sessions out of 2,658 may be a tool nobody reaches for or a tool most sessions
  never had. The corpus cannot tell them apart, so this report shares calls against
  all sessions with a call and never against an opportunity.
- **Wrongness.** A denied command is a guard working. `isError` is the harness's
  judgement that a call did not succeed, not that it should have been made.
- **Payload versus cost.** Characters are what a tool author controls; tokens are
  what the provider bills and what SESSION-COST.md measures. `list_skills` at 12
  kilobytes is large; how many tokens it cost depends on the tokenizer.
- **Cross-harness shares.** The denominator includes sessions from other agent
  CLIs. Per-tool rows are safe; a statement like "braid's tools are used in half of
  sessions" is not derivable here.
- **The archived tree.** One excluded session holds 34,964 `finalize` calls. That
  figure is larger than the 1,966 in this report by a factor of 18, and it is one
  file. Any "average finalize per session" figure is a choice about that file.

## Reproducing

```bash
# the catalog names, from the package's own table
node -e 'const md=require("fs").readFileSync("packages/core/TOOLS.md","utf8").split("\n");
const a=md.findIndex(l=>l.includes("TOOLS-CATALOG-BEGIN")), b=md.findIndex(l=>l.includes("TOOLS-CATALOG-END"));
console.log(md.slice(a,b).map(l=>(l.match(/^\|\s*`([a-z_0-9]+)`\s*\|/)||[])[1]).filter(Boolean).join("\n"))' > names.txt

# the census, with that catalog as the inventory side
node packages/core/scripts/tool-usage-census.mjs \
  --inventory names.txt --json census.json

# the join on one file, before trusting any total
node packages/core/scripts/tool-usage-census.mjs --pair-check <session.jsonl>

# the three behavioral records above
node packages/core/scripts/tool-usage-census.mjs --trace-tool context_compress
node packages/core/scripts/tool-usage-census.mjs --trace "auto-denied"
node packages/core/scripts/tool-usage-census.mjs --trace "read files) before editing"
```

A full read takes about 42 seconds and 4.8 GB of I/O. Every number in this document
moves by a few hundred when it is re-run, because the corpus grows while it is
being counted.
