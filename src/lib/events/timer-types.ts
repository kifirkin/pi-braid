/**
 * Timer Types - shared type definitions for the timer event system.
 *
 * Extracted from extensions/tools/timer/index.ts so that lib/events/timer-bus.ts
 * can import types without creating a lib->ext dependency.
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
   * Owning session ID. Each pi session has its own timer bucket. The
   * timer module uses this to scope cancel/list operations to one
   * session, preventing cross-session timer leaks when multiple pi
   * sessions run in the same Node process.
   */
  sessionId?: string;
}
