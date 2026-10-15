/**
 * Wake-retry queue — timer wake reliability.
 *
 * Four related guarantees live here:
 *
 * 1. FAILED-WAKE RETRY: a wake fire (triggerTurn:true) whose turn
 *    FAILS with a provider/auth error (assistant stopReason "error") must not
 *    sit in history until an unrelated turn processes it, surfacing hours
 *    later. The queue tracks every delivered wake fire as "outstanding"; a
 *    failed run (onAgentEnd(true) + onAgentSettled()) re-arms it for
 *    redelivery with bounded exponential backoff (5s/15s/45s/2m/5m, capped —
 *    default 3 redeliveries, braid.timers.maxWakeAttempts). A wake whose turn
 *    never produced an outcome (pi-core pre-flight abort emits NO extension
 *    event) times out after WAKE_OUTCOME_TIMEOUT_MS and retries anyway. A
 *    wake fire is therefore never silently lost.
 *
 * 1b. BUSY-SEND DEFERRAL: a wake whose SEND was held back because the
 *    session was busy at send time (isAgentBusy() — compaction or run
 *    bookkeeping; a raw triggerTurn there would start a competing agent
 *    run) re-enters this queue via deferBusyWake() and redelivers on the
 *    same bounded ladder, with an honest "held while busy" cause so the
 *    redelivery text does not claim a failed turn. The outstanding entry is
 *    marked busy-deferred until a redelivery actually sends: a settle of an
 *    unrelated run that merely overlaps the deferral window must not
 *    resolve the wake as delivered. When the bounded ladder is spent and
 *    nothing FAILED, the fire is PARKED (parkedBusy) rather than dropped:
 *    drainParkedBusy() hands it to one late delivery at the next idle tick
 *    (the settle's own drain), with the hold duration in the text. The cap
 *    bounds the retries, not the delivery — a session busy longer than the
 *    ladder still receives the fire exactly once, and a busy-held fire
 *    never enters the exhausted set (the watchdog's "permanently
 *    undelivered" page stays reserved for genuinely unsalvageable cases).
 *
 * 2. RECOVERED-FIRE DEFERRAL: recoverPersistedTimers
 *    (scheduling/timer/recovery.ts) must not deliver expired persisted fires
 *    INLINE inside before_agent_start — a turn is already starting, so a
 *    triggerTurn there races the pre-flight (pi-core activeRun guard) and a
 *    steer dies with the run if the pre-flight aborts. Recovery parks fires
 *    via deferRecoveredFire(); the timer extension's agent_settled handler
 *    calls flushRecoveredFires(), which delivers AFTER the run has fully
 *    settled — where a wake:true fire safely starts its own turn — and feeds
 *    failed deliveries into the retry machinery above.
 *
 * 3. DRAIN LIVENESS: the retry queue is drained by the SAME ticks
 *    that fire expired timers (TimerPoller poll tick and the
 *    TOOL_EXECUTION_END / TURN_END fireExpired path) — retries never wait
 *    for a user turn.
 *
 * 4. HONEST ATTRIBUTION, CANCEL RETIREMENT, LONG-RUN GRACE: a redelivery
 *    carries a WakeRetryCause rendered verbatim in its text — "failed"
 *    (the turn's settle was a provider/auth error), "busy" (the send was
 *    deferred), or "timeout" (the outcome window elapsed with no settle and
 *    no run in flight). The outcome timeout must not claim a failed turn.
 *    LONG-RUN GRACE: drainDue does not arm (or count) an outcome timeout
 *    while an agent run is active for a wake whose send was not busy-
 *    deferred — the run is plausibly the wake's own turn and a merely-long
 *    run is not a lost send; the 240s window keeps its job for the send
 *    that never started a turn (pre-flight abort). The active-run predicate
 *    is wired by timer/index.ts from the captured session ctx; absent or
 *    throwing it degrades to the pre-grace arming (never suppress retries
 *    on a broken reader). CANCEL RETIREMENT: cancelTimer/cancelTimersByTag
 *    (and the session-shutdown clear) withdraw the fire with the timer —
 *    retireTimer/retireTimersWhere drop the outstanding wake, the armed
 *    ladder, parked recovered fires, and the timeout-count bookkeeping, and
 *    mark the id retired so an in-flight deferred send (fireTimer or a
 *    popped redelivery) is suppressed at send time. Retirement is a
 *    WITHDRAWAL, not a delivery: stats.succeeded stays untouched.
 *
 * Mitigations (wake-retry flood):
 *
 *   a. Outcome window: legitimate wake turns run 2-4min; a shorter window
 *      arms spurious "false timeout" retries mid-turn (the 5s backoff usually
 *      drains before the settle's success-clear can cancel).
 *
 *   b. Retryable-failure hold: pi-core auto-retries a RETRYABLE provider
 *      failure (transport/timeout/5xx — RETRYABLE_PROVIDER_ERROR_PATTERN
 *      classes) inside the SAME run, and those auto_retry_start/end events
 *      are NOT surfaceable to extensions (absent from ExtensionAPI's
 *      ExtensionEvent union), so the queue instead mirrors pi-core's
 *      retryable classes (isRetryableWakeError) and HOLDS the outcome
 *      timeout for a bounded window matching pi-core's retry budget
 *      (baseDelayMs * 2^maxRetries, read from settings.json `retry` —
 *      getWakeRetryHoldMs). While the hold is active, drainDue cannot arm a
 *      mid-cycle redelivery; the settle (which fires only after pi-core's
 *      retry loop is done) is the sole arming authority for retryable
 *      failures — final failure arms exactly one ladder, success clears
 *      everything. A hold expires harmlessly: the next drainDue tick
 *      after expiry re-checks the (still missing) outcome and arms.
 *
 *   c. Redelivery cap (WAKE_RETRY_MAX_ATTEMPTS), owner-tunable via
 *      braid.timers.maxWakeAttempts (braid-settings.ts) — a deep ladder on a
 *      flaky provider out-floods the session.
 *
 * Failure detection: agent_end carries the run's messages; the LAST assistant
 * message's stopReason === "error" marks the run failed (provider 401/413/5xx
 * path). "aborted" is deliberate user action — the content is already in
 * history, so it resolves as delivered, not retried.
 *
 * All pi event wiring lives in timer/index.ts; this module holds no event
 * listeners and no module-level mutable state beyond the exported singleton
 * (class instance — same pattern as timerManager).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ScheduledTimer } from "../../../lib/events/timer-types.js";
import { createLogger } from "../../../lib/core/logger.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { BRAID_INJECTED, BRAID_SOURCE } from "../../../lib/constants/injection-details.js";
import { describeFireTiming } from "./fire-timing.js";
import {
  MAX_WAKE_ATTEMPTS_DEFAULT,
  getMaxWakeAttempts,
  getTerminalBreakerConfig,
  getWakeRetryHoldMs,
} from "../../../lib/config/braid-settings.js";
import { getTurnStartGate } from "../../../lib/state/global-state.js";

const log = createLogger("timer-wake-retry");

/**
 * Consumer gate shared by the wake sends: is the terminal-error breaker open,
 * so this fire must ride non-waking? Asks the published turn-start gate one
 * latch question and nothing else. Flag read once per fire; a missing ctx, a
 * missing gate or a broken reader fails open (never silently drop a wake).
 * Mirrors the helper in index.ts — kept here so the recovered-fire flush can
 * use it without importing back from the module that imports this one.
 */
function terminalBreakerBlocksWake(ctx: unknown): boolean {
  try {
    if (!ctx) return false;
    const cfg = getTerminalBreakerConfig();
    if (!cfg.enabled) return false;
    const gate = getTurnStartGate();
    if (!gate) return false;
    return gate.isBlocked(ctx, cfg.threshold);
  } catch {
    return false;
  }
}

/** A wake fire awaiting its turn outcome (delivery -> agent_end/agent_settled). */
export interface OutstandingWake {
  timer: ScheduledTimer;
  /** 0 = original fire; N = the Nth redelivery. */
  attempt: number;
  sentAt: number;
  /** A retry is already armed for this delivery — by the outcome timeout
   *  (the window elapsed with no settle; the entry is KEPT, not deleted, so
   *  the eventual settle of this delivery still resolves it: a success
   *  clears the armed retry, a failure re-arms at the same tier) or by a
   *  busy deferral (deferBusyWake). Cleared when the retry is popped
   *  (re-tracked fresh) or when the chain exhausts. */
  timedOut?: boolean;
  /** The send was deferred: the session was busy at send time, so no turn
   *  has run for this wake. Settles must not resolve it as delivered —
   *  the pending redelivery chain owns its liveness. */
  busyDeferred?: boolean;
  /** When the FIRST busy deferral of this delivery chain happened — the
   *  holder for the "held while the session was busy for X" late-delivery
   *  text. Survives re-tracking (trackWake) within the same fire's delivery
   *  chain so the reported hold is the whole held window, not just the last
   *  rung; a newer fire of the same timer id starts its own origin (see
   *  trackWake). */
  heldSince?: number;
  /** The busy ladder is spent; the fire waits for one late delivery at the
   *  next idle drain (drainParkedBusy) instead of being dropped. */
  parkedBusy?: boolean;
  /** A parked fire already handed to the late-delivery path; guards the
   *  in-flight window between the drain tick and the deferred send so one
   *  parked fire is handed off exactly once. */
  parkedDelivering?: boolean;
}

/** Why a redelivery was armed: the wake's turn failed at its settle, its
 *  send was deferred because the session was busy at send time, or its
 *  outcome window elapsed with no settle and no run in flight. The cause is
 *  rendered verbatim in the redelivery text — a timeout-armed retry must
 *  never claim a failed turn (the turn may simply have never started). */
export type WakeRetryCause = "failed" | "busy" | "timeout";

/** A scheduled redelivery of a wake fire whose turn failed (or whose send
 *  was deferred — see WakeRetryCause). */
interface RetryEntry {
  timer: ScheduledTimer;
  attempt: number;
  nextAttemptAt: number;
  cause: WakeRetryCause;
}

/** An expired persisted timer parked by recoverPersistedTimers (fix 3). */
export interface RecoveredFire {
  id: string;
  sessionId?: string;
  reason: string;
  tag?: string;
  createdAt?: number;
  firesAt?: number;
  wake: boolean;
}

/** Outcome window: a wake with no agent_end/agent_settled within this window
 *  (e.g. pi-core pre-flight abort — no extension event on that path) is
 *  re-armed for retry. 240s comfortably exceeds a normal long turn (babysit
 *  wake turns run 2-4min); a shorter window arms a spurious retry mid-run.
 *  A genuinely hung run is rarer than a long one. */
export const WAKE_OUTCOME_TIMEOUT_MS = 240_000;

/** Backoff tiers between redelivery attempts (index = attempt - 1). */
export const WAKE_RETRY_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

/** Redelivery bound. Attempt > the effective cap (WAKE_RETRY_MAX_ATTEMPTS
 *  default, owner-tunable via braid.timers.maxWakeAttempts) exhausts the
 *  fire — a deep ladder on a flaky provider out-floods the session. */
export const WAKE_RETRY_MAX_ATTEMPTS = MAX_WAKE_ATTEMPTS_DEFAULT;

// retryable-failure classification (pi-core mirror)

/** Quota/billing-class failures pi-ai never retries: the same literals pi-ai
 *  builds NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN from
 *  (pi-ai/dist/utils/retry.js). Checked first: pi-ai refuses to retry these, so
 *  the run's outcome is final and the wake must never be held for an auto-retry
 *  that will not come. The bare phrase "usage limit" is deliberately absent: it
 *  also vetoes texts pi-ai DOES retry (a 429 whose body mentions a usage limit),
 *  which suppresses the hold that retry needs.
 *
 *  Pinned by test/runtime/lib/test-wake-retry-nonretryable-mirror.mjs, which
 *  reads the token array out of the installed pi-ai module and requires each
 *  one to be vetoed here. The retryable side below is NOT pinned: it is a
 *  hand-written subset of pi-ai's retryable classes, so a failure pi-ai retries
 *  but this mirror does not match settles with no hold. */
const WAKE_NON_RETRYABLE_ERROR_PATTERN = new RegExp(
  [
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "Monthly usage limit reached",
    "available balance",
    "insufficient_quota",
    "out of budget",
    "quota exceeded",
    "billing",
    "subscription_sharing_usage_limit_exceeded",
  ].join("|"),
  "i",
);

/** The retryable classes braid mirrors from pi-core's
 *  RETRYABLE_PROVIDER_ERROR_PATTERN (pi-ai/dist/utils/retry.js): transport
 *  failures, premature stream endings, timeouts, HTTP 5xx/429. A failed
 *  agent_end matching this means pi-core will auto-retry inside the SAME
 *  run — the run's outcome is not final yet (see the hold in
 *  onAgentEnd/drainDue). */
const WAKE_RETRYABLE_ERROR_PATTERN = new RegExp(
  [
    "overloaded",
    "rate.?limit",
    "too many requests",
    "\\b429\\b",
    "\\b5\\d\\d\\b",
    "service.?unavailable",
    "server.?error",
    "network.?error",
    "connection.?error",
    "connection.?refused",
    "other side closed",
    "fetch failed",
    "upstream.?connect",
    "socket hang up",
    "timed? out",
    "timeout",
    "terminated",
    "ended without",
    "stream ended before",
  ].join("|"),
  "i",
);

/** Whether an agent_end errorMessage belongs to a failure class pi-core
 *  auto-retries (hold the wake outcome); quota/auth-class errors never hold. */
export function isRetryableWakeError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  if (WAKE_NON_RETRYABLE_ERROR_PATTERN.test(errorMessage)) return false;
  return WAKE_RETRYABLE_ERROR_PATTERN.test(errorMessage);
}

/**
 * Liveness observer for the wake-delivery watchdog feed. Production wiring
 * lives in timer/index.ts: it forwards threshold-crossing facts to the
 * watchdog's wake-delivery condition (published via the global-state seam),
 * which owns the episode latch + out-of-band escalation. The queue itself
 * stays notification-agnostic — the observer changes nothing about delivery
 * (retry budgets, backoff, caps are untouched), and a throwing observer must
 * never break redelivery (call sites guard).
 */
export interface WakeRetryObserver {
  /** The outcome window elapsed with no settle for this timer — `timeouts`
   *  is the cumulative count for the timer id across its redelivery chain. */
  onOutcomeTimeout?(timer: ScheduledTimer, timeouts: number): void;
  /** A tracked wake resolved as delivered (its turn settled non-failed or
   *  its message landed) — the signal that wakes resumed. */
  onWakeDelivered?(timer: ScheduledTimer): void;
  /** A wake turn settled WITHOUT a failure outcome — a real clean turn, as
   *  opposed to an internal LLM call. The terminal-error breaker resets its
   *  counter here so only completed turns close it. */
  onCleanTurn?(): void;
}

export interface WakeRetryStats {
  /** Wake fires tracked (originals + redeliveries). */
  tracked: number;
  /** Wake fires resolved as delivered (successful or aborted run). */
  succeeded: number;
  /** Outstanding wakes that hit the outcome timeout. */
  timedOut: number;
  /** Fires dropped after exceeding WAKE_RETRY_MAX_ATTEMPTS. */
  exhausted: number;
  /** Busy-held fires parked for one late delivery (never dropped).
   *  Test-only today: no production reader consumes WakeRetryStats — the
   *  park logs its own line at park time — so this field is kept for the
   *  busy-hold tests and a future status surface to publish. */
  heldBusy: number;
}

/** A retry due for redelivery (returned by drainDue). */
export interface DueRetry {
  timer: ScheduledTimer;
  attempt: number;
  cause: WakeRetryCause;
}

/** A busy-held fire whose bounded ladder is spent and that is due for its
 *  one honest late delivery (returned by drainParkedBusy). */
export interface ParkedBusyDelivery {
  timer: ScheduledTimer;
  /** How long the send was held while the session was busy. */
  heldMs: number;
}

export class WakeRetryQueue {
  private outstanding = new Map<string, OutstandingWake>();
  private retries: RetryEntry[] = [];
  private exhaustedFires: ScheduledTimer[] = [];
  private deferredRecovered: RecoveredFire[] = [];
  private lastRunFailed: boolean | null = null;
  /** Timer ids whose injected messages were present in the just-ended run's
   *  messages (extracted from agent_end by the timer extension). A fire on
   *  this list was DELIVERED — a later run failure is the agent's own work
   *  failing, not the delivery, and must not re-arm it. */
  private landedTimerIds: Set<string> | null = null;
  private stats: WakeRetryStats = {
    tracked: 0,
    succeeded: 0,
    timedOut: 0,
    exhausted: 0,
    heldBusy: 0,
  };
  private now: () => number = () => Date.now();
  /** While set and not expired, the outcome timeout must not arm —
   *  pi-core may still be auto-retrying the run (outcome undecided). */
  private retryHoldUntil: number | null = null;
  /** Test hooks: pin the hold window / redelivery cap. null restores the
   *  settings-derived values (getWakeRetryHoldMs / braid.timers
   *  .maxWakeAttempts). */
  private retryHoldOverrideMs: number | null = null;
  private maxAttemptsOverride: number | null = null;
  /** Cumulative outcome-timeout count per timer id, across the fire's whole
   *  redelivery chain (original + redeliveries). Feeds the repeated-timeout
   *  stall signal: one 240s window is a normal long turn, a SECOND one for
   *  the same fire is a wedged loop. Cleared when the fire resolves delivered
   *  or exhausts. Factory/instance state — never a module-level let. */
  private timeoutCounts = new Map<string, number>();
  /** Optional liveness observer (timer/index.ts wires the watchdog feed). */
  private wakeObserver: WakeRetryObserver | null = null;
  /** Live read-only predicate: is an agent run (or its pre-flight /
   *  compaction tail) active right now? Wired by timer/index.ts from the
   *  captured session ctx. Absent or throwing = not active — the arming
   *  behavior degrades to the pre-grace form (a wake is never silently
   *  lost, so a broken reader must not suppress retries). */
  private activeRunCheck: (() => boolean) | null = null;
  /** Timer ids retired by a cancel (the fire and its ladder withdrawn by
   *  the owner). Guards the in-flight windows: a fire deferred inside the
   *  poller (checkExpired -> setTimeout(0)) and a redelivery popped from
   *  the ladder (drainDue -> setTimeout(0)) both re-check this mark at
   *  send time, so a cancel landing inside either window suppresses the
   *  send. Cleared by trackWake — a fresh fire of the same id (recovered
   *  after a restart, say) re-arms its own chain. */
  private retired = new Set<string>();

  /** Set (or clear with null) the wake-liveness observer. Invoked at the
   *  timeout-arming and delivered-resolve points only; never on the send
   *  path. */
  setWakeObserver(observer: WakeRetryObserver | null): void {
    this.wakeObserver = observer;
  }

  /** Test hook: pin the clock (backoff/timeout math). null restores Date.now(). */
  _setClockForTests(fn: (() => number) | null): void {
    this.now = fn ?? (() => Date.now());
  }

  /** Test hook: pin the retryable-failure hold window (ms). */
  _setRetryHoldForTests(ms: number | null): void {
    this.retryHoldOverrideMs = ms;
  }

  /** Test hook: pin the redelivery cap. */
  _setMaxAttemptsForTests(n: number | null): void {
    this.maxAttemptsOverride = n;
  }

  /** Wire (or clear with null) the live active-run predicate. Consulted by
   *  drainDue's outcome-timeout path: while a run is active for a wake whose
   *  send was NOT busy-deferred, the run is plausibly the wake's own turn —
   *  a merely-long run must not arm a redelivery (and via the observer, a
   *  page). See the long-run grace contract in the module header. */
  setActiveRunCheck(fn: (() => boolean) | null): void {
    this.activeRunCheck = fn;
  }

  private isFireTurnRunning(): boolean {
    const fn = this.activeRunCheck;
    if (!fn) return false;
    try {
      return fn() === true;
    } catch {
      return false;
    }
  }

  /** Effective redelivery cap: braid.timers.maxWakeAttempts (default 3). */
  getMaxAttempts(): number {
    return this.maxAttemptsOverride ?? getMaxWakeAttempts();
  }

  private holdWindowMs(): number {
    return this.retryHoldOverrideMs ?? getWakeRetryHoldMs();
  }

  /**
   * Track a wake fire BEFORE (or at) delivery so its turn outcome can be
   * resolved. `attempt` 0 = original fire; the redelivery path re-tracks with
   * the drained attempt number. Re-tracking the same timer id refreshes the
   * outcome window (the newest delivery is the one whose outcome matters).
   *
   * `continueHold` marks an attempt-0 re-track that continues the SAME fire's
   * delivery chain (the parked handoff in deliverParkedBusyFire) instead of
   * starting a newer fire's. Only a chain continuation keeps a busy-deferred
   * predecessor's hold origin; a numbered re-track (attempt >= 1) is one by
   * construction, since the ladder redelivers the fire that armed it.
   */
  trackWake(timer: ScheduledTimer, attempt = 0, options?: { continueHold?: boolean }): void {
    // A newer delivery of the same timer supersedes any pending redelivery of
    // an older instance (recurring overlap): letting it fire alongside the
    // newer delivery duplicates the reason content. Safe for the redelivery
    // path itself — it re-tracks only after its retry was popped from the
    // list by drainDue.
    this.cancelPendingRetries(timer.id);
    // A fresh fire of a previously-cancelled id re-arms its own chain.
    this.retired.delete(timer.id);
    // A re-track of a busy-deferred delivery keeps the original hold start —
    // the late-delivery text must state the WHOLE held window, not just the
    // last ladder rung. Only a chain continuation keeps it: a NEWER fire of
    // the same id (a recurring cadence) supersedes the parked predecessor and
    // starts its own hold origin, so its late-delivery text reports its own
    // hold and not the predecessor chain's.
    const prev = this.outstanding.get(timer.id);
    const continuesChain = attempt >= 1 || options?.continueHold === true;
    const heldSince = continuesChain && prev?.busyDeferred ? prev.heldSince : undefined;
    this.outstanding.set(timer.id, { timer, attempt, sentAt: this.now(), heldSince });
    this.stats.tracked++;
  }

  /**
   * Record the outcome of the run that just ended. Called from agent_end.
   * A retryable errorMessage (transport/timeout/5xx — pi-core
   * auto-retries inside the SAME run) starts a hold window that defers the
   * outcome-timeout arming in drainUntil the retry cycle resolves; the hold
   * is refreshed on every retryable failure so a long multi-attempt cycle
   * stays covered. Non-retryable failures (auth/quota) arm at settle
   * immediately, as before.
   */
  onAgentEnd(failed: boolean, errorMessage?: string, landedTimerIds?: ReadonlySet<string>): void {
    this.lastRunFailed = failed;
    // Accumulate across the run's agent_end events: pi-core emits one per
    // loop (main run + every continuation), each carrying only its own
    // messages — the settled landed set is their union. Consumed and cleared
    // at settle.
    if (landedTimerIds) {
      this.landedTimerIds ??= new Set();
      for (const id of landedTimerIds) this.landedTimerIds.add(id);
    }
    if (failed && isRetryableWakeError(errorMessage)) {
      this.retryHoldUntil = this.now() + this.holdWindowMs();
    }
  }

  /**
   * Resolve outstanding wakes at the settle boundary (agent_settled — fired
   * after retries/compaction/continuations are done, even for failed runs).
   * A failed run re-arms every outstanding wake; anything else (success or
   * user abort) counts as delivered. Idempotent: a second call with no
   * outstanding wakes is a no-op, so multiple settle listeners cannot
   * double-schedule.
   *
   * A SUCCESSFUL wake turn also clears the pending retry chain for its
   * timer id. Without this, the outcome-timeout path (drainDue) can arm a
   * retry for a fire whose turn is merely LONG (>60s), the turn then settles
   * successfully, the armed retry still fires, and the chain re-delivers a
   * fire whose failure no longer exists — burning the retry cap on
   * duplicates. Only genuinely-failed fires keep retrying to the cap.
   */
  onAgentSettled(): void {
    const failed = this.lastRunFailed === true;
    const landed = this.landedTimerIds;
    this.lastRunFailed = null;
    this.landedTimerIds = null;
    // The settle fires after pi-core's retry loop is done (it lives in
    // _runAgentPrompt's finally) — the outcome is final, any hold is void.
    this.retryHoldUntil = null;
    const now = this.now();
    for (const [id, w] of this.outstanding) {
      if (w.busyDeferred) {
        // No turn ran for this wake (send deferred: session busy at send
        // time). This settle belongs to an unrelated run — it must neither
        // resolve the wake as delivered nor clear its armed retry, and the
        // entry is KEPT: the pending busy rung, or the parked late delivery,
        // owns its liveness past this settle.
        continue;
      }
      if (failed && !landed?.has(w.timer.id)) {
        this.scheduleRetry(w.timer, w.attempt + 1, now);
      } else {
        this.stats.succeeded++;
        this.timeoutCounts.delete(w.timer.id);
        this.cancelPendingRetries(w.timer.id);
        try {
          this.wakeObserver?.onWakeDelivered?.(w.timer);
        } catch {
          // alerting must never break outcome resolution
        }
        try {
          // The wake path is the layer that knows a TURN completed cleanly —
          // an internal LLM call cannot distinguish itself — so the breaker's
          // clean-turn reset lives here, not in the raw success counter.
          this.wakeObserver?.onCleanTurn?.();
        } catch {
          // a throwing observer must never break settlement
        }
      }
      this.outstanding.delete(id);
    }
  }

  /**
   * Arm a redelivery for a wake whose SEND was deferred: the session was
   * busy at send time (ctx.signal undefined while ctx.isIdle() is false —
   * compaction / run bookkeeping; a raw triggerTurn there would start a
   * competing agent run). Rides the same bounded backoff ladder and cap as
   * failed-turn redeliveries; the redelivery text says "held while the
   * session was busy" instead of claiming a failed turn. The outstanding
   * entry is marked busy-deferred so a settle of an unrelated run that
   * overlaps the deferral window cannot resolve the wake as delivered.
   *
   * When the ladder is spent the fire is PARKED, never dropped: nothing
   * failed, so the exhausted path (and the watchdog's undelivered page) does
   * not apply. drainParkedBusy() then hands it to one late delivery once the
   * session is idle, with the full hold duration in the text.
   */
  deferBusyWake(timer: ScheduledTimer, attempt: number): void {
    const now = this.now();
    const w = this.outstanding.get(timer.id);
    if (w) {
      w.busyDeferred = true;
      if (w.heldSince === undefined) w.heldSince = now;
    }
    if (attempt + 1 > this.getMaxAttempts()) {
      this.parkBusyFire(timer, w, attempt, now);
      return;
    }
    const armed = this.scheduleRetry(timer, attempt + 1, now, "busy");
    if (armed && w) {
      // The deferral armed the ladder itself: mark the entry so the outcome
      // window neither re-arms it (which would only push the redelivery
      // back out) nor feeds the repeated-timeout stall signal. The ladder
      // drains at its own backoff; the wake resolves delivered when its
      // eventual turn settles.
      w.timedOut = true;
    }
  }

  /** Park a busy-held fire whose bounded ladder is spent. The fire is NOT
   *  dropped and NOT counted as exhausted: it waits for one late delivery at
   *  the next idle drain. An untracked deferral (a wiring defect — every wake
   *  path tracks before sending) is parked on a fresh entry so a held wake
   *  can never be lost here. */
  private parkBusyFire(
    timer: ScheduledTimer,
    w: OutstandingWake | undefined,
    attempt: number,
    now: number,
  ): void {
    if (w) {
      w.parkedBusy = true;
      w.timedOut = true;
    } else {
      this.outstanding.set(timer.id, {
        timer,
        attempt,
        sentAt: now,
        busyDeferred: true,
        heldSince: now,
        parkedBusy: true,
        timedOut: true,
      });
      log.warn(`[timer] busy deferral for an untracked fire — parked it directly: ${timer.id}`);
    }
    this.timeoutCounts.delete(timer.id);
    this.stats.heldBusy++;
    log.info(
      `[timer] wake fire held while the session was busy — ` +
        `${this.getMaxAttempts()} attempt(s) spent, parked for one late delivery: ${timer.id}`,
    );
  }

  /**
   * Hand off parked busy-held fires that can be delivered now: the session is
   * not positively busy (an active run / pre-flight / compaction keeps them
   * parked — the send's own onBusy hook would only hold the fire again, so
   * waiting keeps this to one handoff per settle rather than one attempt per
   * poll tick). Each handed-off fire is marked in-flight so a concurrent tick
   * cannot hand it off twice; the caller re-tracks it (trackWake) and a send
   * that is deferred again is held again — one fresh rung, then a re-park once
   * the cap is hit again.
   */
  drainParkedBusy(): ParkedBusyDelivery[] {
    if (this.isFireTurnRunning()) return [];
    const now = this.now();
    const out: ParkedBusyDelivery[] = [];
    for (const [, w] of this.outstanding) {
      if (!w.parkedBusy || w.parkedDelivering) continue;
      w.parkedDelivering = true;
      out.push({ timer: w.timer, heldMs: Math.max(0, now - (w.heldSince ?? w.sentAt)) });
    }
    return out;
  }

  /** Forget a parked busy-held fire without a late delivery — its content was
   *  shown non-waking (terminal-error breaker) or the caller withdrew it. */
  forgetParkedBusy(timerId: string): void {
    if (this.outstanding.get(timerId)?.parkedBusy) this.outstanding.delete(timerId);
  }

  /**
   * Called on every poll tick / TOOL_EXECUTION_END / TURN_END (the same
   * ticks that fire expired timers). First re-arms outstanding wakes that
   * never got an outcome (timeout fallback), then returns retries whose
   * backoff has elapsed. The CALLER performs the redelivery (deferred via
   * setTimeout(0), like every fire-path send) and re-tracks the outcome via
   * trackWake(timer, attempt).
   */
  drainDue(): DueRetry[] {
    const now = this.now();
    // A retryable failure may still be inside pi-core's auto-retry
    // cycle — the run's final outcome is undecided, so the outcome timeout
    // must NOT arm a mid-cycle redelivery (the flood source). After the hold
    // expires the normal timeout math applies (bounded re-check); a settle
    // in the meantime clears the hold entirely.
    const holdActive = this.retryHoldUntil !== null && now < this.retryHoldUntil;
    // Long-run grace: an outcome window that elapses while a run is active
    // for a wake whose send was NOT busy-deferred is a merely-long turn, not
    // a lost send. Do not arm (and do not count it toward the repeated-
    // timeout stall signal): the run's own settle resolves the wake. The
    // 240s window keeps its job for the send that never started a turn
    // (pre-flight abort — no run is active then, so the timeout arms with
    // the honest "timeout" cause and the recovery path survives).
    const runActive = !holdActive && this.isFireTurnRunning();
    for (const [id, w] of this.outstanding) {
      if (w.timedOut) continue; // A retry is already armed for this delivery
      if (holdActive) continue;
      if (runActive && !w.busyDeferred) continue; // long-run grace
      if (now - w.sentAt < WAKE_OUTCOME_TIMEOUT_MS) continue;
      this.stats.timedOut++;
      const timeouts = (this.timeoutCounts.get(id) ?? 0) + 1;
      this.timeoutCounts.set(id, timeouts);
      log.warn(
        `[timer] wake outcome timeout (${WAKE_OUTCOME_TIMEOUT_MS}ms, #${timeouts} for this fire) for ${id} — re-arming for retry`,
      );
      try {
        this.wakeObserver?.onOutcomeTimeout?.(w.timer, timeouts);
      } catch {
        // alerting must never break the retry arming
      }
      const armed = this.scheduleRetry(
        w.timer,
        w.attempt + 1,
        now,
        w.busyDeferred ? "busy" : "timeout",
      );
      if (armed) {
        // Keep the entry (marked) so the eventual settle of this
        // delivery — success OR failure — still resolves it. Deleting here
        //  orphaned the chain: the later successful settle found
        // an empty outstanding map and the armed retry kept firing.
        w.timedOut = true;
      } else {
        // Exhausted (pre-flight-abort chain): nothing left to resolve.
        this.outstanding.delete(id);
      }
    }
    const due: DueRetry[] = [];
    const remaining: RetryEntry[] = [];
    for (const r of this.retries) {
      if (r.nextAttemptAt <= now) {
        due.push({ timer: r.timer, attempt: r.attempt, cause: r.cause });
      } else {
        remaining.push(r);
      }
    }
    this.retries = remaining;
    return due;
  }

  /** Fires dropped after exceeding the redelivery bound (for a final notice). */
  takeExhausted(): ScheduledTimer[] {
    const out = this.exhaustedFires;
    this.exhaustedFires = [];
    return out;
  }

  /** Park a recovered persisted fire for post-settle delivery (fix 3). */
  deferRecoveredFire(fire: RecoveredFire): void {
    this.deferredRecovered.push(fire);
  }

  /** Drain parked recovered fires (one-shot; re-park on delivery failure). */
  takeRecoveredFires(): RecoveredFire[] {
    const out = this.deferredRecovered;
    this.deferredRecovered = [];
    return out;
  }

  deferredRecoveredCount(): number {
    return this.deferredRecovered.length;
  }

  outstandingCount(): number {
    return this.outstanding.size;
  }

  /**
   * Whether any OUTSTANDING wake is a redelivery
   * (attempt >= 1 — re-tracked via trackWake(timer, attempt) by the
   * redelivery path). While true, a wake fire re-delivered after a failed
   * turn is in flight and its outcome has not settled. Read-only query —
   * NO redelivery behavior change (redelivery logic itself is out of scope
   * for callers of this accessor).
   *
   * Precision note: if the wake-gate rewrote the retry into a queued steer
   * inside an active run, this stays true until that run settles, so one
   * unrelated mid-run judge opportunity may be skipped. A skipped judge is
   * merely delayed (next non-redelivery turn judges); a false FAIL audit of
   * a fragment turn is the failure mode this gate exists to prevent.
   */
  hasOutstandingRedelivery(): boolean {
    for (const w of this.outstanding.values()) {
      if (w.attempt >= 1) return true;
    }
    return false;
  }

  pendingRetryCount(): number {
    return this.retries.length;
  }

  /**
   * Retire a cancelled timer's fire: drop its outstanding wake (if any), its
   * armed ladder, any parked recovered fire for the id, and the repeated-
   * timeout bookkeeping. Marks the id retired so an in-flight send is
   * suppressed (see `retired`). Called from cancelTimer — including when the
   * timer is no longer in the manager map (a fired one-shot is deleted from
   * it at expiry, but its wake ladder may still be armed; the cancel must
   * reach it). Retirement is a WITHDRAWAL, not a delivery: stats.succeeded
   * stays untouched.
   */
  retireTimer(timerId: string): void {
    const hadOutstanding = this.outstanding.delete(timerId);
    const retriesBefore = this.retries.length;
    this.retries = this.retries.filter((r) => r.timer.id !== timerId);
    const droppedRetries = retriesBefore - this.retries.length;
    const recoveredBefore = this.deferredRecovered.length;
    this.deferredRecovered = this.deferredRecovered.filter((f) => f.id !== timerId);
    const droppedRecovered = recoveredBefore - this.deferredRecovered.length;
    this.timeoutCounts.delete(timerId);
    this.retired.add(timerId);
    if (hadOutstanding || droppedRetries > 0 || droppedRecovered > 0) {
      log.info(
        `[timer] timer cancelled — retired its fire ` +
          `(outstanding wake: ${hadOutstanding ? "cleared" : "none"}, ` +
          `pending retries: ${droppedRetries}, parked recovered fires: ${droppedRecovered}): ${timerId}`,
      );
    }
  }

  /**
   * Retire every fire matching the predicate (tag/session-scoped cancels).
   * Walks the queue's own records — the outstanding wakes, the armed
   * ladders, and the parked recovered fires — so it also reaches fires that
   * already left the manager map (fired one-shots; delete-on-detection).
   * Returns the retired timer ids.
   */
  retireTimersWhere(predicate: (t: ScheduledTimer) => boolean): string[] {
    const ids = new Set<string>();
    for (const [, w] of this.outstanding) if (predicate(w.timer)) ids.add(w.timer.id);
    for (const r of this.retries) if (predicate(r.timer)) ids.add(r.timer.id);
    for (const f of this.deferredRecovered) {
      if (f.wake && f.sessionId) {
        const asTimer: ScheduledTimer = {
          id: f.id,
          sessionId: f.sessionId,
          firesAt: f.firesAt ?? 0,
          reason: f.reason,
          tag: f.tag,
          createdAt: f.createdAt ?? 0,
          wake: true,
        };
        if (predicate(asTimer)) ids.add(f.id);
      }
    }
    const out = [...ids];
    for (const id of out) this.retireTimer(id);
    return out;
  }

  /** Whether the id is retired (cancel guard for in-flight sends). */
  isRetired(timerId: string): boolean {
    return this.retired.has(timerId);
  }

  /** Whether any live wake state exists for the id (outstanding wake, armed
   *  ladder, parked recovered fire). Read BEFORE a cancel so the caller can
   *  distinguish "nothing to cancel" from "the fire already left the timer
   *  map but its ladder was retired". */
  hasWakeFireState(timerId: string): boolean {
    if (this.outstanding.has(timerId)) return true;
    if (this.retries.some((r) => r.timer.id === timerId)) return true;
    return this.deferredRecovered.some((f) => f.id === timerId);
  }

  getStats(): WakeRetryStats {
    return { ...this.stats };
  }

  /** Reset all state. Test helper (process-lifetime singleton). */
  resetForTests(): void {
    this.outstanding.clear();
    this.retries = [];
    this.exhaustedFires = [];
    this.deferredRecovered = [];
    this.lastRunFailed = null;
    this.landedTimerIds = null;
    this.retryHoldUntil = null;
    this.retryHoldOverrideMs = null;
    this.maxAttemptsOverride = null;
    this.timeoutCounts.clear();
    this.retired.clear();
    // setWakeObserver wiring deliberately survives: it is production wiring,
    // not per-test outcome state (the timer extension sets it once at load).
    // The active-run predicate survives the same way.
    this.stats = { tracked: 0, succeeded: 0, timedOut: 0, exhausted: 0, heldBusy: 0 };
  }

  /** Drop pending redeliveries for a timer id (success clears the chain). */
  private cancelPendingRetries(timerId: string): void {
    const before = this.retries.length;
    this.retries = this.retries.filter((r) => r.timer.id !== timerId);
    if (this.retries.length < before) {
      log.info(
        `[timer] wake turn succeeded — cleared ${before - this.retries.length} pending retry(ies) for ${timerId}`,
      );
    }
  }

  /**
   * Arm (or replace) the pending redelivery for a fire. Replace-by-id —
   * the outcome-timeout path may already have armed a retry while the failed
   * turn was still running; a genuine settle-failure must escalate that entry
   * in place, never stack a second redelivery for the same fire.
   * Returns true if armed, false if the bound is exhausted.
   */
  private scheduleRetry(
    timer: ScheduledTimer,
    attempt: number,
    now: number,
    cause: WakeRetryCause = "failed",
  ): boolean {
    const maxAttempts = this.getMaxAttempts();
    if (attempt > maxAttempts) {
      this.stats.exhausted++;
      this.timeoutCounts.delete(timer.id);
      this.exhaustedFires.push(timer);
      log.error(
        `[timer] wake fire permanently undelivered after ${maxAttempts} redeliveries: ` +
          `${timer.id} (${timer.reason})`,
      );
      return false;
    }
    const backoff = WAKE_RETRY_BACKOFF_MS[Math.min(attempt - 1, WAKE_RETRY_BACKOFF_MS.length - 1)];
    this.retries = this.retries.filter((r) => r.timer.id !== timer.id);
    this.retries.push({ timer, attempt, nextAttemptAt: now + backoff, cause });
    log.info(
      `[timer] wake fire undelivered (attempt ${attempt}/${maxAttempts}, ${cause}) — retry in ${backoff}ms: ${timer.id}`,
    );
    return true;
  }
}

/** The process-wide queue (single pi session per process). */
export const wakeRetryQueue = new WakeRetryQueue();

/**
 * Read accessor: is a wake-retry redelivery (attempt >= 1)
 * currently in flight (tracked, outcome not settled)? The enforcement
 * verification judge uses this to SKIP auditing the redelivered tail turn —
 * a fragment the judge would otherwise treat as the whole task. Read-only;
 * no redelivery behavior change.
 */
export function isWakeRedeliveryInFlight(): boolean {
  return wakeRetryQueue.hasOutstandingRedelivery();
}

/**
 * Deliver parked recovered fires post-settle. Called from
 * agent_settled handlers (timer extension primary + prompt-builder fallback —
 * takeRecoveredFires() drains, so double registration cannot double-deliver;
 * onAgentSettled() is idempotent, so outcome resolution is order-safe).
 *
 * wake:true fires start their own turn (safe here: the run has fully settled
 * and pi-core released activeRun; the triggerTurn deferral in
 * sendTrackedMessage keeps the macrotask boundary). If the session is busy
 * at flush time anyway (an overlapping compaction, say), the busy hook
 * re-parks the fire — the next settle flushes it; never silently lost.
 * wake:false fires ride as advisory steers, as before. Every delivered wake
 * is tracked so a failed delivery retries with backoff.
 */
export function flushRecoveredFires(pi: ExtensionAPI, ctx?: unknown): void {
  const fires = wakeRetryQueue.takeRecoveredFires();
  // Resolve any outstanding wake outcomes FIRST so the freshly-flushed fires
  // are never mis-attributed to the previous run's failure.
  wakeRetryQueue.onAgentSettled();
  if (fires.length === 0) return;
  log.info(`[timer] flushing ${fires.length} recovered persisted fire(s) post-settle`);
  for (const t of fires) {
    // Every recovered fire carries the SAME timing marker as a live fire
    // (fire-timing.ts): a fire recovered after a restart can be very late,
    // and a bare reason line reads as on-time — the agent needs the drift
    // to reason about what it is resuming.
    const { fireTiming, elapsedSec, driftLabel } = describeFireTiming(
      t.createdAt,
      t.firesAt,
      Date.now(),
    );
    if (driftLabel !== "0m") {
      log.info(`[timer] recovered fire ${t.id} delivered late by ${driftLabel}`);
    }
    const text =
      t.wake === true
        ? `${t.reason} - ${fireTiming}. ${elapsedSec}s elapsed since scheduled. Resume the task.`
        : `${t.reason} (${fireTiming}) (recovered after restart)`;
    try {
      if (t.wake === true && terminalBreakerBlocksWake(ctx)) {
        // Terminal-error breaker open: the recovered reminder is still shown,
        // but rides non-waking and is not tracked (no turn to resolve).
        log.info(`[timer] recovered fire ${t.id} demoted to non-waking (turn-start blocked)`);
        sendTrackedMessage(
          pi,
          {
            customType: "timer-fire",
            content: [{ type: "text" as const, text }],
            display: true,
            details: {
              [BRAID_INJECTED]: true,
              [BRAID_SOURCE]: "timer/persisted-fire",
              timerId: t.id,
              sessionId: t.sessionId,
              recovered: true,
              wake: true,
              breakerSuppressed: true,
            },
          },
          { delivery: "park", deliverAs: "steer" },
          { type: "heartbeat", source: "timer/persisted-fire" },
          { bypassFloodCap: true },
        );
        continue;
      }
      if (t.wake === true) {
        wakeRetryQueue.trackWake({
          id: t.id,
          sessionId: t.sessionId,
          firesAt: t.firesAt ?? Date.now(),
          reason: t.reason,
          tag: t.tag,
          createdAt: t.createdAt ?? Date.now(),
          wake: true,
        });
        sendTrackedMessage(
          pi,
          {
            customType: "timer-fire",
            content: [{ type: "text" as const, text }],
            display: true,
            details: {
              [BRAID_INJECTED]: true,
              [BRAID_SOURCE]: "timer/persisted-fire",
              timerId: t.id,
              sessionId: t.sessionId,
              recovered: true,
              wake: true,
            },
          },
          { triggerTurn: true },
          { type: "heartbeat", source: "timer/persisted-fire" },
          { bypassFloodCap: true },
          {
            onBusy: () => {
              // Session busy at send time: re-park; the next settle flushes.
              wakeRetryQueue.deferRecoveredFire(t);
            },
          },
        );
      } else {
        sendTrackedMessage(
          pi,
          {
            customType: "timer",
            content: [{ type: "text" as const, text }],
            display: true,
            details: {
              [BRAID_INJECTED]: true,
              [BRAID_SOURCE]: "timer/persisted-fire",
              timerId: t.id,
              recovered: true,
              wake: false,
            },
          },
          { delivery: "park", deliverAs: "steer" },
          { type: "heartbeat", source: "timer/persisted-fire" },
          { bypassFloodCap: true },
        );
      }
    } catch (e) {
      // Send failed: park it again — the next settle retries. Never
      // silently lose a recovered fire.
      log.warn(`[timer] recovered fire delivery failed, re-deferred: ${(e as Error).message}`);
      wakeRetryQueue.deferRecoveredFire(t);
    }
  }
}
