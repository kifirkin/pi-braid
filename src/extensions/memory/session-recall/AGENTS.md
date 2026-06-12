# Session Recall Extension

Search and query past sessions. The agent can call this to find prior
work without leaving the current session.

## Architecture

This file (`index.ts`) is the extension entry point. Internal
helpers are co-located (no sub-modules) because the surface area is
small (one tool, one event handler).

## Tools exposed

| Tool      | Actions | Purpose                                                  |
| --------- | ------- | -------------------------------------------------------- |
| `session` | search  | Full-text search across session history                  |
| `session` | query   | Structured query (by date, by tool, by tag)               |

## What it indexes

- Session title (if set)
- User messages (text content only, not tool calls)
- Assistant messages (text content only)
- Tags (set via `setLabel`)

**Not indexed**: tool results, custom entries, custom event data.
This keeps the index small and the search fast.

## Storage

Sessions are stored as JSONL in `BRAID_DATA_DIR/sessions/`. Each
session is a single file. The index is built on first search (no
precomputed index - sessions are small enough that linear scan is
fast enough for the typical use case).

## Performance

For ~1000 sessions, full-text search takes ~50ms. If the user
notices slowdowns, precomputed inverted indices can be added (left
as future work).

## Local Contracts

- **Read-only**: the extension never mutates session files.
- **Privacy-aware**: tool results and custom entries are not indexed
  (per the "not indexed" rule above), so sensitive content is not
  retrievable via search.
- **No whisper emission**: pure tool; no proactive nudges.
