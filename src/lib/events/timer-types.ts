/**
 * Timer Types — shared type definitions for the timer event system.
 *
 * Extracted from extensions/tools/timer/index.ts so that lib/events/timer-bus.ts
 * can import types without creating a lib→ext dependency.
 */

export interface ScheduledTimer {
  id: string;
  firesAt: number; // Unix timestamp (ms)
  reason: string;
  tag?: string;
  createdAt: number;
}