# Proposal: Persist-Aware Eviction for Scratchpad Key Learnings

**Author:** Braid (pi-braid session)  
**Date:** 2026-04-28  
**Status:** Proposed  
**Priority:** Medium  
**Effort:** Low (~30 lines, 2 call sites)  
**Parent Issue:** Scratchpad cap overflow → silent data loss of unpersisted learnings

---

## Problem Statement

The scratchpad extension uses `capPush()` for FIFO eviction when collections exceed hard caps. For `key_learnings`, this is **unsafe** — the eviction is blind to the `persisted` flag, meaning unpersisted learnings can be silently lost when the cap is exceeded.

### Root Cause

```typescript
// src/extensions/core/scratchpad/index.ts

function capPush<T>(arr: T[], item: T, max: number): number {
  let pruned = 0;
  if (arr.length >= max) {
    pruned = 1;
    arr.splice(0, 1); // ← evicts INDEX 0 (oldest), blind to any field
  }
  arr.push(item);
  return pruned;
}
```

`capPush` is generic — it knows nothing about `KeyLearning.persisted`. It evicts the oldest entry by index, regardless of safety status.

### Affected Collections

| Collection          | Safety Signal        | Risk                                    |
| ------------------- | -------------------- | --------------------------------------- |
| `key_learnings`     | `persisted: boolean` | 🔴 HIGH — unpersisted data lost forever |
| `decisions`         | None                 | 🟡 MEDIUM — already in context          |
| `hypotheses`        | None                 | 🟢 LOW — intentionally ephemeral        |
| `notes`             | None                 | 🟢 LOW — intentionally ephemeral        |
| `constraints`       | `expires_at`         | 🟢 LOW — manual + TTL                   |
| `tasks`             | tasks.json file      | 🟡 MEDIUM — separate persistence        |
| `goal`/`prior_goal` | None (not arrays)    | 🟢 NONE                                 |

Only `key_learnings` has a meaningful safety signal that gets ignored during eviction.

---

## Eviction Call Sites

There are **two** places where `key_learnings` can be evicted:

### 1. `add_learning` action (runtime)

```typescript
// index.ts ~line 719
case "add_learning": {
  const learning: KeyLearning = { ... };
  capPush<KeyLearning>(pad.key_learnings, learning, RECYCLE.MAX_LEARNINGS);
  // ↑ Blind eviction — oldest entry (regardless of persisted) evicted
}
```

### 2. `scratchpadClean()` (on load, note_compact, session_before_compact)

```typescript
// index.ts ~line 196
if (pad.key_learnings.length > RECYCLE.MAX_LEARNINGS) {
  stats.pruned_learnings = pad.key_learnings.length - RECYCLE.MAX_LEARNINGS;
  pad.key_learnings = pad.key_learnings.slice(-RECYCLE.MAX_LEARNINGS);
  // ↑ Blind slice — evicts indices 0..N-MAX (oldest entries)
}
```

---

## Failure Scenarios

### Scenario A: Overflow during session

```
State: key_learnings has 50 items (all unpersisted)
Agent adds new learning → capPush evicts index 0
→ "root_cause: ExtensionContext WeakMap..." LOST
→ Never backed up to memory_store
→ Gone from context, gone from scratchpad
```

### Scenario B: Restart with large scratchpad

```
On load: scratchpadClean() trims to MAX_LEARNINGS=50
If 49 items (unpersisted): no eviction
If 50 items: indices 0..N evicted, oldest unpersisted lost
```

### Scenario C: Compaction

```
session_before_compact → scratchpadClean() → blind eviction
→ Any unpersisted learnings in oldest slots are LOST
→ persist_learnings action can't help — they're already gone
```

---

## Existing Safety Mechanism (Insufficient)

`persist_learnings` action generates `memory_store` call instructions for unpersisted learnings:

```typescript
case "persist_learnings": {
  const unpersisted = pad.key_learnings.filter((l) => !l.persisted);
  // Returns call instructions for the agent to persist
}
```

**Problem:** This is advisory only. The agent must:

1. Call `scratchpad(action="persist_learnings")`
2. Then call `memory_store` for each item
3. Then mark each as `persisted: true`

If the agent doesn't call `persist_learnings` before overflow, data is lost. No enforcement, no automatic protection.

---

## Proposed Fix

### Strategy: Persist-aware eviction

Before evicting from `key_learnings`, prefer evicting **unpersisted** items first. The invariant:

> `persisted: true` learnings are NEVER evicted unless all unpersisted items have been evicted.

### Implementation Plan

**Step 1: Add `persistAwareEvict()` helper**

Location: `src/extensions/core/scratchpad/index.ts` (near `capPush` helper, ~line 225)

```typescript
/**
 * Evict oldest item(s) from key_learnings array, preferring unpersisted items.
 * Returns the number of items evicted.
 * Invariant: persisted learnings are evicted only when no unpersisted options exist.
 */
function persistAwareEvict(arr: KeyLearning[], max: number): number {
  const evicted = 0;
  while (arr.length >= max) {
    // Find oldest UNPERSISTED item
    const oldestUnpersistedIdx = arr.findIndex((l) => !l.persisted);
    if (oldestUnpersistedIdx !== -1) {
      arr.splice(oldestUnpersistedIdx, 1);
      evicted++;
    } else {
      // All are persisted — fall back to oldest
      arr.splice(0, 1);
      evicted++;
    }
  }
  return evicted;
}
```

Note: `findIndex` on each eviction is O(n) but MAX_LEARNINGS=50, so at most 50 iterations. Negligible cost.

**Step 2: Fix `add_learning` action**

Location: `index.ts` ~line 719

Replace:

```typescript
capPush<KeyLearning>(pad.key_learnings, learning, RECYCLE.MAX_LEARNINGS);
```

With:

```typescript
const pruned = persistAwareEvict(pad.key_learnings, RECYCLE.MAX_LEARNINGS);
pad.key_learnings.push(learning);
// Note: capPush returns count, persistAwareEvict also returns count
// Existing return message can stay: `planPruned ? "old step trimmed" : "Plan step added"`
// For learnings, consider: pruned > 0 ? "Oldest unpersisted learning trimmed" : "Learning added"
```

**Step 3: Fix `scratchpadClean()` for key_learnings**

Location: `index.ts` ~line 196

Replace:

```typescript
if (pad.key_learnings.length > RECYCLE.MAX_LEARNINGS) {
  stats.pruned_learnings = pad.key_learnings.length - RECYCLE.MAX_LEARNINGS;
  pad.key_learnings = pad.key_learnings.slice(-RECYCLE.MAX_LEARNINGS);
}
```

With:

```typescript
if (pad.key_learnings.length > RECYCLE.MAX_LEARNINGS) {
  const target = RECYCLE.MAX_LEARNINGS;
  // Evict oldest unpersisted first, then oldest persisted
  const before = pad.key_learnings.length;
  persistAwareEvict(pad.key_learnings, target);
  stats.pruned_learnings = before - pad.key_learnings.length;
  // Note: slice(-MAX) is O(n), persistAwareEvict is O(n*m) but n≤50, m≤50
  // At this scale, difference is negligible
}
```

**Step 4: Consider adding `evicted` field to RecycleStats**

```typescript
type RecycleStats = {
  // ... existing fields ...
  evicted_unpersisted: number; // new
  evicted_persisted: number; // new
};
```

This lets the agent know what was evicted and whether it needs to recover from memory.

---

## Alternative Approaches Considered

| Approach                                  | Why rejected                                   |
| ----------------------------------------- | ---------------------------------------------- |
| Hard limit with error (block add at max)  | Blocks agent workflow; less graceful           |
| Two-tier cap (warn at 80%, block at 100%) | More complexity for marginal benefit           |
| Separate unpersisted buffer (ring buffer) | Major refactor; over-engineered                |
| Archive evicted to disk                   | Adds storage complexity, recovery path unclear |
| Accept as-is                              | Silent data loss continues                     |

Persist-aware eviction was chosen because:

- Minimal code change (~30 lines)
- Zero data loss for unpersisted learnings
- Preserves agent awareness of persist status
- Fallback to oldest (all persisted) is safe — they're backed up
- No workflow disruption

---

## Verification

After implementation, verify:

1. **Unit test:** Add item when array is at max — oldest UNPERSISTED evicted, not oldest overall
2. **Unit test:** When all are persisted, oldest is evicted (fallback works)
3. **Load test:** Scratchpad with 51 learnings (1 unpersisted, 50 persisted) — unpersisted evicted
4. **Load test:** scratchpadClean() on load — unpersisted evicted before persisted
5. **Integration:** Build passes, `npm test` passes

```javascript
// Suggested test cases (add to test-scratchpad.mjs or new file)
const { persistAwareEvict } = await import("./dist/extensions/core/scratchpad/index.js");

// Test 1: Evicts unpersisted first
const arr1 = [
  { id: "1", persisted: false },
  { id: "2", persisted: false },
  { id: "3", persisted: true },
];
persistAwareEvict(arr1, 2);
assert(arr1.length === 2);
assert(arr1[0].id === "2"); // oldest unpersisted (idx 1) evicted
assert(arr1[1].id === "3");

// Test 2: All persisted — fallback to oldest
const arr2 = [
  { id: "1", persisted: true },
  { id: "2", persisted: true },
];
persistAwareEvict(arr2, 1);
assert(arr2.length === 1);
assert(arr2[0].id === "2"); // oldest evicted

// Test 3: Mixed — evict all unpersisted first
const arr3 = [
  { id: "1", persisted: false },
  { id: "2", persisted: false },
  { id: "3", persisted: true },
  { id: "4", persisted: true },
];
persistAwareEvict(arr3, 2);
assert(arr3.length === 2);
// Evicts 1, 2 (both unpersisted), keeps 3, 4 (persisted)
assert(arr3[0].id === "3");
assert(arr3[1].id === "4");
```

---

## Files to Modify

| File                                      | Change                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `src/extensions/core/scratchpad/index.ts` | Add `persistAwareEvict()`, fix `add_learning`, fix `scratchpadClean()` |
| `test/runtime/test-scratchpad.mjs`        | Add verification tests (or create new test file)                       |

No other extensions affected. No API changes. No breaking changes.

---

## Rollout Plan

1. Implement `persistAwareEvict()` helper
2. Fix `add_learning` to use it
3. Fix `scratchpadClean()` to use it
4. Add tests
5. Build — verify 0 TS errors
6. Run tests — verify all pass
7. Commit with message: `[scratchpad] Persist-aware eviction for key_learnings — prevent silent data loss on cap overflow`
8. Done — zero data loss for unpersisted learnings

---

## End.
