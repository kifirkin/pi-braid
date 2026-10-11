<!-- status: current -->

# Context Map: Contexts, Owners, Seams, and Where State Lives

How the tree divides into contexts, what each one owns, how they talk to each
other, and where state is allowed to live. Read it before deciding where a
change belongs or which side of a boundary a fact may cross.

A context here is a domain with its own vocabulary and its own invariants,
separated by a boundary that costs something to cross: a package boundary, a
CI-enforced import rule, or a sync-by-hand seam. The map is not a directory
listing - one context can span several directories, and a directory can host
more than one. Window and band numbers are the other half of the picture and
live in [CONTEXT-POLICY.md](CONTEXT-POLICY.md).

## Contexts and owners

| #   | Context                             | Owns                                                                                          | Code seat                                                                                                                                                   | Must never learn                                                                                                                                                                                                                                     |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Session runtime and turn pipeline   | turn lifecycle, whisper delivery and capping, session health state machine                    | `src/extensions/enforcement/`, `src/lib/events/`, `src/lib/utils/injection-tracker.ts`, `src/lib/state/` (`src/extensions/enforcement/session-health.ts:8`) | provider status codes and error categories as vocabulary: the gate it publishes carries only "may a turn start" and "a turn ended cleanly" (`src/lib/state/global-state.ts:514-516`)                                                                 |
| 2   | Context window management           | window budget, bands, offload, compaction ladder                                              | `src/lib/detection/context-thresholds.ts:17`, `src/extensions/memory/context-manager/`, `src/extensions/memory/context-lifecycle/`                          | which failure caused the pressure: the offload it publishes takes a short reason label and returns counts, not a classification (`src/lib/state/global-state.ts:538-558`)                                                                            |
| 3   | Agent memory                        | episodes, heuristics, tool reliability, semantic store, session recall, scratchpad, snapshots | `src/extensions/memory/three-memory-stores/index.ts:1`, `src/extensions/memory/session-recall/`, `src/extensions/memory/scratchpad/persistence.ts:41`       | branch identity: its stores are project-scoped and outlive any one session branch (`src/extensions/memory/scratchpad/persistence.ts:41-52`)                                                                                                          |
| 4   | Verification stores                 | evidence pool, claim tracker, belief store, conflict QA                                       | `src/lib/store/evidence-pool.ts:108`, `src/lib/store/claim-tracker.ts`, `src/lib/store/belief-store.ts`, `src/lib/store/conflict-qa.ts`                     | worker liveness and gate outcomes: gate evidence is the orchestrator registry's record (`src/lib/orchestrator/workers.ts:49`); these stores hold claims about the world (`src/lib/store/evidence-pool.ts:108`)                                       |
| 5   | Multi-agent orchestration           | worker registry, locks, branches, merge verification, result contract                         | `src/lib/orchestrator/workers.ts:11`, `src/extensions/orchestrator/`                                                                                        | provider and key-ring mechanics: gates are persisted as a command plus an exit code (`src/lib/orchestrator/workers.ts:49`) over git and a per-project registry file (`src/lib/orchestrator/workers.ts:11`)                                           |
| 6   | Provider routing and key rings      | keys, rings, routes, route walk, death and probe state                                        | `packages/providers/` (`packages/providers/ring-lifecycle.ts:88`)                                                                                           | braid session and health policy: the package's only peer dependencies are pi-ai and pi-coding-agent (`packages/providers/package.json:37-40`), and its one core-facing shape is the feedback handler interface (`src/lib/state/global-state.ts:329`) |
| 7   | Telegram channel                    | inbound poller, owner messages, decisions, voice, notify                                      | `packages/telegram/` (`packages/telegram/src/index.ts:29`)                                                                                                  | braid's context and prompt internals: it advertises what it knows through slots (`src/lib/state/telegram-poller-liveness.ts:41`) and conforms to pi-core session semantics (`packages/telegram/src/index.ts:29`)                                     |
| 8   | Prompt composition and guidance     | identity blocks, sections, tool guidelines, skills loading, surface discipline                | `src/extensions/core/prompt-builder/`, `src/extensions/core/skills-tool/`                                                                                   | unguarded live domain state: rendering goes through guarded accessors and probes, and a missing probe reads "unknown" (`src/extensions/core/prompt-builder/index.ts:493`)                                                                            |
| 9   | Cognition and probing               | think/verify tools, MARS, topic drift, sycophancy, turn outcome                               | `src/extensions/cognitive/` (`src/extensions/cognitive/metacognition/handlers/verify.ts:101`)                                                               | its own copy of history: it reads the branch it is given (`src/extensions/cognitive/metacognition/handlers/verify.ts:101`) instead of keeping a parallel timeline                                                                                    |
| 10  | Self-management and recovery        | watchdog, auto-recovery, health maintenance, error tracking                                   | `src/extensions/self/` (`src/extensions/self/watchdog/index.ts:175`)                                                                                        | timer internals: dead wake delivery crosses as ids and counts through the feed (`src/lib/state/global-state.ts:471-476`)                                                                                                                             |
| 11  | Scheduling                          | timers, wakes, wake retry                                                                     | `src/extensions/scheduling/timer/` (`src/extensions/scheduling/timer/index.ts:326`)                                                                         | provider status codes and error categories: the turn gate answers one yes/no question, and a missing gate never blocks (`src/extensions/scheduling/timer/index.ts:326-328`; `src/lib/state/global-state.ts:512`)                                     |
| 12  | Heartbeat and background work       | consolidation, analytics, drift detection                                                     | `src/extensions/heartbeat/` (`src/extensions/heartbeat/heartbeat-scheduler/index.ts:985`)                                                                   | context-manager internals: it calls the published offload runner as a mechanism and treats an absent runner as "cannot shrink" (`src/lib/state/global-state.ts:564-566`)                                                                             |
| 13  | Verification harness and governance | failure traces, weakness mining, gates, the AGENTS.md tree, placement/labels/doc checks       | `src/lib/harness/`, `src/lib/verification/`, `scripts/check-deps.mjs:53`                                                                                    | runtime state: the gates walk source paths (`scripts/check-deps.mjs:102-104`) and own no process state                                                                                                                                               |

## Relationship types

The code expresses five boundary relations, not one.

- **Separate ways, seam-mediated (packages).** `providers`, `telegram`, and
  `contrib` do not import core except through the published surface and the
  process-global seams. Core exports exactly two entries, `.` and `./lib`
  (`packages/core/package.json:8-11`); `src/lib/public.ts:2` names
  pi-braid-contrib as the primary consumer and stays backed by canonical
  modules, with no duplicate copy.
- **Shared kernel (inside core).** `lib/core`, `lib/types`, `lib/state`,
  `lib/events`, `lib/utils` are imported everywhere; extensions may import
  `lib/`, and `lib/` must not import `extensions/` (`src/AGENTS.md:21`).
  `scripts/check-deps.mjs:102-104` encodes the same rule as layers.
- **Allowlisted customer/supplier pairs.** 18 cross-extension pairs are
  sanctioned by name in `scripts/check-deps.mjs:53`. The allowlist names a
  caller pair, not the function used, so a new import inside a listed pair
  passes on membership alone (`check-deps.mjs:290`).
- **Conformist (to pi-core).** Braid mirrors pi's retry semantics on purpose
  (`packages/providers/ring-lifecycle.ts:88`) and depends on documented
  pi-core internals in the telegram package
  (`packages/telegram/src/index.ts:29`).
- **Governance over all.** The check scripts enforce rules across contexts
  from outside: dependency layers, placement wording, labels, doc status
  (`package.json` `ci:check`).

## Seam registry

A seam here is a process-global slot whose writer and reader sit in different
contexts. The slot carries a small mechanism-only shape, never a domain
vocabulary, and every consumer defines what absence means; none throws. Ten
slots meet this definition: five cross a package boundary, one crosses the
source and dist module instances of the same file, and four stay inside core
across extension boundaries. The event bus and the published `lib` surface are
boundary mechanisms too (`src/lib/events/event-bus.ts:1`, `src/lib/public.ts:2`), but
they have no slot-level absence contract and are covered under relationship
types instead.

| Seam                                                                            | Crosses                                            | What crosses                                                                                                                                                                                                                                                       | Absent policy                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KEY_RING_FEEDBACK_KEY` (`src/lib/state/global-state.ts:314`)                   | providers -> core                                  | a structural handler: `reportFailure(modelId, providerId, errText)` and `reportSuccess(modelId, providerId)` (`global-state.ts:323-324`); published at extension load (`packages/providers/ring-lifecycle.ts:2657`, called from `packages/providers/index.ts:429`) | no handler: every read is optional, a silent no-op (`src/lib/ai/llm-call.ts:771-772`); a direct call's 429/403 simply feeds no ring                                                                    |
| `WATCHDOG_TUNNEL_KEY` (`src/lib/state/global-state.ts:360`)                     | telegram -> core                                   | a hub: `status`, `failures`, `lastError`, `publish`, `subscribe` (`global-state.ts:376-381`); publisher `packages/telegram/src/lib/watchdog-tunnel.ts:26`, relayed from the poller at `packages/telegram/src/index.ts:471`                                         | status reads "unknown" until telegram publishes, and subscribers see no transition (`global-state.ts:386`, `src/extensions/self/watchdog/index.ts:200-204`)                                            |
| `WATCHDOG_TG_SIGNAL_KEY` (`src/lib/state/global-state.ts:439`)                  | telegram -> core                                   | a best-effort one-line plain-text sender, returning a boolean or a promise of one (`global-state.ts:442`); writer `packages/telegram/src/index.ts:703`                                                                                                             | absent: the optional escalation ping is a silent no-op (`global-state.ts:445`; consumer `src/extensions/self/watchdog/index.ts:209`)                                                                   |
| `WATCHDOG_WAKE_DELIVERY_FEED_KEY` (`global-state.ts:468`)                       | watchdog -> scheduling                             | three fact sinks taking ids and counts: `recordWakeOutcomeTimeout`, `recordWakeUndelivered`, `recordWakeDelivered` (`global-state.ts:471-476`); publisher `src/extensions/self/watchdog/index.ts:257-261`                                                          | absent slot: every forward is a no-op (`global-state.ts:467`; the timer uses optional calls, `src/extensions/scheduling/timer/index.ts:1096`)                                                          |
| `TURN_START_GATE_KEY` (`src/lib/state/global-state.ts:517`)                     | enforcement -> scheduling                          | `isBlocked(ctx, threshold)` and `noteCleanTurn(ctx)`; the shape deliberately carries no provider, status code, or error category (`global-state.ts:514-516`); publisher `src/extensions/enforcement/handlers/register-session-start.ts:77`                         | absent: never blocked, a wake must fail open (`global-state.ts:512`; consumers `src/extensions/scheduling/timer/index.ts:326-328` and `wake-retry.ts:135-140`)                                         |
| `CONTEXT_EMERGENCY_OFFLOAD_RUNNER_KEY` (`global-state.ts:535`)                  | context-manager -> lib/ai, heartbeat               | `runner(ctx, reason)` returning counts and an optional error, never a failure classification (`global-state.ts:538-558`); publisher `src/extensions/memory/context-manager/handlers/context-emergency.ts:452`                                                      | null: callers treat it as "cannot shrink" and take their normal failure path (`global-state.ts:564-566`; `src/lib/ai/llm-call.ts:752`)                                                                 |
| `TELEGRAM_POLLER_LIVENESS_KEY` (`src/lib/state/telegram-poller-liveness.ts:38`) | telegram -> prompt-builder                         | a live probe returning a boolean, not a start/stop flag; writer `packages/telegram/src/index.ts:535-536`                                                                                                                                                           | a missing or throwing probe reads "unknown"; consumers hedge and never assert reachability (`telegram-poller-liveness.ts:29-31`, `:59-61`; consumer `src/extensions/core/prompt-builder/index.ts:493`) |
| `PROVIDER_OUTAGE_NOTIFY_KEY` (`packages/providers/outage-watch.ts:90`)          | telegram -> providers                              | a one-line sender returning a boolean or a promise of one (`outage-watch.ts:93`); writer `packages/telegram/src/index.ts:721`                                                                                                                                      | absent is not an error: the transition still logs and its text reports the missing channel (`outage-watch.ts:87-89`; reader `outage-watch.ts:474`)                                                     |
| `EXTENSION_CTX_PROVIDER_KEY` (`src/lib/state/global-state.ts:588`)              | enforcement -> lib/ai                              | a getter for the current session context (`global-state.ts:596`); publisher `src/extensions/enforcement/handlers/register-session-start.ts:131`                                                                                                                    | absent: auxiliary calls fall back to the compat transport and the degradation is announced once per process (`src/lib/ai/llm-call.ts:149-163`, `llm-call.ts:752`)                                      |
| `CUSTOM_MODEL_KEYS_KEY` (`src/lib/state/global-state.ts:26`)                    | polyfill -> model-resolver, across source and dist | a Map of role key to one model pattern or an ordered list (`global-state.ts:28-33`); writer `src/extensions/core/polyfill/index.ts:397`; reader `src/lib/ai/model-resolver.ts:74`                                                                                  | key unset: the resolver falls through to its next priority (`global-state.ts:23`)                                                                                                                      |

Each seam has one home and one mirrored literal. The mirror sites carry the
same string plus a keep-in-sync comment on both sides, for example
`src/lib/state/global-state.ts:314` against
`packages/providers/ring-lifecycle.ts:2649`, and
`src/lib/state/global-state.ts:439` against
`packages/telegram/src/index.ts:222`. No package can import the other, so the
comment is the contract: a rename on one side silently turns the seam into its
absent case.

## Where state lives

The storage rule has three homes. Pick the home by the state's lifetime, not
by the tool that produced it.

1. **Branch-sensitive or session-scoped state goes into pi session entries.**
   Write it once with `pi.appendEntry` and reconstruct it from
   `sessionManager.getBranch()` at `session_start`. Example: context-lifecycle
   snapshots are appended under their custom type
   (`src/extensions/memory/context-lifecycle/index.ts:324`) and read back by
   walking the branch (`context-lifecycle/index.ts:971`). Counter-example: the
   worker registry is cross-session by nature, so it lives in a per-project
   file under braid home (`src/lib/orchestrator/workers.ts:11`) - a successor
   session must read it after the writing session is gone.
2. **Wall-clock or cross-session state goes into braid's own store, with the
   reason recorded.** Example: timer wake-retry records carry a `sessionId`
   because a fire outlives the turn that armed it
   (`src/extensions/scheduling/timer/wake-retry.ts:195`), and a foreign record
   is pruned only when two independent signals agree, since its owner may
   still be coming back (`src/extensions/scheduling/timer/recovery.ts:17`).
   Counter-example: task evidence is a view over the branch and is rebuilt on
   demand (`src/extensions/enforcement/task-evidence.ts:138`); storing it
   would go stale against the branch it describes.
3. **Tool state that follows the active branch goes into tool-result
   details.** Example: the checkout action of `context_navigate` returns
   details that bind the navigation to the branch it just created
   (`src/extensions/memory/context-manager/handlers/tools/context-navigate.ts:369-374`).
   Counter-example: the scratchpad persists under a project slug in braid home
   (`src/extensions/memory/scratchpad/persistence.ts:41-52`) because it must
   survive session end and serve the next session; a tool result would die
   with the branch.

The rule fails in two familiar ways: a side file that mirrors branch state
forks silently on checkout, and branch state parked in a store keyed by
wall-clock survives a rollback that should have removed it.

## The durable-fact event law

Events are carriers; aggregates are records. Three rules decide where a new
fact goes.

1. **Transient channels carry hooks and intents.** pi's lifecycle hooks
   (`session_start`, `turn_end`, `message_end`:
   `src/lib/core/event-names.ts:11-22`) and braid's in-process bus
   (`src/lib/events/event-bus.ts:96-106`) hand a notification to the handlers
   registered at that moment. Neither keeps it: the bus holds handler sets in
   Maps (`event-bus.ts:113`), and an emitted event is gone when `emit` returns
   (`event-bus.ts:145`). A handler may write state, but the event is never the
   record of it.
2. **A durable transition is a timestamped past-tense field on the aggregate
   that owns the state.** The writer stamps the time, the store that owns the
   aggregate persists the field, and a later reader asks the aggregate instead
   of replaying events.
3. **A whisper is a notification, not an event.** `sendEnforcementWhisper`
   delivers a message through `sendTrackedMessage`
   (`src/extensions/enforcement/whisper.ts:119`), whose durable trace is the
   `braid_injection` session entry the tracker appends
   (`src/lib/utils/injection-tracker.ts:281`): a log of what entered the
   context, not a state field. Only a critical whisper reaches the bus, as an
   `enforcement_violation` notification (`whisper.ts:83-85`), and that emission
   records nothing.

Durability is relative to the store that owns the aggregate: the worker
registry, the lock table, and the key-ring file outlive the session that wrote
them; session-health state outlives the turn. The demand is the same in each
case - a later reader gets the fact from the aggregate, without the event that
produced it.

| Field                    | Aggregate / registry              | path:line                                                                | Written by                                                                                     | Why durable                                                                                                                                                             |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawnedAt`              | worker entry, `workers.json`      | `src/lib/orchestrator/workers.ts:90` (decl), `:630` (write)              | `registerWorker`                                                                               | admission time is the left end of the spawn-to-result latency the fleet reports (`workers.ts:1166`)                                                                     |
| `resultAt`               | worker entry                      | `workers.ts:92` (decl), `:703` and `:736` (writes)                       | `recordWorkerMerge`, `closeWorker`                                                             | a successor session computes latency from the row after the writer is gone (`workers.ts:1166-1168`)                                                                     |
| `mergedAt`               | worker entry                      | `workers.ts:96` (decl), `:701` (write)                                   | `recordWorkerMerge`                                                                            | the merge mark is verdict evidence, and the row outlives the merged branch (`workers.ts:1029`)                                                                          |
| `closedAt`               | worker entry                      | `workers.ts:97` (decl), `:734` (write)                                   | `closeWorker`                                                                                  | terminal state: a closed row is no obstacle to admission (`workers.ts:539`) and is hidden from `list-workers` unless asked (`src/extensions/orchestrator/index.ts:883`) |
| `admissionRefusals[].at` | worker entry                      | `workers.ts:60` (decl), `:567` (write)                                   | `appendAdmissionRefusal`, from `registerWorker` (`:612`) and `recordAdmissionRefusal` (`:579`) | the refusal count is registry fact rather than inference, and a refusal changes no lifecycle field (`workers.ts:571-575`)                                               |
| `gates[].at`             | worker entry, gate row            | `workers.ts:52` (decl), `:739` (write)                                   | `closeWorker`                                                                                  | gate evidence is the registry's own record of the close (`workers.ts:737-740`)                                                                                          |
| `checkpoint.at`          | worker entry                      | `workers.ts:76` (decl), `:652` (write)                                   | `stampCheckpoint`, from `updateWorker` (`:672`)                                                | the registry stamps the resume point, so a writer cannot backdate it (`workers.ts:63-66`)                                                                               |
| `acquiredAt`             | lock row, `locks.json`            | `src/lib/orchestrator/locks.ts:22` (decl), `:92` (write)                 | `acquireLock`                                                                                  | the row is the claim another process checks; release deletes it (`locks.ts:106`)                                                                                        |
| `exhaustedAt`            | key entry, persisted ring state   | `packages/providers/key-ring.ts:134` (decl), `:400` (write)              | `exhaustActiveKey`                                                                             | decided in one process, read back by others: backoff expiry (`key-ring.ts:351`) and the merge guard (`:477`) compare it; serialized at `:860`, restored at `:798`       |
| `modeEnteredAt`          | session-health state, per-session | `src/extensions/enforcement/session-health.ts:47` (decl), `:156` (write) | `recordLlmError` (`:175-194`), `clearToHealthy` (`:232`), `setSessionHealthMode` (`:244`)      | the mode's age is recovery evidence the health tool reports (`src/extensions/self/health-maintenance/handlers/session-health-tool.ts:64-65`)                            |

The table covers the state aggregates this map already names; it is not a
census of every `*At` field in the tree, because append-only records (memory
entries, scratchpad rows, session records) carry their own creation stamps
rather than transition fields.

Two encodings are in use, and a new field takes the one its store already
uses: ISO strings on the worker registry (`workers.ts:630`), epoch
milliseconds on the lock table and the key-ring file (`locks.ts:92`,
`key-ring.ts:400`).

Not every timestamp is a transition. `lastSeenAt` (`workers.ts:91`) is a
freshness cursor any handle write refreshes (`workers.ts:673`), and `savedAt`
(`key-ring.ts:713`) is a persistence cursor; neither marks a transition, and
neither substitutes for one.

Adding state: name the aggregate and its store first. If a later reader must
be able to ask when, the transition lands as a past-tense field stamped by the
writer; if only handlers in this process need the fact, an event is enough and
nothing is persisted.

## Recorded divergences

- **Worker spec vocabulary.** The `orchestrate` tool description advertises
  five spec values (`src/extensions/orchestrator/index.ts:560`), while the
  registry validates no spec at all - its result-schema check covers status
  only (`src/lib/orchestrator/workers.ts:251`). The paired result validator in
  the orchestrator home accepts a fifth value. Recorded here, not repaired.
- **Bus vocabulary vs. emitters.** The event union advertises `timer_fire`
  (`src/lib/events/event-bus.ts:25`), but no production module emits it: the
  timer's emit was removed as dead code and the wake path is direct
  (`src/extensions/scheduling/timer/index.ts:371-373`, restated at
  `event-bus.ts:8-17`). The type survives as a test fixture
  (`test/runtime/lib/test-event-bus.mjs:24`). A reader of the law above should
  not infer a bus path for timer fires. Recorded here, not repaired.

## Limits

- The absence policies above are read from consumer code at this revision; if
  a consumer changes its absent handling, this table drifts, and review is the
  gate for that, not a script.
- The durable-fact inventory lists the state aggregates this map names; a
  store added later is checked against the law by review, not by a script.
- Only process-global slots are registered here. Ordinary imports between
  contexts are governed by `scripts/check-deps.mjs`, not listed per import.
- Domain-language drift (one word for several concepts) is out of scope; it
  belongs to the naming and placement checks.
