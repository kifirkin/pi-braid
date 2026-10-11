<!-- status: current -->

# Session Recall Extension

Search and query past sessions. The agent can call this to find prior
work without leaving the current session.

## Architecture

This file (`index.ts`) is the extension entry point. Internal
helpers are co-located (no sub-modules) because the surface area is
small (one tool, one event handler).

## Tools exposed

| Tool      | Actions | Purpose                                                              |
| --------- | ------- | -------------------------------------------------------------------- |
| `session` | search  | Full-text search across session history                              |
| `session` | query   | Structured query (by date, by tool, by tag)                          |
| `session` | analyze | Multi-session LLM analysis over a session list                       |
| `session` | batch   | Pattern aggregation across sessions (by project/month)               |
| `session` | stats   | Session-file statistics (count, size, by project/month)              |
| `session` | context | Cross-session §8 context-adoption aggregate (loss/coverage/adoption) |

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

Sessions are stored as JSONL in `BRAID_DATA_DIR/sessions/`. Each
session is a single file. The index is built on first search (no
precomputed index - sessions are small enough that linear scan is
fast enough for the typical use case).

## Performance

The corpus measured for this change is ~3,250 session files / 2.3 GB. A
single-term search is one full-corpus pass plus the bounded refinements: ~4.5 s
on the dev machine against that corpus, down from ~10.6 s when the role signal
cost a second full pass. A multi-term query is one pass per term (~8.9 s for
two, down from ~19.3 s). `--max-filesize` caps any one file at 32 MB, so a
runaway session cannot dominate a scan; the five files above the cap (0.15% of
the corpus, all larger than 32 MB) are not searched. A precomputed inverted
index remains future work - this change removes the duplicate pass and bounds
the refinement, it does not make the scan itself cheap.

## Local Contracts

- **Read-only**: the extension never mutates session files.
- **Privacy-aware**: tool results and custom entries are not indexed
  (per the "not indexed" rule above), so sensitive content is not
  retrievable via search.
- **No whisper emission**: pure tool; no proactive nudges.
