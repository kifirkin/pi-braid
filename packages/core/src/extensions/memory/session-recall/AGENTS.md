<!-- status: current -->

# Session Recall Extension

Search, ask over, and query past sessions. The agent can call this to find
prior work - or to find what the owner said - without leaving the current
session.

## Architecture

`index.ts` is the extension entry point and the tool surface. Helpers are
co-located by role, not extracted further:

| File                   | Owns                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| `search.ts`            | live file discovery, the rg/grep/node backends, line hits, project labels |
| `rank.ts`              | the four-signal file ranking used by `search`                             |
| `query.ts`             | one session's transcript for the LLM paths                                |
| `corpus-index.ts`      | the user-turn index: extraction, incremental build, fail-closed load      |
| `ask.ts`               | BM25 retrieval over that index and the cited answer's rendering           |
| `analyze.ts`           | multi-session LLM analysis                                                |
| `context-aggregate.ts` | the `context` action's aggregation                                        |
| `stats.ts`             | session-file statistics                                                   |

## Tools exposed

| Tool      | Actions | Purpose                                                              |
| --------- | ------- | -------------------------------------------------------------------- |
| `session` | search  | Full-text search across session history                              |
| `session` | ask     | BM25 over the user-turn index, answered with citations               |
| `session` | query   | Structured query (by date, by tool, by tag)                          |
| `session` | analyze | Multi-session LLM analysis over a session list                       |
| `session` | batch   | Pattern aggregation across sessions (by project/month)               |
| `session` | stats   | Session-file statistics (count, size, by project/month)              |
| `session` | context | Cross-session §8 context-adoption aggregate (loss/coverage/adoption) |

`search`, `batch` and `ask` never return the calling session's own transcript
(`search.ts: excludeSessionPath`), and none of them reports a bare match count
as its result: `search` and `batch` render the matched lines with their line
numbers, ranked and capped; `ask` renders cited turns.

## `context` action

Repeatable cross-session aggregation of the §8 context-management counters -
compaction events (loss), archives written (coverage), navigation adoption
(tag/checkout/log), and an adoption_rate. Scans session files over a window
(`since`/`until`, default recent 7 days, `project` filter, `limit` = file cap)
and returns a concise ≤ 40-line summary block. Read-only, never mutates
session files, and caps the scan (default 200 files, skip > 5 MB).

Signals are matched to the durable session-file markers:

| Counter                     | Session-file marker                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| compaction events           | `type:"compaction"` entries                                                                            |
| verify/rollback loss        | empty/boilerplate compaction summaries                                                                 |
| archives written (coverage) | `context_compression` / `context_compress_slide` custom entries + on-disk `archives/*.jsonl` originals |
| navigation adoption         | `type:"label"` (tag), `type:"branch_summary"` (checkout), `context_navigate(action=log)` tool calls    |

pure aggregation lives in `context-aggregate.ts` (testable against fixture
session files); `search.ts` shares the file-discovery helpers.

## The corpus index and `ask`

The transcript corpus holds gigabytes of agent reasoning and tool output, and
under 10 MB of the owner's own words. `ask` reads that fraction as a
population: a derived store of one row per user turn, written by
`scripts/build-corpus-index.mjs` and queried by `askCorpusIndex`.

- **Location**: `<braid root>/corpus-index/`, one shard per project
  (`corpusIndexDir()` in `lib/config/braid-paths.ts`; the shard's file-name
  stem is `shardSlug`, one rule for the writer and the reader). Derived data:
  deleting the directory costs a rebuild, nothing else.
- **Row**: `{session, session_id, project, ts, line, text}`, plus the shard's
  first line, a manifest carrying format version, project, build time, row
  count, text bytes and the `(path, mtime, size, turns)` of every source file.
- **Content**: `message` entries with role `user` and text. Tool results
  arrive as user-role messages with no text block and drop out with the text
  filter; assistant turns, `custom_message` injections and durable `custom`
  entries never enter a row, so no key, tool argument or environment value is
  retrievable from the index.
- **Compaction archives are not indexed**: an `archives/*.jsonl` envelope is a
  second copy of messages the session body carries (`writeOriginalsArchive`
  stores the pre-compaction originals), so indexing both would count the same
  words twice.
- **Build**: one pass over the session files on a full build; later runs re-parse
  only the files whose `(mtime, size)` moved. A shard that cannot be read is
  rebuilt, never merged - derived data has one authority.
- **Fail closed**: `loadCorpusIndex` returns `{ok: false, reason}` naming the
  shard and the defect when a manifest does not parse, the format is unknown,
  a row does not parse, or the row count disagrees with the manifest. `ask`
  then says it cannot answer and prints the build command; it never answers
  from half a store.
- **Scoring**: BM25 (`k1 = 1.2`, `b = 0.75`) over one document per turn, with a
  fixed English function-word list and a symmetric suffix fold, so `renders`
  reaches `rendered` and a hyphen separates words. No embeddings, no vector
  store: at this size the lexical model is cheap, testable and re-derivable by
  eye. What would earn one is a measured recall@3 below the bar on questions
  whose answering passage is in the index.
- **Freshness**: an answer states the population it read and how many session
  files moved since the build (`corpusIndexFreshness`), so a stale shard is
  visible rather than silent.

Rebuild after a day of sessions:

```bash
npm run build && node packages/core/scripts/build-corpus-index.mjs
```

Recall over a pre-registered question set is measured on the live corpus, not in
the suite: `test/manual/ask-corpus-recall.mjs --questions <file.json>` scores
whether the answering turn appears in the top 3 and prints the rank of every
expected turn, including the misses.

## What it indexes

- Session title (if set)
- User messages (text content only, not tool calls)
- Assistant messages (text content only)
- Extension-injected `custom_message` entries (role `custom`)
- Tags (set via `setLabel`)

**Not indexed**: tool results, durable `custom` entries, custom event data.
This keeps the index small and the search fast. Compaction and branch
summaries are also excluded: they condense entries that remain in the file
and carry no message role.

## Query semantics

A search query is split on whitespace into terms. A file is returned when it
matches **any** term, not the phrase as written, because `rg -F <query>`
required the words to be adjacent and in order and so returned nothing for the
natural multi-word query. Ranking, not filtering, supplies precision:

1. lines matching the whole query as one phrase come first,
2. then rarity-weighted term coverage (`sum 1/(1+df)` over the matched terms),
3. then hit count, then path.

A single-term query is unaffected: it takes the pre-existing one-pass path and
produces the same files, counts and order as before. Each term costs one pass
over the corpus, so the term count is capped at `MAX_QUERY_TERMS`. The phrase
and role signals are refined on bounded candidate sets rather than the corpus:
the phrase is counted only on the files matching every term (the only files
that can carry it), and the role signal only on the top `ROLE_REFINE_LIMIT`
candidates by the cheap ordering. A single-term query therefore issues one
full-corpus backend invocation and an N-term query N.

## Storage

Sessions are stored as JSONL under pi's session root (one encoded-cwd directory
per project). `search` and `batch` scan those files live with the rg/grep/node
backends; `ask` reads the precomputed corpus index described above. The
extension writes no session file - the index is the one artifact it writes, and
it is written only by the build script.

## Performance

The corpus measured when the search cost work landed was ~3,250 session files /
2.3 GB. A single-term search is one full-corpus pass plus the bounded
refinements: ~4.5 s on the dev machine against that corpus, down from ~10.6 s
when the role signal cost a second full pass. A multi-term query is one pass per
term (~8.9 s for two, down from ~19.3 s). `--max-filesize` caps any one file at
32 MB, so a runaway session cannot dominate a scan; the files above the cap are
not searched.

The corpus measured for the corpus index is 3,832 session files / 3.8 GB. A full
index build parses every file in 20.6 s and writes 20,477 turns (9.66 MB) across
341 project shards; an incremental build re-parsing today's changed sessions
reports 1.0 s of work. An `ask` pays 0.2 s to load the shards, 0.2 s for the
freshness walk, and ~0.5 s to tokenize and score the population.

## Local Contracts

- **Read-only**: the extension never mutates session files.
- **Privacy-aware**: tool results and custom entries are not indexed
  (per the "not indexed" rule above), so sensitive content is not
  retrievable via search.
- **No whisper emission**: pure tool; no proactive nudges.
