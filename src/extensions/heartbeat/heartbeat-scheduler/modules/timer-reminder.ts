/**
 * Timer Reminder Module — bridges timer fires from timer extension → agent reminders.
 *
 * Drains timer reminders from the timer bus on each tick and surfaces them as whispers.
 */

import type { CognitiveModule } from "../types.js";
import { createLogger } from "../../../../lib/logger.js";

const log = createLogger("heartbeat:timer-reminder");

export const timerReminderModule: CognitiveModule = {
  name: "timer-reminder",
  description: "Surface pending timer reminders to the agent",
  priority: 90,

  shouldActivate(): boolean {
    return true;
  },

  async activate(context): Promise<void> {
    try {
      const { drainTimerReminders } = await import("../../../../lib/timer-bus.js");
      const reminders = drainTimerReminders();
      for (const { timer } of reminders) {
        context.ctx.whisper?.(
          `[timer] ${timer.reason}\n` +
            `Timer ID: ${timer.id}` +
            (timer.tag ? ` (tag: ${timer.tag})` : "") +
            `\nFired at: ${new Date(timer.firesAt).toLocaleTimeString()}`,
          { category: "cognitive", priority: "medium" },
        );
      }
    } catch {
      // Timer bus not loaded — silent ignore
    }
  },
};
