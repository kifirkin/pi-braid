<!-- status: current -->

# A babysit wake re-derives its fact at fire time

## The mechanism

The orchestrator's settle-time device arms one single-fire timer whose reason
names the live workers that no standing timer names. That coverage is computed
once, at the turn end, by `armMissingWorkerTimers` from `listTimers(sessionId)`.
The timer fires `settleDelayMs` later (four minutes by default), and the wake
text is that arm-time sentence. In the gap the seat re-arms its own checkpoint
timer naming the same worker, which is the normal working pattern, and the wake
then asserts a fact that is already false. The withdrawal path cannot help: it
runs on the next turn end, after the stranded fire has landed. The repair is a
fire-time predicate: the timer the device arms carries a callback that
re-derives the same coverage at delivery, and the store withholds the whisper
when it answers no. The delay, the tag and the reason text are unchanged.

## Reproduction, red before the fix

`packages/core/test/runtime/orchestrator/test-babysit-fire-predicate.mjs` drives
the complete stack in one process: the timer extension (its poller and fire
path), the wake gate, and the orchestrator, over a fake `pi` whose
`sendMessage` is the agent's inbox. Case 1 admits one worker, lets the turn end
arm the cadence with a 30ms settle delay, arms a `check <worker> progress` timer
naming the same worker, waits for the cadence to expire, and fires it through
the poll path. On the unpatched tree the whisper is delivered:

```
$ node --test packages/core/test/runtime/orchestrator/test-babysit-fire-predicate.mjs
▶ babysit fire-time predicate
  ✖ withholds the wake when a timer naming the worker was armed after the cadence (122.136726ms)
  ✔ still fires and carries its reason when nothing names the worker (97.991877ms)
  ✖ withholds a parked fire's late delivery when a naming timer appears meanwhile (110.877744ms)
  ✔ delivers a parked fire's late delivery when nothing names the worker (103.904849ms)
✖ babysit fire-time predicate
ℹ tests 4
ℹ pass 2
ℹ fail 2

✖ withholds the wake when a timer naming the worker was armed after the cadence
  AssertionError [ERR_ASSERTION]: no whisper: the fact the cadence would assert was re-derived and no longer holds
  1 !== 0
✖ withholds a parked fire's late delivery when a naming timer appears meanwhile
  AssertionError [ERR_ASSERTION]: the late delivery is withheld, not delivered
  1 !== 0
```

The two failing cases are the suppression cases. The two passing cases are the
positive controls, which must pass before and after the fix.

`packages/core/test/runtime/lib/test-timer-fire-predicate.mjs` pins the
store-side contract. On the unpatched tree the withholding and re-evaluation
cases fail, and the delivery cases pass:

```
$ node --test packages/core/test/runtime/lib/test-timer-fire-predicate.mjs
  ✖ withholds the whisper and still completes the fire when it says no
  ✔ delivers exactly as an unarmed timer when it says yes
  ✖ fires, and logs the throw, when the predicate throws
  ✔ behaves exactly as before when no predicate is armed
  ✖ consults the predicate again on a redelivery, not just once at the first fire
ℹ tests 5
ℹ pass 2
ℹ fail 3
```

## The patched tree

Same commands, forced rebuild first so the fixtures load the compiled
predicate:

```
$ npm run build
$ node --test packages/core/test/runtime/orchestrator/test-babysit-fire-predicate.mjs
▶ babysit fire-time predicate
  ✔ withholds the wake when a timer naming the worker was armed after the cadence (109.895451ms)
  ✔ still fires and carries its reason when nothing names the worker (112.867338ms)
  ✔ withholds a parked fire's late delivery when a naming timer appears meanwhile (110.059352ms)
  ✔ delivers a parked fire's late delivery when nothing names the worker (107.06119ms)
✔ babysit fire-time predicate
ℹ tests 4
ℹ pass 4
ℹ fail 0

$ node --test packages/core/test/runtime/lib/test-timer-fire-predicate.mjs
  ✔ withholds the whisper and still completes the fire when it says no
  ✔ delivers exactly as an unarmed timer when it says yes
  ✔ fires, and logs the throw, when the predicate throws
  ✔ behaves exactly as before when no predicate is armed
  ✔ consults the predicate again on a redelivery, not just once at the first fire
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

## Gates

On the patched tree:

| Command                                                                           | Result                            |
| --------------------------------------------------------------------------------- | --------------------------------- |
| `npm run typecheck`                                                               | exit 0                            |
| `node packages/core/test/runtime/orchestrator/test-babysit-cadence.mjs`           | 7 passed, 0 failed                |
| `node packages/core/test/runtime/orchestrator/test-settle-arms-babysit-timer.mjs` | 6 passed, 0 failed                |
| `npm test`                                                                        | 408 passed, 0 failed, 0 timed out |
| `npm run lint`                                                                    | exit 0                            |

## Controls

**Positive control: a cadence nobody covers still fires.** A worker with no
timer naming it reaches the same fire path and produces exactly one whisper,
`triggerTurn: true`, carrying the unchanged reason
(`live worker(s) this session owns with no timer naming them`), and the fire
leaves no timer behind. A suppression that silenced this case would be worse
than the duplicate it prevents, so the case is asserted in both the red and the
green run.

**Redelivery control: the parked fire obeys the same re-derivation.** A busy
session holds the fire's send, the one busy rung is spent while the session
stays busy, and the fire is parked rather than dropped. When a timer naming the
worker appears before the late delivery, the late delivery is withheld and the
parked entry is dropped (`outstandingCount()` returns to zero). The same walk
with no naming timer delivers the late delivery, with the hold stated honestly
in the text. The store-level fixture adds the other redelivery path: a
predicate that allows the first delivery and then declines the ladder rung
after a failed turn, proving the callback is consulted again rather than cached.

## The shape

**Store (`packages/core/src/extensions/scheduling/timer/`).**
`scheduleTimer` gains an optional eighth argument
`shouldFire?: (timer: ScheduledTimer) => boolean`. The timer manager stores it
on its own record (`StoredTimer`, the public shape plus the optional callback;
`ScheduledTimer` itself is untouched because the predicate is a live closure
that the persisted form cannot carry). The callback rides the expiry snapshot
because `checkExpired` spreads the live entry, which is how it reaches the
retry queue's snapshots.

The predicate is consulted at exactly three delivery points:

- `fireTimer`, after the store's own bookkeeping (the fired line, the removal
  or re-arm, the disk write) and before the whisper. A refusal returns with the
  fire complete: nothing is tracked, nothing is retried.
- `redeliverWakeFire`, after the retirement guard and before any text is built.
- `deliverParkedBusyFire`, after the retirement guard and before the late
  delivery.

A refusal writes one `fire withheld` line at the same level as the fire's own
line, in all three places. A throw is caught by one wrapper and treated as
`true`, with a warning that names the error: a predicate that cannot answer has
not shown the wake false. A timer armed without a predicate takes the same path
as before, and a timer recovered after a restart carries no closure, so it fires
as an unarmed timer does.

**Device (`packages/core/src/extensions/orchestrator/index.ts`).** The arm-time
coverage decision is factored into `liveWorkerIds` and `uncoveredOf`, and the
same `uncoveredOf` is called by the fire-time predicate
`babysitCadenceStillNeeded`. The predicate parses the worker ids back out of the
reason it is handed (`workersInBabysitReason`), reads the registries fresh, and
asks whether any named worker is still open and still has no standing timer
naming it, excluding the firing timer's own id. A reason that is not the
device's own shape fires: suppression may only withdraw a claim it can prove
false.

## Placement

**Layer changed.** The store (`extensions/scheduling/timer/timer-manager.ts`
and `timer/index.ts`) owns _when a timer fires_: it gained a general,
domain-free opt-in predicate and consults it at the three delivery points. The
device (`extensions/orchestrator/index.ts`) owns _whether the fact a wake would
assert is still true_: it supplies the callback and re-derives coverage from its
own registry and the store's public `listTimers`. Neither reads the other's
state directly; the only seam is the callback the caller hands the store at arm
time, and the store never learns what "babysit", a worker or a project key is.

**Domain literals added to generic layers.** None. The store's new code names
no worker, project, tag or reason shape; `orchestrator-babysit` stays in the
orchestrator, and the predicate's vocabulary stays in the orchestrator's
closure.

**What remains unverified.** The gate exercises the store and the device
in-process with a 30ms settle delay. It cannot show a real four-minute
wall-clock cadence, and it cannot show the wake's absence in a live session's
whisper stream; the seat observes those on the next orbit wave. One queue
detail is left as it was: a redelivery armed by the outcome-timeout path keeps
its outstanding entry until the next settle. The predicate re-decides at every
delivery attempt, so a repeat attempt is withheld again rather than delivered,
but the entry is not proactively dropped.

## Skills consulted

Read in full before the work: `software-engineer` (analyze, decompose,
execute, verify), `placement-discipline` (the layer decision and this section),
`dox` (the AGENTS.md walk and post-change update) and `tone-quality` (prose
rules for this report).
