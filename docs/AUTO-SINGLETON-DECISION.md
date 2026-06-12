# auto_singleton - Decision Document

After deeper investigation, the proposed `auto_singleton` → `timer.set_auto` merge
turned out to be more complex than the initial inventory suggested. This doc
captures what I found and presents the options.

## What's actually different

| Property | `timer` | `auto_singleton` |
|----------|---------|------------------|
| Storage | Per-pi-instance, per-session | Module-level singleton |
| Poll interval | 1000ms | 5000ms |
| Firing | Fixed delay | Auto-renew on activity, fires when idle |
| Multiple concurrent | Yes (list shows N) | No (replaces) |
| Wake mechanism | eventBus + sendTrackedMessage | Direct sendTrackedMessage |
| Activity events | None (passive timer) | TOOL_CALL + TURN_END renew |
| Session-leak status | Clean (per-pi scoping) | Has known issue (per own docstring) |

The key distinction is **auto-renew on activity**. The plain `timer` fires at
a fixed time regardless of whether the agent is working. The `auto_singleton`
extends its deadline every time the agent is active, so it only fires if the
agent is genuinely idle.

This is the watchdog pattern: "if I'm not making progress, wake me up to
check what's stuck". A fixed-delay timer can't do this - it would fire while
the agent is in the middle of a long operation, which is a real failure mode
in pi-braid (sleep-during-tool-execution is documented).

## Why a clean merge is hard

To merge into `timer`, we'd need to:

1. **Add `auto_renew: boolean` field to `ScheduledTimer` type**
   - `lib/events/timer-types.ts` is shared by multiple files

2. **Add `renewTimer(sessionId, id)` API to `TimerManager`**
   - Update `fireExpired`/`checkExpired` to handle the case
   - Tests need updating

3. **Add `set_auto` action to the `timer` tool schema**
   - The current schema is simple (`set`/`list`/`cancel`)
   - Auto-renew adds a new field and behavior

4. **Wire `TOOL_CALL` and `TURN_END` events to call `renewTimer`**
   - Currently the timer extension has a clean `busy` guard
   - Auto-renew adds another event listener that needs to play nicely

5. **Remove the `auto-singleton` directory entirely**
   - 1 file, 1 AGENTS.md, 1 entry in manifest
   - 0 internal references (only the tool's own registration)

Net: 5-7 file changes, multiple API additions, risk of regressing the
carefully-session-scoped `TimerManager`.

## Three paths forward

### Option A: CUT auto_singleton entirely
- **Pros**: Simplest. No risk to existing timer invariants. Frees 1 tool slot.
- **Cons**: Loses the niche "idle watchdog" use case. If anyone uses it,
  they have no migration path.
- **Risk**: Low (no other code depends on it)
- **Effort**: ~30 min (1 file delete, 1 manifest entry removal, 1 AGENTS.md
  update in root)

### Option B: MERGE into `timer` (the original plan)
- **Pros**: Single timer subsystem, auto-renew is a first-class feature
- **Cons**: Complex refactor (5-7 files), risk of regressing timer invariants
- **Risk**: Medium-high (timer is critical infrastructure)
- **Effort**: ~3-4 hours (multiple files, tests, careful event wiring)

### Option C: DEFER the decision
- **Pros**: Don't lose functionality, don't risk regression
- **Cons**: 1-tool bloat remains. The user has to remember this is on the list.
- **Risk**: None
- **Effort**: ~10 min (just this doc, no code change)

## My recommendation

**Option A (CUT) is the best tradeoff** for these reasons:

1. **Usage is likely zero or near-zero.** The `auto_singleton` tool has 1
   file reference (its own definition). No internal callers. The user
   flagged it as a first-removal candidate, suggesting they don't use it.

2. **The watchdog use case is recoverable.** If someone really needs
   "wake me if idle 30s", they can build it as a thin script that uses
   `timer` (set 30s, on any activity cancel and re-set).

3. **The session-leak comment in `auto-singleton/index.ts` is a red flag.**
   The extension's own docstring says:
   > "Module-level singleton state. If pi ever runs multiple sessions in
   > one process, this state leaks between sessions. ... Full session-
   > scoping via getExtensionState() is blocked by the polling loop."

   This is a known architectural issue. Carrying forward a known-broken
   implementation is worse than removing it.

4. **Auto-renew is doable on top of `timer` if needed later.** The merge
   is harder than the original spec suggested, but the building blocks
   exist (events, polling, schedule). A future implementation can land
   cleanly with per-pi scoping from the start.

If the user disagrees, the next-best option is C (DEFER), not B (MERGE),
because the merge is more complex than originally scoped.

## Action items

- [ ] (Option A) Delete `src/extensions/scheduling/auto-singleton/`
- [ ] (Option A) Remove `autoSingletonFn` import and `auto-singleton` entry from `manifest.ts`
- [ ] (Option A) Update root `AGENTS.md` to mention only `timer` for scheduling
- [ ] (Option A) Verify tests pass

OR

- [ ] (Option C) Land this doc, add a "deferred" note to the inventory audit
