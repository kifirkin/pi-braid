/**
 * Timer Reminder Bus - bridges timer fires to heartbeat surface to agent
 *
 * Timer extension emits fires → heartbeat scheduler surfaces reminders.
 * This is a module-level singleton so extensions can communicate
 * without direct imports (separate extension loading contexts).
 */

import type { ScheduledTimer } from "./timer-types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("timer-bus");

export interface TimerReminder {
  timer: ScheduledTimer;
  firedAt: number;
}

type ReminderHandler = (reminder: TimerReminder) => void;

const handlers: Set<ReminderHandler> = new Set();
let pendingReminders: TimerReminder[] = [];

/** Timer extension calls this when a timer fires */
export function emitTimerReminder(timer: ScheduledTimer): void {
  const reminder: TimerReminder = { timer, firedAt: Date.now() };
  pendingReminders.push(reminder);
  for (const h of handlers) {
    try {
      h(reminder);
    } catch (err) {
      log.warn(`Timer reminder handler failed: ${err}`);
    }
  }
}

/** Heartbeat scheduler calls this on each turn to get pending reminders */
export function drainTimerReminders(): TimerReminder[] {
  const drained = pendingReminders;
  pendingReminders = [];
  return drained;
}

/** Heartbeat registers a handler for immediate reminder surfacing */
export function onTimerReminder(handler: ReminderHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
