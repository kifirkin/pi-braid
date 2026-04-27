# PI Extension API Research Findings

## Summary

Braid's core context management is **well-implemented** using `session_before_compact` + `session_compact`. However, there are several gaps and incorrect patterns that need fixing.

---

## ✅ What's Correct

### Compaction Pipeline (compaction.ts)
```typescript
// Well-implemented:
pi.on("session_before_compact", async (event, ctx) => {
    event.customInstructions = buildCompactionInstructions(audit); // ← inject into summarization prompt
    // Or return SessionBeforeCompactResult to cancel/substitute compaction
});

pi.on("session_compact", async (event, ctx) => {
    // Track compacted entry IDs, add evidence
});

pi.on("compaction_end", async (event, ctx) => {
    // Handle all outcomes: success, overflow, context-window, max-retries
    // Includes emergency rotation via session rotation
});
```
This is the right pattern. Custom instructions injected into the event object are passed to `compact()`, not added as messages.

### Event Types Verified
From `dist/core/extensions/types.d.ts`:
| Event | Shape |
|-------|-------|
| `session_before_compact` | `(event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<SessionBeforeCompactResult>` |
| `session_compact` | `(event: SessionCompactEvent, ctx: ExtensionContext)` |
| `compaction_end` | `(event: CompactionEndEvent, ctx: ExtensionContext)` |
| `context_cleanup` | `(event: ContextCleanupEvent, ctx: ExtensionContext)` |
| `turn_end` | `(event: TurnEndEvent, ctx: ExtensionContext)` |
| `agent_end` | `(event: AgentEndEvent, ctx: ExtensionContext)` |
| `tool_execution_*` | Streaming per-tool events |
| `message_*` | Streaming per-message events |
| `context` | ❌ NOT pre-compaction — fires per message during streaming |

### SessionManager (ReadonlySessionManager) Used Correctly
- `ctx.sessionManager.getEntries()` — used in analysis.ts
- `ctx.sessionManager.getSessionFile()` — used in analytics
- `ctx.sessionManager.getLeafEntry()` — used in navigation
- Read-only usage is correct (no write methods called)

### Compaction Hard Truncation Pattern
```typescript
// When context >85% of model window → bypass LLM, build summary locally
if (usageTokens > threshold) {
    return {
        summary: buildHardTruncationSummary(prevSummary, fileOps),
        substitute: true, // ← tells pi to use local summary, skip compact()
    };
}
```
**This is correct** and prevents the death-spiral.

---

## ❌ Issues Found

### 1. `"context"` Event Is Wrong (HIGH)

**File:** `handlers/events.ts` — `registerContextPruningHandler`

**Problem:** `pi.on("context", handler)` fires per-message during **streaming** (MessageStartEvent / MessageUpdateEvent / MessageEndEvent). It is NOT a pre-compaction hook. The `return { messages: cleaned }` is **silently ignored** — pi's streaming event system does not route return values back to the session manager.

**What it does:** Runs pruning on every streaming message, not on the pre-compaction message list.

**Evidence from types.d.ts:**
- No `ContextEvent` or `ContextEventResult` in the types
- No `getExtensionState` export in the API
- `ReadonlySessionManager` has no `getState` method

**Fix:** Remove `"context"` handler. Move pruning/semantic compression into `session_before_compact` where:
- `event.preparation.messagesToSummarize` — messages about to be summarized
- `event.preparation.messagesToSplit` — messages at the split point
- `return SessionBeforeCompactResult` CAN modify the process

### 2. `(ctx as any).turnCount` Is Unstable (MEDIUM)

**Files:** `src/lib/reasoning-summary.ts`, `src/lib/compression-strategy.ts`

**Problem:** `turnCount` is NOT in `ExtensionContext`. Using `as any` works at runtime but:
- Can break between pi versions
- No guarantee the property exists
- `turnCount` concept may not match `turn_end` event count

**Fix:** Track turns properly:
```typescript
// Track via message_end (each assistant message = 1 turn increment)
let turnCount = 0;
pi.on("message_end", async (event: MessageEndEvent, _ctx) => {
    if (event.message?.role === "assistant") turnCount++;
});

// Or use turn_end directly
pi.on("turn_end", async () => { turnCount++; });
```

### 3. Semantic Compression in Wrong Place (MEDIUM)

**File:** `handlers/events.ts`

**Problem:** `semanticCompress()` is called in the `"context"` handler (per-streaming-message). It should run in `session_before_compact` before summarization, where it can:
1. Operate on the full `messagesToSummarize` array
2. Potentially reduce the summarization load
3. Actually affect the session content

**Fix:** Move to `session_before_compact`:
```typescript
pi.on("session_before_compact", async (event, ctx) => {
    const msgs = event.preparation?.messagesToSummarize;
    if (msgs) {
        const { compressed } = semanticCompress(msgs);
        // Can modify event or use substitute pattern
    }
});
```

### 4. Missing `ContextEventResult` Return

**If `"context"` was the right event**, handlers would need to return `ContextEventResult`. But since it's not, this is moot.

---

## API Properties Confirmed Not Available

```typescript
// These do NOT exist on ExtensionContext:
interface ExtensionContext {
    // ❌ NOT available:
    turnCount?: number;         // Use message_end counting instead
    getExtensionState?: ...;    // Braid uses module-level Maps (custom)
    abort?: () => void;         // Use signal.abort() instead
    
    // ✓ Available:
    sessionManager: ReadonlySessionManager;
    cwd: string;
    ui: ExtensionUIContext;
    signal: AbortSignal;
    getContextUsage(): ContextUsage;
}
```

---

## Session Corruption Incident (2026-04-27)

### Symptoms
- Error: `400 invalid_request_error: tool result's tool id(call_function_p4eurevxj24t_1) not found`
- Session file: 6.9MB, 3,976 entries, **187 compaction entries** (should be 1-2)
- Compaction entries with empty content (no summary text)
- Multiple compaction entries within seconds of each other

### Root Cause
The `registerContextPruningHandler` (`pi.on("context", handler)`) was running during every streaming message event (per-message, not per-session). It was:
1. Calling `applyPruningWorkflow()` + `semanticCompress()` on every streaming message
2. Calling `addEvidence()` (file write to evidence pool) during streaming
3. Returning `{messages: cleaned}` which pi's streaming event system **ignores**

Concurrent writes during streaming interfered with pi's own session file writes. This created:
- Duplicate compaction entry writes (187 compaction entries)
- Entries with empty content
- Potential tool call/result pairing breakage

### Fix Applied
- `registerContextPruningHandler` **disabled** in `context-manager/index.ts`
- All pruning/compression logic must migrate to `session_before_compact` handler
  where `SessionBeforeCompactResult` return value is respected by pi

### Lesson
The `"context"` event is NOT safe for session-level mutations. pi's streaming event system does not route return values. Any file writes or session modifications in streaming handlers risk session corruption.

---

## Recommended Changes

### Priority 1: Move Pruning to `session_before_compact` (CRITICAL)

```typescript
// compaction.ts — move all logic from events.ts "context" handler here:
pi.on("session_before_compact", async (event, ctx) => {
    const msgs = event.preparation?.messagesToSummarize ?? [];
    if (msgs.length === 0) return;

    // Step 1: BCR pruning
    const { pruningState } = getCmState(ctx);
    const pruned = applyPruningWorkflow(pruningState, msgs);

    // Step 2: Semantic compression
    const { compressed } = semanticCompress(pruned);

    // Step 3: Reasoning block detection
    if (shouldSummarizeReasoning(ctx)) {
        const blocks = findReasoningBlocks(compressed.map(...), 3);
        for (const block of blocks) {
            recordSummarization(ctx, block, estimateTokensSaved(block));
        }
    }

    // Step 4: If compression is substantial, substitute the compaction
    if (compressed.length < msgs.length * 0.6) {
        return {
            compaction: {
                summary: buildHardTruncationSummary(compressed),
                substitute: true,
            },
        };
    }

    // Otherwise: let pi's compact() run with custom instructions
    event.customInstructions = buildCompactionInstructions(audit);
});
```

### Priority 2: Remove `(ctx as any).turnCount` Usages

```typescript
// Track turns via message_end instead
let turnCount = 0;
pi.on("message_end", async (event: MessageEndEvent, _ctx) => {
    if (event.message?.role === "assistant") turnCount++;
});
```

### Priority 3: Update Events.ts

Remove `registerContextPruningHandler` entirely. Keep only:
- `registerAgentEndRetryHandler` (agent_end)
- `registerAutoRetryEndHandler` (auto_retry_end)

```typescript
// IN compaction.ts — session_before_compact handler:
// Add after customInstructions injection:
const msgs = event.preparation?.messagesToSummarize;
if (msgs?.length > 0) {
    // Step 1: Semantic pruning (BCR)
    const pruned = applyPruningWorkflow(pruningState, msgs);
    
    // Step 2: Semantic compression
    const { compressed } = semanticCompress(pruned);
    
    // Step 3: Reasoning block detection (tag for compression strategy)
    if (shouldSummarizeReasoning(ctx)) {
        const blocks = findReasoningBlocks(compressed.map(...), 3);
        // recordSummarization() for analytics
    }
    
    // Optionally substitute if compression is significant
    if (compressed.length < msgs.length * 0.7) {
        // Substantially reduced — could substitute compaction
    }
}
```

### Priority 2: Remove All `(ctx as any).turnCount` Usages

Track turns via events instead.

### Priority 3: Update Events.ts

Remove `registerContextPruningHandler` entirely — move all logic to `compaction.ts` in the `session_before_compact` handler.

---

## Extension Handler Return Values

| Event | Can Return? | Effect |
|-------|-------------|--------|
| `session_before_compact` | `SessionBeforeCompactResult` | Cancel compaction, substitute summary, modify instructions |
| `session_compact` | No | Informational only |
| `compaction_end` | No | Informational only |
| `context` | Ignored | Event is per-streaming-message, return values not routed |
| `message_*` | No | Streaming hooks |
| `turn_end` | No | Lifecycle hooks |
| `agent_end` | No | Lifecycle hooks |
