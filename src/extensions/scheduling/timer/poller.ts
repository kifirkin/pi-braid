/**
 * Timer poller - real-time 1s polling that fires expired timers
 * independently of turn_end.
 *
 * Extracted from index.ts. The poller is the primary fire mechanism
 * (turn_end is a backup). Each pi instance gets its own poller to
 * support multiple concurrent sessions.
 *
 * The busy guard prevents firing mid-tool-execution (which can chain
 * into synchronous re-entry and overflow the stack).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ScheduledTimer } from "../../../lib/events/timer-types.js";

const POLL_INTERVAL_MS = 1000;

export class TimerPoller {
  pollHandle: ReturnType<typeof setInterval> | null = null;
  piRef: ExtensionAPI | null = null;
  // busy guard: when true, the poller skips fireTimer() to prevent whisper
  // injection mid-tool-execution (which can chain into synchronous re-entry
  // and overflow the stack - see issue: stack overflow on scratchpad after
  // compaction). Set true on TOOL_CALL, false on TURN_END.
  busy = false;

  constructor(
    private sessionId: string,
    private onCheckExpired: (sessionId: string, now: number) => ScheduledTimer[],
    private onFire: (timer: ScheduledTimer, pi: ExtensionAPI) => void,
    private log: { info: (msg: string) => void },
  ) {}

  setPiRef(pi: ExtensionAPI): void {
    this.piRef = pi;
  }

  start(): void {
    if (this.pollHandle) return;
    this.pollHandle = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.log.info(`[timer] polling started (session=${this.sessionId}, every ${POLL_INTERVAL_MS}ms)`);
  }

  stop(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  private poll(): void {
    const pi = this.piRef;
    if (!pi) return;
    if (this.busy) return; // bail - defer fire to next non-busy tick or TURN_END
    const expired = this.onCheckExpired(this.sessionId, Date.now());
    for (const timer of expired) {
      // Defer fire to after the current synchronous stack unwinds to break
      // the synchronous chain from setInterval into pi-core's
      // sendMessage(triggerTurn:true) -> _runAgentPrompt -> tool dispatch.
      // Without this, a poller fire during an agent turn (or immediately after
      // compaction) can chain into pi-core's synchronous tool dispatch and
      // overflow the V8 stack.
      //
      // queueMicrotask runs after the current JS context completes but before
      // the next macrotask -- zero-latency deferral without the 1ms timer
      // overhead of setTimeout(0). The one-tick delay is acceptable: the timer
      // already expired, and the agent will wake up on the next tick.
      queueMicrotask(() => {
        this.onFire(timer, pi);
      });
    }
  }

  isRunning(): boolean {
    return this.pollHandle !== null;
  }

  /** Fire any expired timers now (called from TOOL_EXECUTION_END / TURN_END).
   *
   * Each fire is deferred to after the current synchronous stack unwinds
   * (via queueMicrotask) to break the synchronous chain from
   * TOOL_EXECUTION_END -> fireExpired -> fireTimer ->
   * sendTrackedMessage(triggerTurn:true) -> pi.sendMessage -> synchronous
   * agent turn -> tool dispatch -> TOOL_EXECUTION_END -> ...
   *
   * Without this guard, a timer that fires during TOOL_EXECUTION_END can
   * re-enter the tool dispatch loop and overflow the V8 stack. The poll()
   * method (setInterval callback) already has this guard; fireExpired()
   * was missed in the previous fix round (2026-06-29).
   *
   * The one-tick delay is acceptable: the timer already expired, and the
   * deferred fire will be caught on the next tick. The return value is
   * returned immediately (before the deferred fires) so callers can still
   * inspect which timers are about to fire.
   */
  fireExpired(): ScheduledTimer[] {
    if (!this.piRef) return [];
    const expired = this.onCheckExpired(this.sessionId, Date.now());
    const pi = this.piRef;
    for (const timer of expired) {
      // Defer fire to after the current synchronous stack unwinds to break
      // the synchronous chain from TOOL_EXECUTION_END / TURN_END into
      // pi-core's sendMessage -> synchronous agent turn -> tool dispatch.
      // Same pattern as poll().
      queueMicrotask(() => {
        this.onFire(timer, pi);
      });
    }
    return expired;
  }
}
