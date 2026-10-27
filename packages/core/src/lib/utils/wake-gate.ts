/**
 * Wake Gate - prevents triggerTurn wakes from re-entering pi-core's agent
 * loop while a session prompt is being prepared (the pre-flight window).
 *
 * PROBLEM (pi-core 1.0.2):
 *   pi-core's sendCustomMessage routes triggerTurn:true to `_runAgentPrompt`
 *   whenever the SESSION-level isStreaming flag (`_isAgentRunActive`) is false.
 *   But `_isAgentRunActive` is only set inside `_runAgentPrompt`
 *   (agent-session.js) and cleared in `_emitAgentSettled`. The session
 *   `prompt()` PRE-FLIGHT (model/auth checks, `_checkCompaction`,
 *   `emitBeforeAgentStart`) runs with isStreaming=false. A triggerTurn wake
 *   that lands during that pre-flight starts a COMPETING agent run; when
 *   the outer `prompt()` then reaches `_runAgentPrompt` ->
 *   `agent.prompt()`, pi-agent-core's activeRun guard throws
 *   "Agent is already processing a prompt. Use steer() or followUp() ...".
 *   The compaction boundary is the worst offender: `_checkCompaction`'s LLM
 *   summarization is a multi-second await inside the pre-flight, so a
 *   deferred wake (timer fires are setTimeout(0)-deferred) has ample time to
 *   land there.
 *
 * GATE (this module): the pre-flight START is not observable by extensions,
 *   but its TAIL and the run itself are:
 *     - before_agent_start (mid pre-flight)
 *     - session_before_compact (compaction start)
 *     - agent_start (core run start)
 *   From the first of {input (idle), before_agent_start,
 *   session_before_compact} until agent_start (or session_compact, for the
 *   manual-compaction path where no run follows), a triggerTurn wake is gated
 *   into a live-delivery send instead of a raw re-entry: triggerTurn is
 *   dropped, so pi-core routes the wake by live state - steer (branch 2)
 *   while a run is streaming, session append (branch 5) in the pre-flight.
 *   Either route reaches the run that is active or imminent and neither
 *   starts a competing one. After agent_start the session isStreaming flag
 *   is true, so pi-core's own sendCustomMessage already queues wakes; the
 *   gate RELEASES at agent_start to keep the post-run settle window
 *   triggerTurn capable (a wake there is a safe re-entry: core has already
 *   released activeRun). session_compact also releases: in the MANUAL-
 *   compaction path the agent is aborted and idle (no run follows), so the
 *   post-compaction auto-resume wake (register-session-compact,
 *   triggerTurn:true) must pass through ungated - gating it would
 *   re-introduce the post-compaction loop stop. In the AUTO path
 *   isStreaming is true from _runAgentPrompt entry through the post-run
 *   loop, so releasing at session_compact is safe there too.
 *
 * STATE-BASED DEFERRAL (send-time busy check): the region flag is a
 *   heuristic window; the load-bearing decision is the LIVE agent state at
 *   wake send time. registerWakeGate captures the session ctx from the
 *   events it already subscribes to, and isAgentBusy() reads it live:
 *   `ctx.signal === undefined && !ctx.isIdle()` — the session is in run
 *   bookkeeping or compaction while NO streaming run holds pi-core's queue
 *   (isIdle is false through both; signal is undefined outside a run). A
 *   raw triggerTurn landing there routes to _runAgentPrompt and starts a
 *   COMPETING run (the activeRun guard throws). sendTrackedMessage's
 *   deferred macrotask consults isAgentBusy() and, when the caller supplied
 *   a re-queue hook (timer wakes: the wake-retry queue), parks the wake
 *   instead of sending; the redelivery re-checks and starts its own turn
 *   once the session is idle. Wakes without a hook (and an unreadable
 *   state) fail open to the region-gate behavior above. Mid-run steering is
 *   untouched: signal defined means the run is live and pi-core queues the
 *   send itself.
 *
 * RESIDUAL GAP (pi-core): pi-core emits `input` to extension handlers at
 *   session.prompt() ENTRY (before the auth/compaction pre-flight and before
 *   before_agent_start), so an idle prompt arms the gate from the first
 *   await of the pre-flight. The arm is conditional: `input` carries
 *   `streamingBehavior` ONLY when the prompt is a steer/followUp into an
 *   ACTIVE run; such a prompt queues and returns without starting a run,
 *   and agent_start will not re-fire for it, so arming there would leak the
 *   gate up to the 120s fail-safe past the run's end. The one uncovered
 *   slice is the synchronous pre-input section of prompt() (extension
 *   `/command` dispatch), which returns before any await. The definitive
 *   fix stays in pi-core: set `_isAgentRunActive` at session.prompt()
 *   entry, or gate sendCustomMessage's triggerTurn branch on the CORE
 *   activeRun (`this.agent.signal`).
 *
 * FAIL-SAFE: pi-core emits NO event when the pre-flight ABORTS (auth/quota
 *   errors: before_agent_start fires, then the pre-flight catch rethrows and
 *   agent_start is never emitted — no extension event on that path). Without
 *   a clear, a gate armed by an aborted turn stays true for the whole idle
 *   period: every wake:true timer fire routes to a queued steer that never
 *   starts a turn, and periodic fires batch behind the next user prompt. The
 *   fail-safe below auto-clears the gate RUN_REGION_MAX_MS after the last
 *   arming event, so a stuck gate self-heals without needing an abort event
 *   that pi-core does not provide. For wakes WITH a re-queue hook the
 *   fail-safe is not load-bearing: a fail-safe clear during a still-busy
 *   session does not re-expose the wake (the live-state check defers it, so
 *   a clear cannot cause a throw on that path); the region flag + fail-safe
 *   remain the catch-all rewrite for senders without a re-queue path.
 *
 * Scope: single-process-per-session (see injection-tracker.ts header) —
 *   module-level flag is process-global but every pi session registers once,
 *   so in practice it tracks the single live session.
 */

import { createLogger } from "../core/logger.js";
import { SESSION_BEFORE_COMPACT, SESSION_START, SESSION_SHUTDOWN } from "../core/event-names.js";

const log = createLogger("wake-gate");

// True while a session prompt is being prepared (pre-flight tail) so that a
// triggerTurn wake would start a COMPETING run. Cleared at agent_start: from
// then on pi-core's own isStreaming queueing takes over.
let _runRegionActive = false;

/** Structural slice of ExtensionContext the busy query needs. The getters
 *  are live: each ctx reads current runtime state at call time, so a
 *  captured ctx answers truthfully until the runner is invalidated (session
 *  replacement/reload — the call throws and the query fails open). */
interface AgentStateCtx {
  isIdle: () => boolean;
  signal: AbortSignal | undefined;
}

// The most recently observed session ctx, captured from wake-gate's own
// event handlers. Its getters stay live across events, so a ctx captured
// at session start still reads current state when a wake sends minutes
// later.
let _lastAgentCtx: AgentStateCtx | null = null;

function captureAgentCtx(ctx: unknown): void {
  if (ctx && typeof ctx === "object") _lastAgentCtx = ctx as AgentStateCtx;
}

/**
 * Whether the session is busy in the state that makes a raw triggerTurn
 * send dangerous: no streaming run holds the queue (`signal` undefined) but
 * the session is not idle either (`isIdle` false — compaction, or run
 * pre-flight/bookkeeping). pi-core's sendCustomMessage would route such a
 * send to `_runAgentPrompt` and start a competing agent run.
 *
 * Fails open (false) unless busy is POSITIVELY determined: no ctx captured
 * yet, a ctx without live readers, or a stale ctx (its getters throw after
 * session replacement) all mean "unknown" — the region gate above stays the
 * safety net for those.
 */
export function isAgentBusy(): boolean {
  const ctx = _lastAgentCtx;
  if (!ctx || typeof ctx.isIdle !== "function") return false;
  try {
    return ctx.signal === undefined && ctx.isIdle() === false;
  } catch {
    return false;
  }
}

// Fail-safe bound: how long a run region may stay armed without a release
// event before the gate auto-clears. Covers the legitimate pre-flight tail
// (sub-second) and a compaction summarization (session_before_compact re-arms
// the timer, so the bound only needs to exceed a single compaction). Guards
// against a pre-flight abort (auth/quota) leaving the gate stuck true, which
// rewrites every triggerTurn wake to a queued steer that never starts a turn.
export const RUN_REGION_MAX_MS = 120_000;

let _failSafeHandle: ReturnType<typeof setTimeout> | null = null;
// Test hook: override the fail-safe bound (null restores the default).
let _failSafeMsOverride: number | null = null;

/**
 * Why the last turn could not be sent at all, when the reason is the SHAPE of
 * the request rather than the state of the provider. A context-length refusal
 * is permanent for a given context: every later turn carrying the same payload
 * is refused the same way, so an ungated wake that starts one is not a retry,
 * it is the same failure under a fresh request id.
 */
let _requestShapeFailure: string | null = null;

/** Record that the last turn failed on request shape (a context-length refusal). */
export function noteRequestShapeFailure(detail: string): void {
  _requestShapeFailure = detail;
}

/** The recorded request-shape failure, or null. */
export function requestShapeFailure(): string | null {
  return _requestShapeFailure;
}

/** Clear the record (a request that fits went through, or a new session). */
export function clearRequestShapeFailure(): void {
  _requestShapeFailure = null;
}

function failSafeMs(): number {
  return _failSafeMsOverride ?? RUN_REGION_MAX_MS;
}

function clearFailSafe(): void {
  if (_failSafeHandle) {
    clearTimeout(_failSafeHandle);
    _failSafeHandle = null;
  }
}

/** Arm the gate (or re-arm it, resetting the fail-safe window). */
function armRunRegion(): void {
  _runRegionActive = true;
  clearFailSafe();
  scheduleFailSafe();
  // Do not keep the process alive for a stuck gate.
  unrefFailSafe();
}

/** Let the process exit while a fail-safe window is pending. */
function unrefFailSafe(): void {
  const handle = _failSafeHandle as { unref?: () => void } | null;
  if (typeof handle?.unref === "function") handle.unref();
}

/**
 * One fail-safe window. Normally the gate opens here: a gate stuck closed by a
 * pre-flight abort rewrites every wake into a queued steer that never starts a
 * turn, which is its own failure.
 *
 * The exception is a recorded request-shape failure. There, opening the gate
 * buys no safety - it starts the same doomed request again, and again. So the
 * gate stays closed and the window re-arms: wakes keep arriving as steers into
 * the session (the shape that reads them when a run does start) without
 * starting one.
 */
function scheduleFailSafe(): void {
  _failSafeHandle = setTimeout(() => {
    _failSafeHandle = null;
    if (_requestShapeFailure) {
      log.warn(
        `[wake-gate] fail-safe: keeping triggerTurn wakes gated - the last turn was refused on ` +
          `request shape (context length), so the request it would start cannot succeed. ` +
          `Remedy: compact the session. Detail: ${_requestShapeFailure}`,
      );
      scheduleFailSafe();
      unrefFailSafe();
      return;
    }
    _runRegionActive = false;
    log.warn(
      `[wake-gate] fail-safe: run region auto-cleared after ${failSafeMs()}ms without a release event ` +
        `(pre-flight abort?) — triggerTurn wakes ungated again`,
    );
  }, failSafeMs());
}

/** Release the gate and cancel the fail-safe timer. */
function releaseRunRegion(): void {
  _runRegionActive = false;
  clearFailSafe();
}

/** Whether a triggerTurn send should be gated (pre-flight tail in progress). */
export function isRunRegionActive(): boolean {
  return _runRegionActive;
}

/** Test hook: reset module state between fixtures (also cancels the fail-safe). */
export function resetWakeGateForTests(): void {
  releaseRunRegion();
  _lastAgentCtx = null;
  _failSafeMsOverride = null;
  _requestShapeFailure = null;
}

/** Test hook: shorten/extend the fail-safe bound (null restores the default). */
export function _setWakeGateFailSafeMsForTests(ms: number | null): void {
  _failSafeMsOverride = ms;
}

/**
 * Register the wake-gate event subscriptions. Call once per pi session
 * (alongside registerInjectionTracker — the enforcement bootstrap in
 * handler-registry.ts wires both).
 *
 * The local `on` type widens ExtensionAPI's overloaded on() so we can pass
 * plain event names without TypeScript picking an overload.
 */
export function registerWakeGate(pi: {
  on: (event: string, handler: (...args: any[]) => any) => void;
}): void {
  (pi.on as (event: string, handler: (...args: any[]) => any) => void)(
    "before_agent_start",
    (_event: unknown, ctx: unknown) => {
      captureAgentCtx(ctx);
      armRunRegion();
    },
  );
  // `input` fires at session.prompt() ENTRY — before the pre-flight
  // (model/auth checks, _checkCompaction) and before before_agent_start.
  // Arming here closes the prompt-entry competing-run window for
  // extension-originated sends (a wake landing between prompt entry and
  // before_agent_start was previously ungated). Arm ONLY when the prompt
  // will start a NEW run: `streamingBehavior` is set exactly when the input
  // is a steer/followUp into an ACTIVE run (pi-core queues it without
  // starting a run, and agent_start will not re-fire) — arming there would
  // leak the gate past the run's end until the fail-safe. Input arms use the
  // same armRunRegion path, so the 120s fail-safe semantics apply unchanged.
  (pi.on as (event: string, handler: (...args: any[]) => any) => void)(
    "input",
    (event: { streamingBehavior?: string }, ctx: unknown) => {
      captureAgentCtx(ctx);
      if (event?.streamingBehavior === undefined) armRunRegion();
    },
  );
  (pi.on as (event: string, handler: (...args: any[]) => any) => void)(
    SESSION_BEFORE_COMPACT,
    (_event: unknown, ctx: unknown) => {
      captureAgentCtx(ctx);
      armRunRegion();
    },
  );
  (pi.on as (event: string, handler: (...args: any[]) => any) => void)(
    "agent_start",
    (_event: unknown, ctx: unknown) => {
      captureAgentCtx(ctx);
      releaseRunRegion();
    },
  );
  // Manual compaction: agent is aborted + idle (no run follows) — release so
  // the post-compaction auto-resume wake passes through ungated.
  (pi.on as (event: string, handler: (...args: any[]) => any) => void)(
    "session_compact",
    (_event: unknown, ctx: unknown) => {
      captureAgentCtx(ctx);
      releaseRunRegion();
    },
  );
  (pi.on as (event: string, handler: (...args: any[]) => any) => void)(
    SESSION_START,
    (_event: unknown, ctx: unknown) => {
      captureAgentCtx(ctx);
      releaseRunRegion();
    },
  );
  (pi.on as (event: string, handler: (...args: any[]) => any) => void)(SESSION_SHUTDOWN, () => {
    releaseRunRegion();
    _requestShapeFailure = null; // a new session starts without a shape verdict
    _lastAgentCtx = null; // no live session after shutdown: fail open until the next capture
  });
}

/** Delivery options handed to pi.sendMessage / sendTrackedMessage. */
export interface WakeDeliveryOptions {
  triggerTurn?: boolean;
  deliverAs?: string;
}

/**
 * Gate a triggerTurn send on the run-region state.
 *
 * - Not a triggerTurn, or no run region active -> options unchanged (wake hits
 *   pi-core's triggerTurn branch exactly as before: idle wake preserved).
 * - Run region active -> triggerTurn is dropped entirely and the send takes
 *   the funnel's live shape `{ deliverAs }` (steer by default, preserving an
 *   explicit deliverAs). pi-core 1.0.2 routes that shape by live state
 *   (dist/core/agent-session.js:1759-1782): while a run is streaming it steers
 *   into that run (branch 2); in the pre-flight (isStreaming false) it is
 *   appended to the session immediately (branch 5), so the imminent run reads
 *   it. Neither route starts a competing run. Returning
 *   `triggerTurn: false` instead would park the wake to the end-of-turn flush
 *   (branch 4) - pi 0.84.2 made that shape park (PR #8022), which is what
 *   this gate used to return.
 *
 * REVERT-PROOF contract: removing the gate (or never registering it) means
 *   `_runRegionActive` stays false and every triggerTurn send passes through
 *   ungated — the fixture test in test-wake-gate.mjs fails, pinning the gate.
 */
export function gateTriggerTurnOptions(
  options: WakeDeliveryOptions | undefined,
): WakeDeliveryOptions | undefined {
  if (!options?.triggerTurn) return options;
  if (!_runRegionActive) return options;
  log.info(
    `[wake-gate] triggerTurn wake gated to live delivery (run region active) - deliverAs=${
      options.deliverAs ?? "steer"
    }`,
  );
  return { deliverAs: options.deliverAs ?? "steer" };
}
