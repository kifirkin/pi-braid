<!-- status: current -->

# Context Management Tool Improvements

**Status**: current (implemented 2026-07-02)

## Implementation

All proposed feature changes are implemented in
`src/extensions/memory/context-manager/handlers/tools/context-compress.ts`:

| Feature | Params | Status |
|---------|--------|--------|
| Tag-based archive range | `startTag`, `endTag` | Done |
| Percentage-based range | `range: "80%"` | Done |
| Archive feedback (token savings) | Auto-reported | Done |
| Keep-recent-turns shortcut | `keepRecentTurns: 20` | Done |
| Deep-clean meta-action | `action: "deep_clean"` | Done |
| Auto-execute proposals | See context_proposals | Not implemented (separate tool) |

### Contributors

- 2026-07-02: All 5 implementable features added to context_compress.
  Auto-execute proposals (context_proposals auto-apply) deferred — that
  tool has different semantics and needs separate design.

## Observed Problems

1. **`context_compress archive` didn't visibly reduce context** — Archived 951/1258 messages but reported size barely changed (47.2% → 47.5%). Only `compact` later freed tokens (179K → 60K). Either the stats are stale after archive, or archive doesn't free tokens on its own.

2. **No tag-based range for archive** — Had to count session entries manually (`startIndex=0, endIndex=950`). Would be natural to say `startTag="before-bulk-archive"`.

3. **No proportional range** — `range="80%"` to archive oldest 80% instead of counting entries.

4. **Auto-proposals are low-visibility** — The `context_proposals` tool correctly suggested archiving when context hit 182K, but I missed/dismissed it. Proposals should be surfaced more prominently (e.g., in the `context_inspect quick` summary as actionable items).

5. **No feedback on archive results** — After archiving 951 messages, the tool said "Compressed 951 messages" but the `context_inspect` showed no reduction. I had no way to tell if it actually worked until the subsequent `compact` freed tokens.

6. **No "keep recent turns" shortcut** — The natural operation is "archive everything except the last N turns." This requires computing the index of turn - N, which is tedious.

## Proposed Feature Changes

### 1. Archive with tag ranges

```typescript
// New: use tag boundaries for archive range
context_compress({
  action: "archive",
  topic: "...",
  summary: "...",
  startTag: "before-bulk-archive",  // NEW: instead of startIndex
  // Optional endTag — defaults to end of session
})
```

Also accept `beforeTag` as a convenience alias (archive everything before this tag):

```typescript
context_compress({
  action: "archive",
  topic: "...",
  summary: "...",
  beforeTag: "before-bulk-archive",  // NEW: archive all entries before this tag
})
```

### 2. Percentage-based range

```typescript
context_compress({
  action: "archive",
  topic: "...",
  summary: "...",
  range: "80%",  // NEW: archive oldest 80% of session entries
})
```

### 3. Archive feedback

After archive, return the actual token savings:

```text
Compressed 951 messages into summary. Tokens freed: 94,523 (52.4% reduction).
```

### 4. Smart "keep recent turns" archive

```typescript
context_compress({
  action: "archive",
  topic: "...",
  summary: "...",
  keepRecentTurns: 20,  // NEW: keep last 20 turns, archive everything older
})
```

### 5. Auto-execute proposals

For low-risk operations (archive, prune), `context_proposals` should have an `autoApply: boolean` option that silently runs the suggested action without requiring manual approval:

```typescript
context_proposals({ action: "approve", id: "...", autoApply: true })
// Or during compact:
context_compress({ action: "auto" })  // follow all pending proposals
```

### 6. Compaction results in inspect

`context_inspect quick` should show whether the last archive/compact was effective:

```text
**Context:** 15.9% (60K/375K)
**Last compress:** 951 msgs archived, freed 94K tokens (previous: 179K)
```

## Workflow

The ideal context hygiene workflow for a long session:

```text
# Phase 1: Tag current position
context_navigate({ action: "tag", name: "before-cleanup" })

# Phase 2: Archive everything up to current tag
context_compress({
  action: "archive",
  beforeTag: "before-cleanup",
  topic: "...",
  summary: "..."
})

# Phase 3: Compact to remove obsolete entries from remaining context
context_compress({ action: "compact" })

# Phase 4: Verify
context_inspect({ detail: "quick" })
# → 15% used, ready to continue

# Phase 5: Navigate forward
context_navigate({ action: "checkout", target: "before-cleanup", message: "Continuing after cleanup" })
```

This could be a single meta-action:

```typescript
context_compress({ action: "deep_clean", beforeTag: "before-cleanup", topic: "...", summary: "..." })
// Does: archive → compact → verify → checkout
```