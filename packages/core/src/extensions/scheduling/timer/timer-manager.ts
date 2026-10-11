/**
 * Timer Manager - per-session timer store and CRUD operations.
 *
 * Manages scheduled timers keyed by sessionId. Each session has its own
 * inner map, so cross-session operations are impossible. The outer map
 * is a module-level singleton — this is the global registry.
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
    intervalMs?: number,
    count?: number,
    firedCount?: number,
  ): string {
    const id = nextId("timer");
    const firesAt = Date.now() + delayMs;
    const recurring = !!(intervalMs && intervalMs > 0);

    let sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) {
      sessionTimers = new Map();
      this.timersBySession.set(sessionId, sessionTimers);
    }
    sessionTimers.set(id, {
      id,
      firesAt,
      reason,
      tag,
      createdAt: Date.now(),
      wake,
      sessionId,
      ...(recurring
        ? {
            intervalMs,
            fires: firedCount ?? 0,
            ...(count !== undefined ? { count } : {}),
          }
        : {}),
    });
    const repeatTail = recurring
      ? ` every ${Math.round(intervalMs / 1000)}s${count !== undefined ? ` x${count}` : " (until cancelled)"}`
      : "";
    log.info(
      `[timer] set: ${id} session=${sessionId} fires in ${Math.round(delayMs / 1000)}s - ${reason}${wake ? " (wake)" : " (silent)"}${repeatTail}`,
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
        if (timer.intervalMs && timer.intervalMs > 0) {
          // Recurring timer: keep it in the session map and re-arm to the
          // next cadence. Math.max(prev + interval, now + interval) means a
          // timer that is many intervals overdue (poll gap, busy guard,
          // compaction, process sleep) fires ONE tick and re-arms from
          // "now + interval" — never a catch-up burst of N missed ticks.
          // The re-arm is done synchronously/in-place on the live map entry,
          // so any second checkExpired() call in the same tick sees the
          // future firesAt and cannot double-fire or double-advance.
          const fires = (timer.fires ?? 0) + 1;
          // The delivered snapshot carries the fire number for THIS delivery
          // and keeps the ORIGINAL firesAt (the fire time — used for
          // elapsed-time metadata).
          const snapshot = { ...timer, fires };
          if (timer.count !== undefined && fires >= timer.count) {
            // Count exhausted (bounded recurrence): like a one-shot,
            // delete-on-detection removes it permanently. The fire path
            // removes the disk entry too, so it cannot resurrect on reload.
            sessionTimers.delete(id);
            log.info(
              `[timer] fired + completed: ${id} (session=${sessionId}) - ${timer.reason} (${fires}/${timer.count})`,
            );
          } else {
            timer.fires = fires;
            timer.firesAt = Math.max(timer.firesAt + timer.intervalMs, nowMs + timer.intervalMs);
            log.info(
              `[timer] fired + re-armed: ${id} (session=${sessionId}) - ${timer.reason} (${fires}/${timer.count ?? "∞"}) next in ${Math.round(timer.intervalMs / 1000)}s`,
            );
          }
          expired.push(snapshot);
        } else {
          // One-shot (default): delete-on-detection keeps exactly-once
          // semantics — no poll tick can return the same timer twice.
          const snapshot = { ...timer };
          sessionTimers.delete(id);
          log.info(`[timer] fired: ${id} (session=${sessionId}) - ${timer.reason}`);
          expired.push(snapshot);
        }
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
