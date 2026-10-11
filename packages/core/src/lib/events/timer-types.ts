/**
 * Timer Types - shared type definitions for the timer event system.
 *
 * Lives in lib/ so lib/events/timer-bus.ts can import the types without
 * creating a lib->extensions dependency.
 */

export interface ScheduledTimer {
  id: string;
  firesAt: number; // Unix timestamp (ms)
  reason: string;
  tag?: string;
  createdAt: number;
  /**
   * If true, the timer fire whisper uses triggerTurn: true to wake the
   * agent (auto-resume behavior). Used by the post-compaction resume
   * timer to recover from a stuck session. Default: false (safer).
   *
   * The busy guard (TOOL_CALL -> busy=true, TURN_END -> busy=false)
   * still prevents mid-tool-execution firing even when wake: true.
   */
  wake?: boolean;
  /**
   * Recurrence interval in milliseconds. When set, the timer is NOT
   * removed on fire: the expiry path re-arms `firesAt` to the next
   * cadence (`Math.max(prev firesAt + intervalMs, now + intervalMs)`)
   * instead of deleting it, and the fire path persists the re-arm so
   * the recurrence survives a reload. Undefined (default) = one-shot
   * timer.
   */
  intervalMs?: number;
  /**
   * Optional bound on a recurring timer's LIFETIME: the total number of
   * fires it will deliver before removing itself (count exhaustion).
   * When set on a recurring timer, the timer self-removes after its
   * `count`-th fire instead of re-arming — the native answer to a finite
   * baby-sit window ("check every 60s, 5 times, then stop").
   *
   * Undefined (default) = unbounded recurrence: re-fires on cadence
   * until cancelled (behavior unchanged). A recurring timer
   * with `count` still stops early on cancelTimer/cancelTimersByTag.
   * Ignored when `intervalMs` is unset (one-shot timers fire once by
   * definition).
   */
  count?: number;
  /**
   * How many times this (recurring) timer has fired so far. Starts at 0
   * on creation; incremented on every fire. The DELIVERED snapshot on a
   * fire carries the fire number for that delivery (so `list` can show
   * e.g. "repeat 3/5"); the LIVE map entry carries the running count
   * only while it survives (i.e. it is cleared the moment the timer is
   * removed on exhaustion/cancel). Persisted so a bounded recurrence
   * resumes mid-cadence after a reload. Undefined = never fired (fresh
   * or legacy one-shot).
   */
  fires?: number;
  /**
   * Owning session ID. Each pi session has its own timer bucket. The
   * timer module uses this to scope cancel/list operations to one
   * session, preventing cross-session timer leaks when multiple pi
   * sessions run in the same Node process.
   */
  sessionId?: string;
}
