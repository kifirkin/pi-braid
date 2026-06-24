<!-- status: current -->

# src/extensions/memory/scratchpad/ - Working Memory

The agent's working memory: goals, plans, decisions, hypotheses, notes,
learnings, constraints. Persists to per-project file so state survives
compaction and even across sessions.

## Distinction from `memory/` data layer

- `lib/memory/` = the long-term engine (episodes, semantic memory, etc).
- `extensions/memory/` = the agent-facing tools (memory_store, memory, ...)
- `extensions/memory/scratchpad/` = the WORKING memory tool (in-session, structured)

The scratchpad is a state tool, not a knowledge tool. It's where the agent
writes "what I'm doing right now" not "what I've learned in general."

## Tool

| Tool | Actions | Purpose |
|---|---|---|
| `scratchpad` | set_goal, add_plan, mark_done, add_decision, add_hypothesis, add_note, add_learning, **remove_plan**, **remove_note**, **remove_decision**, **remove_hypothesis**, **clear_done**, **archive_done**, **continue** (D-41 resumption digest), ... | Structured session state management. |

## `continue` action (D-41)

The `continue` action returns a focused resumption digest:

```
# Resumption digest
Goal: <current goal>
Prior goal: <previous goal if different>

## Open plan (N)
  1. 🔄 <in-progress step>
  2. ⬜ <pending step>

## Recently completed
  ✅ <last done item>
  ...

## Recent decisions
  - <last decision> (<reason>)
  ...

## Recent notes
  <last note>
  ...

## Active constraints
  [<type>] <description>
  ...

## Session: turn=N, phase=X, mode=Y
```

Cheaper than `read`. `read` is the right call when the full picture is
needed (hypotheses, full done list, all learnings, filtered by id/turn).

## Files

| File | Purpose |
|---|---|
| `index.ts` | Extension entry point. |
| `persistence.ts` | Read/write the per-project scratchpad file. |
| `types.ts` | TypeScript types for scratchpad items. |

## ID-based addressing (D-39, 2026-06-17)

All list items now have stable IDs assigned at add time:
- Plan steps: `pl-XXXXXXXX` (`add_plan`, `mark_done`, `elevate_to_plan`)
- Decisions: `dc-XXXXXXXX` (`add_decision`)
- Notes: `nt-XXXXXXXX` (`add_note`)
- Hypotheses: `hp-XXXXXXXX` (`add_hypothesis`)
- Done items: `dn-XXXXXXXX` (`mark_done`)
- Constraints: `con-XXXXXXXX` (`add_constraint`)
- Learnings: `lrn-XXXXXXXX` (`add_learning`)

Every `add_*` action returns the new ID in its result text. Pass the ID to
the matching `remove_*` action to surgically delete one item.

## Long-session hygiene (D-39)

The scratchpad persists across sessions, so list items accumulate over time.
FIFO recycling (`note_compact`) keeps lists bounded, but for targeted cleanup
use the dedicated actions:

| Action | Purpose |
|---|---|
| `remove_plan` | Delete one plan step by id (or text). Use when a step becomes obsolete. |
| `remove_note` | Delete one note by id (or text). |
| `remove_decision` | Delete one decision by id (or text). |
| `remove_hypothesis` | Delete one hypothesis by id (or text). |
| `clear_done` | Wipe the entire done list. Use at phase boundaries. |
| `archive_done` | Move done items to `<slug>/archive.jsonl` (append-only) and clear the list. Best for long sessions: history is preserved on disk without bloating the active scratchpad. |

## Filtered read (D-39)

The `read` action accepts a `filter` object for targeted inspection of long
lists without re-printing the whole scratchpad:

```js
{
  filter: {
    ids: ["pl-1234567-abc"],        // show only these
    sinceTurn: 50,                  // items added on/after turn 50
    untilTurn: 100,                 // items added on/before turn 100
    limit: 5,                       // cap total items shown
  }
}
```

All four fields are optional. Useful for "show me recent plan items" or
"show me what I decided in the last 20 turns" without scrolling through
50+ history items.

## Persistence

- File: `~/.pi/agent/braid/scratchpads/<project-slug>/latest.json`
- Archive: `~/.pi/agent/braid/scratchpads/<project-slug>/archive.jsonl` (append-only)
- Slug: `--Users-proj-path--` (kebab-cased absolute path with leading/trailing `--`)

## Migration

Old-format scratchpads (where `done` was `string[]`, `notes` was `string[]`,
`plan` had no `id`) are automatically migrated on load by
`persistence.ts:migrateScratchpad`. Migration is idempotent and
lossless: text content is preserved, IDs are generated for items
that lack them. No manual migration needed.
