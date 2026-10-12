# Compaction Message-Loss Investigation

<!-- status: historical -->
<!-- Restored from orphaned history. Retained as the audit record for the compaction fixes that
     followed: batch-settle scheduling, honest archive/slide/deep_clean feedback, loss counters.
     Body describes the pre-fix state at investigation time. -->

## Verdict (tl;dr)

**The risk is real, but so is the design intent.** The owner's caution is correct: not everything flagged
below is a bug. Git history and the pi-core event surface show at least two behaviors were deliberate:

- **Range-as-metadata was intentional** ("archive now actually frees space" was the deliberate
  change): the
  `context_compression` entry was always audit/report data; pi-core's independent budget cut is the
  real removal engine. The _actual_ defect is the **misleading tool feedback** (claims a specific range
  was removed when it was not), not the existence of the metadata entry.
- **Mid-turn deferred compaction was intentional**: the tool must return its result to the agent before
  `ctx.compact()` aborts the turn. The defect is the **race with a still-executing parallel batch**
  (`setTimeout(0)` vs in-flight sibling tools) - and the tool has the hooks
  (`tool_execution_start`/`tool_execution_end`/`agent_settled`) to schedule at a safe boundary instead.

Corrected classification (**B = broken, I = intentional, Mixed = broken but intent-aware fix**):

1. **Mid-turn abort discards in-flight batch results (Mixed).** Real loss window, but the fix must
   preserve the intended `return-result-then-compact` contract - schedule compaction at batch-settle
   via tool-execution events, not by refusing mid-turn calls.
2. **Declared range/summary never honored (Mixed).** The metadata entry is intentional; the
   **feedback is dishonest** (reports "Compressed N messages into summary X [range]" for a removal it
   does not perform). Fix = either honor the range through `session_before_compact` consumption or
   make the feedback describe reality.
3. **Manual + auto compaction lack mutual exclusion (B).** Separate abort controllers is pi-core's
   design split; the gap is braid lacks serialization between the two entry points - only the
   `session_before_compact` _handler_ is deduped, not the two compaction flows.

The tool description warns "never in a parallel batch (it aborts the turn)" - advisory only, no guard.

---

## Mechanism 1: Mid-turn abort discards in-flight messages (CONFIRMED, root cause)

### Chain

- `context_compress` schedules its compaction asynchronously: every action path ends with
  `setTimeout(() => ctx.compact(...), 0)` - `context-compress.ts:250, 490, 573, 753`.
- `setTimeout(0)` means: the tool's `execute()` **returns its result first**, then pi-core
  `compact()` runs on a later tick - while the agent turn is still in progress.
- `compact()` immediately does `_disconnectFromAgent(); await this.abort();` -
  `pi-coding-agent/dist/core/agent-session.js:1368-1369`.
  - `abort()` = `agent.abort()` + `waitForIdle()` (`agent-session.js:1165-1170`).
  - Agent events stop flowing through the session (`_disconnectFromAgent` unsubscribes;
    persistence happens in `_handleAgentEvent` on `message_end`, `agent-session.js:355-378`).
- **Consequence:** any agent output produced between the `context_compress` call and the
  compaction's `abort()` - an in-flight assistant message, or **tool results from the same
  parallel batch** - is terminated before its `message_end` is persisted. It exists neither in
  the session file nor in the rebuilt context.

### Evidence it is a known, real behavior

- `extensions/memory/AGENTS.md:21-22` - braid's own documentation:
  > "`ctx.compact()` aborts the current turn via `_disconnectFromAgent()` + `abort()`, which
  > discards any pending tool results from the same parallel batch."
- The tool description warns: "never in a parallel batch (it aborts the turn)"
  (`context-compress.ts:155`).
- **But nothing enforces it.** Grep of enforcement handlers found no guard that refuses
  `context_compress` mid-turn or in a parallel batch; `tool-tracker.ts` only _tracks_ the call.
  The dedup guard (`markCompactProcessed`, `compaction.ts`) prevents double-processing of
  `session_before_compact` - it does **not** prevent the turn abort.

### Why the owner saw it

The accidental turn-stop + "messages between compress tool calls" pattern this round: when an
agent calls `context_compress` and continues (or had queued parallel tools), the deferred
compaction aborts the turn, discarding whatever was in flight. The observed symptom is messages
that "should have been there" are gone after compaction.

---

## Mechanism 2: Declared range/summary is never honored (CONFIRMED)

### Chain

- The archive action computes `startIndex/endIndex` from `analyzeSession(ctx).branchLength`
  **at tool-call time** (`context-compress.ts:291`), then `sm.appendCustomEntry("context_compression", {...})`
  with the user's `topic`+`summary` (`context-compress.ts:436`), then schedules a plain
  `ctx.compact({})` (`:490-499`).
- The custom entry is **write-only**. Grep across `packages/core/src` finds `context_compression`
  in exactly one place - the two `appendCustomEntry` calls. **Nothing reads it.**
- Pi-core's `compact()` independently re-snapshots `getBranch()` at compaction time
  (`agent-session.js:1377`), recomputes the cut via `prepareCompaction` (token-budget from the
  **last real `type: "compaction"` entry boundary**, not the custom entry), and generates its own
  LLM summary. `previousSummary` is seeded only from `type === "compaction"` entries
  (`compaction.js → prepareCompaction`).

### Consequence

- The tool's feedback ("Compressed N messages into summary X [startIndex..endIndex]", with
  estimated freed tokens) describes **nothing that actually happens**. Actual removal is pi-core's
  independent `keepRecentTokens`-budget cut from the last real compaction boundary.
- The user-supplied archive summary is **dropped** - it never reaches the compaction summarizer,
  never appears in context.
- If the branch grew between tool-call time and the deferred compaction, the reported range is
  stale on arrival. This is the second, quieter way "messages get thrown away": the intended
  archive boundary is silently ignored in favor of a different (budget) boundary.

---

## Mechanism 3: Manual + auto compaction have no mutual exclusion (CONFIRMED overlap)

### Chain

- Two independent entry points both snapshot the branch and `appendCompaction`:
  - Manual: `compact()` - `agent-session.js:1367`
  - Auto: `_runAutoCompaction()` (threshold/overflow, fires from `_checkCompaction` at agent_end) - `agent-session.js:1591`
- Separate abort controllers: `_compactionAbortController` (manual) vs `_autoCompactionAbortController`
  (auto). Neither aborts the other (`agent-session.js:1488-1495`).
- Braid's `markCompactProcessed(sessionId, leafId)` dedup guard stops a _second_ `session_before_compact`
  on the same leaf (`compaction.ts`) - but it returns from the **handler**, not from pi-core's
  compaction. The skipped flow means the second compaction appends **without** braid's pre-filter /
  slide-mode / instruction safeguards, and both compactions can still append entries for the same region.

### Consequence

- If manual `setTimeout`-deferred compaction overlaps an auto-compaction (e.g., agent calls
  `context_compress` then ends its turn → `_checkCompaction` fires while the deferred manual
  compact is pending), two compactions run concurrently on the same branch, produce two summaries,
  and both overwrite `agent.state.messages` (last writer wins). Not a confirmed message _drop_, but
  a confirmed overlap hazard with duplicated LLM cost and potential summary confusion.

---

## What is NOT lost (verified, to bound the claim)

- **Session file entries are not deleted.** Compaction appends a `compaction` entry with
  `firstKeptEntryId`; `buildSessionContext` simply stops rendering older entries
  (`session-manager.js:193-228`). The "removed" messages still exist in the `.jsonl` file - they are
  removed from _context_, not from disk.
- The pre-append intercept (`compaction.ts` "queued message during compaction" fix) handles the
  specific case of a **user TUI message typed during compaction** - that path is guarded.

So the honest framing: compaction loses messages from **agent-visible context** (and can discard
in-flight turn output entirely via the abort), not from the session file. For an agent, loss from
context is loss.

---

## Fix recommendation (scoped, intent-aware, awaiting owner approval)

Design principle (owner): fully understand how it is now done and how it should properly be made -
preserve the intentional contract, fix only the genuinely broken parts.

1. **Schedule compaction at batch-settle, not `setTimeout(0)` (P0, Mixed→fix).** After the tool returns,
   instead of firing `ctx.compact()` on a raw macrotask that can land mid-parallel-batch, delay it until
   the in-flight tool batch settles. The tool has `tool_execution_start`/`tool_execution_end` events and
   `agent_settled` in reach - a one-shot "compact after current batch settles" avoids discarding sibling
   tool results while keeping the intended mid-turn auto-resume. (Alternative, simpler P0: detect "other
   tools in this batch still executing" and refuse with an advisory - but that breaks the legitimate
   mid-turn use the design intends, so batch-settle scheduling is preferred.)
2. **Make `archive` feedback honest (P1, Mixed→fix).** Either (a) resolve the declared range + user
   summary and feed them into the compaction via a `session_before_compact` consumption path so the
   declared boundary is actually honored, or (b) drop the per-range claims from the tool feedback and
   report only what pi-core will do ("will compact from last compaction boundary; estimate only").
   Option (a) restores the tool's stated contract; option (b) is the smaller honest fix.
3. **Serialize manual vs auto compaction (P1, B→fix).** In braid's `session_before_compact`, when a
   manual compaction is already scheduled/in-flight, defer or skip a concurrent auto-compaction so the
   two never overlap the same region.
4. **Loss telemetry (P2).** Record in-flight-aborted counts in the compaction outcome so silent loss
   becomes visible via heartbeat analytics.

Scope: `handlers/tools/context-compress.ts` + `handlers/compaction.ts` (+ a `session_before_compact`
consumption path if option 2a). Tests: batch-settle scheduling (sibling tool result preserved),
archive-range interop or honest-feedback, overlap serialization. Gates: tsc 0, `npm test` baseline +
new tests, docs, drift, deps. Not started - held pending owner approval of 2a vs 2b and the
batch-settle approach.

_Sources: `extensions/memory/context-manager/handlers/tools/context-compress.ts`,
`handlers/compaction.ts`, `extensions/memory/AGENTS.md:19-22`,
`@earendil-works/pi-coding-agent/dist/core/agent-session.js:1367-1481, 1591-1727`,
`.../session-manager.js:193-228, 802-880`, `.../compaction/compaction.js`._
