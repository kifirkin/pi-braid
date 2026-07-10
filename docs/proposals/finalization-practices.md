<!-- status: forward-looking -->

# Proposal: Better Finalization Practices

**Status:** forward-looking
**Date:** 2026-07-10
**Author:** Braid

## Problem

The `finalize` tool closes a task but doesn't clean up the handoff state
(scratchpad) or use the right model for its internal operations. This
causes three issues:

1. **Stale scratchpad items accumulate** — done items, old plan items, and
   stale decisions remain in the scratchpad after finalize. A new agent
   instance reads them and thinks work is unfinished.

2. **Wrong model tier for system operations** — Finalize, consolidation,
   MARS reflection, and SOP extraction use the same model tier as the
   agent's per-turn tool calls. But these operations are fundamentally
   different: they run once per task, produce persistent artifacts
   (episodes, SOPs, hints) that are retrieved across sessions, and benefit
   from quality over speed.

3. **No event-driven integration** — Finalize emits no event on the event
   bus. Other extensions (scratchpad, consolidation, MARS) must poll or
   use ad-hoc state access to react to task completion.

## Current flow

```
Agent calls finalize()
  └─ recordToMemory()          ← local operations, no LLM
       ├─ addEpisode()         ← three-memory-stores (sync)
       ├─ addPrinciple()       ← heuristic extraction (sync)
       └─ executeConsolidation() ← triggered async
            ├─ extractSOP()    ← uses postLoopClassify → classify → callLlm
            │                     (utility model or session model)
            └─ scoreEpisode()  ← local heuristic scoring
  └─ findNextWork()            ← reads scratchpad taskStore
  └─ No scratchpad cleanup     ← GAP: done items accumulate
  └─ No event bus emission     ← GAP: other extensions can't react
```

## Proposed flow

```
Agent calls finalize()
  └─ recordToMemory()
       ├─ addEpisode()
       ├─ addPrinciple()
       └─ executeConsolidation() ← uses MAX-POWER MODEL
            ├─ extractSOP()      ← uses max-power model
            └─ scoreEpisode()
  └─ emit("task_completed")     ← event bus
       ├─ scratchpad listener   ← auto archive_done + clear_done
       └─ MARS listener         ← trigger reflection
  └─ No scratchpad mutation     ← event-driven, not direct coupling
```

## Design decisions

### Decision 1: Event-driven scratchpad cleanup

**Option A (direct call):** Finalize imports `handleClearDone` from
scratchpad and calls it directly. Tight coupling, but simple.

**Option B (event bus):** Finalize emits a `TaskCompletedEvent` on the
event bus. The scratchpad extension registers a listener that auto-archives
done items. Loose coupling, but requires adding a new event type.

**Verdict: Option B.** The event bus already exists with 10 typed event
types. Adding a `TaskCompletedEvent` is consistent with the SI-1 design
(unified event bus). The scratchpad extension already has `handleArchiveDone`
and `handleClearDone` — it just needs a listener.

### Decision 2: Max-power model for automatic operations

**Current state:** Most automatic operations use `postLoopClassify` or
`classify` which resolve to the utility model or session model via the
text-classifier's three-tier fallback.

**Proposed:** Add a `maxPowerModel` to the `LlmCallOptions` that `callLlm`
can use when available. The text-classifier and postLoopClassify should
accept an optional `maxPower` flag that routes to the max-power model.

**Implementation:**
- `callLlm` already accepts a `model` parameter. The caller decides which
  model to pass. The change is at the call sites, not in `callLlm` itself.
- `executeConsolidation` in `consolidation-channel.ts` currently calls
  `extractSOP` which calls `postLoopClassify(ctx, ...)`. `postLoopClassify`
  resolves the model via `ctx.model` (session model). We need to pass the
  max-power model instead.
- `processConsolidationTick` has access to `ctx` and can resolve the
  max-power model via `ctx.modelRegistry`.

**Where to get the max-power model:**
- pi's settings have `maxPowerModel` (e.g. `"a0venice/zai-org-glm-5-2"`)
- Available via `ctx.modelRegistry` or from the settings
- The `maxPowerModel` setting is already in `~/.pi/agent/settings.json`

### Decision 3: SOP extraction quality

**Current state:** `extractStrategicSOP` in `finalize.ts` is a trivial
implementation:
```typescript
function extractStrategicSOP(_ctx: ExtensionContext, summary: string): string {
  return `Task: ${summary.slice(0, 200)}`;
}
```
This doesn't use LLM at all. It just prefixes the summary.

**Proposed:** The consolidation pipeline (which runs async via heartbeat)
already calls `extractSOP` from `sop-extractor.ts` which uses
`postLoopClassify` with `CRITICS.trajectoryPattern`. This is the correct
place for LLM-based SOP extraction — it runs asynchronously after finalize,
not synchronously during the tool call. The synchronous `recordToMemory`
in finalize should remain fast and cheap (just store the raw data).

**Key insight:** The current design is actually correct for the sync path
but wrong for the async path. The async consolidation pipeline should use
the max-power model, not the session model.

### Decision 4: MARS reflection trigger

**Current state:** MARS reflection is triggered by `turn-end-handler.ts`
when `finalizeCalled` is detected (via `actualTools.includes("finalize")`).
This is a string match on the tool sequence — fragile but works.

**Proposed:** After finalize emits `task_completed`, the MARS handler
listens for the event instead of parsing the tool sequence. This is more
robust and consistent with the event bus pattern.

## Implementation plan

### Phase 1: Event bus + scratchpad cleanup

1. Add `TaskCompletedEvent` to `AgentEvent` union in `event-bus.ts`
2. In `finalize.ts`, emit `TaskCompletedEvent` after `recordToMemory`
3. In scratchpad extension, register listener for `TaskCompletedEvent`
   that calls `handleArchiveDone` and `handleClearDone`

### Phase 2: Max-power model routing

1. Add `maxPower?: boolean` to `postLoopClassify` options
2. When `maxPower` is true, resolve the max-power model from
   `ctx.modelRegistry` or settings instead of `ctx.model`
3. Update `executeConsolidation` and `processConsolidationTick` to pass
   `maxPower: true`
4. Add `maxPower?: boolean` to `classify` options in text-classifier.ts
   that routes to the max-power model for Tier 2 (utility) and Tier 3
   (session) fallbacks

### Phase 3: MARS event-driven trigger

1. In MARS handler, register listener for `TaskCompletedEvent`
2. Remove the `actualTools.includes("finalize")` string match

## Success criteria

1. After finalize, scratchpad done items are auto-archived
2. Consolidation pipeline uses max-power model for SOP extraction
3. MARS reflection triggers on event, not on tool string match
4. All 84 tests pass
5. No performance regression on per-turn tool calls (session model unchanged)

## Open questions

1. **What if the max-power model is unavailable?** Fall back to session
   model. The max-power model is a preference, not a requirement.
2. **What about the `before_provider_request` hook?** The max-power model
   uses the same provider plumbing as the session model, so the Venice
   `venice_parameters` injection still works.
3. **Should the verification judge also use the max-power model?** It's an
   automatic system operation that runs once per task. Yes, it should.
   But that's a separate change from finalization practices.