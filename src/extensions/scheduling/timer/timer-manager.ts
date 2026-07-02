/**
 * Timer Manager - per-session timer store and CRUD operations.
 *
 * Manages scheduled timers keyed by sessionId. Each session has its own
 * inner map, so cross-session operations are impossible. The outer map
 * is a module-level singleton — this is the global registry.
 *
 * Extracted from index.ts (P2-10/Q13 split).
 */

import { nextId } from "../../../lib/utils/id.js";
import { createLogger } from "../../../lib/core/logger.js";
import type { ScheduledTimer } from "../../../lib/events/timer-types.js";

const log = createLogger("timer-manager");

export class TimerManager {
  private timersBySession: Map<string, Map<string, ScheduledTimer>> = new Map();

  setTimer(
    sessionId: string,
    delayMs: number,
    reason: string,
    tag?: string,
    wake: boolean = true,
  ): string {
    const id = nextId('timer');
    const firesAt = Date.now() + delayMs;

    let sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) {
      sessionTimers = new Map();
      this.timersBySession.set(sessionId, sessionTimers);
    }
    sessionTimers.set(id, { id, firesAt, reason, tag, createdAt: Date.now(), wake, sessionId });
    log.info(
      `[timer] set: ${id} session=${sessionId} fires in ${Math.round(delayMs / 1000)}s - ${reason}${wake ? " (wake)" : " (silent)"}`,
    );
    return id;
  }

  cancelTimer(sessionId: string, id: string): boolean {
    const sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) return false;
    const deleted = sessionTimers.delete(id);
    if (deleted) log.info(`[timer] cancelled: ${id} (session=${sessionId})`);
    return deleted;
  }

  clearSession(sessionId: string): number {
    const sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) return 0;
    const n = sessionTimers.size;
    this.timersBySession.delete(sessionId);
    if (n > 0) log.info(`[timer] cleared session ${sessionId}: ${n} timer(s)`);
    return n;
  }

  listTimers(sessionId: string): ScheduledTimer[] {
    const sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) return [];
    return Array.from(sessionTimers.values()).sort((a, b) => a.firesAt - b.firesAt);
  }

  checkExpired(sessionId: string, nowMs: number): ScheduledTimer[] {
    const sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) return [];
    const expired: ScheduledTimer[] = [];
    for (const [id, timer] of sessionTimers) {
      if (timer.firesAt <= nowMs) {
        expired.push(timer);
        sessionTimers.delete(id);
        log.info(`[timer] fired: ${id} (session=${sessionId}) - ${timer.reason}`);
      }
    }
    return expired;
  }

  cancelTimersByTag(sessionId: string, tag: string): number {
    const sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) return 0;
    let cancelled = 0;
    for (const [id, t] of sessionTimers) {
      if (t.tag === tag) {
        sessionTimers.delete(id);
        cancelled++;
      }
    }
    if (cancelled > 0) {
      log.info(`[timer] cancelled ${cancelled} timer(s) with tag="${tag}" (session=${sessionId})`);
    }
    return cancelled;
  }

  getActiveCount(sessionId: string): number {
    return this.timersBySession.get(sessionId)?.size ?? 0;
  }

  getTotalCount(): number {
    let n = 0;
    for (const s of this.timersBySession.values()) n += s.size;
    return n;
  }
}

export const timerManager = new TimerManager();