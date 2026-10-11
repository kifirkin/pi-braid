/**
 * Persisted-timer recovery — owning-session scoped.
 *
 * Lives here, in the timer module, because the invariant is the timer
 * store's, not any caller's: the per-project store
 * (pending-timers.jsonl, getTimerFilePath(cwd)) is SHARED by every session
 * that runs in that project CWD — two panes each keep their own timers in
 * this one file. Recovery sweeps the store at turn start; only records
 * whose sessionId matches the current session may be delivered, re-armed,
 * or restored into this process. A record from any other session must stay
 * inert here: no whisper, no wake, no re-arm, no in-memory restoration
 * (the predecessor session keeps servicing its own cadence with its own
 * poller — a fresh session must never inherit its fires).
 *
 * Foreign-record pruning policy (why, and what it still admits):
 *
 *   A foreign record is pruned from the store only when BOTH signals agree
 *   the owner is gone:
 *
 *   1. Overdue beyond FOREIGN_TIMER_PRUNE_OVERDUE_MS. A LIVE owner's poller
 *      services its own overdue timers within ~1s (the busy guard defers
 *      firing only for the duration of one tool call, far below the grace),
 *      and the fire path re-arms or removes the disk entry when it does.
 *      A record that sits overdue far past that grace is not being
 *      serviced by anyone.
 *   2. The owner shows no session-store activity within
 *      FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS (pi-core's session files
 *      under ~/.pi/agent/sessions; missing file or stale mtime). The wide
 *      window keeps a live sibling that is mid-long-tool (fresh store
 *      writes stopped at tool start, timer overdue meanwhile) safely on the
 *      keep side.
 *
 *   Unexpired foreign records are never touched: the owner may still be
 *   coming back to service them. Admitted failure mode: a foreign session
 *   whose process is paused (laptop asleep, SIGSTOP, hung) past BOTH
 *   windows loses its pending timer — it is indistinguishable from a dead
 *   session by store evidence alone. The next pruning sweep after the
 *   pause would remove a record the paused session would have fired on
 *   resume. A session file that cannot be located (never persisted,
 *   ephemeral mode, layout change) counts as "no evidence of life", so the
 *   same two windows decide.
 *
 * Legacy persisted shape: records without intervalMs are one-shots; every
 * path here treats a missing/zero intervalMs as one-shot.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getTimerFilePath, braidDir, AGENT } from "../../../lib/config/braid-paths.js";
import { writeTimerStore } from "./store-file.js";
import { restoreTimer, timerManager } from "./index.js";
import { wakeRetryQueue } from "./wake-retry.js";
import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("timer-recovery");

/** Collapse stacked persisted timers before recovery. For each (sessionId,
 * tag) group of TAGGED timers, keep only the newest entry (max createdAt,
 * tiebreak max firesAt) and drop the rest. Untagged timers are distinct
 * one-shots and are never deduped.
 *
 * Timer stacking: pending-timers.jsonl accumulated 5
 * periodic-status timers across 3 sessions, and a single session carried
 * BOTH the original (fires:0, expired) and the re-armed copy (fires:20, live)
 * of the same logical timer — recovery re-armed every copy, so the original
 * AND the re-armed copy both fired. Deduping by tag collapses the stack to
 * the newest entry per (session, tag) before any fire/re-arm happens.
 */
export function dedupPersistedTimers(timers: any[]): any[] {
  const newestByKey = new Map<string, any>();
  const dropIds = new Set<string>();
  for (const t of timers) {
    if (typeof t.tag !== "string" || t.tag.length === 0) continue;
    const key = `${t.sessionId ?? ""}\u0000${t.tag}`;
    const existing = newestByKey.get(key);
    if (!existing) {
      newestByKey.set(key, t);
      continue;
    }
    const keep =
      (t.createdAt ?? 0) > (existing.createdAt ?? 0) ||
      ((t.createdAt ?? 0) === (existing.createdAt ?? 0) &&
        (t.firesAt ?? 0) > (existing.firesAt ?? 0));
    if (keep) {
      dropIds.add(existing.id);
      newestByKey.set(key, t);
    } else {
      dropIds.add(t.id);
    }
  }
  if (dropIds.size === 0) return timers;
  const deduped = timers.filter((t) => !dropIds.has(t.id));
  log.info(
    `[timer] recovery: deduped ${timers.length - deduped.length} stacked persisted timer(s) by tag`,
  );
  return deduped;
}

/** True when the timer manager already holds a live equivalent of a persisted
 * timer: same sessionId + tag (tagged timers are one-per-tag singletons), or
 * same id for untagged timers (which are distinct per instance). When live,
 * the poller owns firing and the fire path owns the disk entry (rearm/remove)
 * — re-arming here would create a duplicate that ALSO fires. */
export function hasLiveEquivalent(t: any): boolean {
  const live = timerManager.listTimers(t.sessionId ?? "");
  if (typeof t.tag === "string" && t.tag.length > 0) {
    return live.some((x) => x.tag === t.tag);
  }
  return live.some((x) => x.id === t.id);
}

/** A foreign record must sit overdue longer than this before pruning is even
 *  considered: the owning process gets this long to service the fire itself
 *  (its poller re-arms/removes the disk entry when it does). Must comfortably
 *  exceed a busy sibling's longest tool call. */
export const FOREIGN_TIMER_PRUNE_OVERDUE_MS = 30 * 60_000;

/** The owning session must be silent in pi-core's session store at least this
 *  long before an overdue-beyond-grace foreign record may be pruned. Wide by
 *  design: a live sibling mid-long-tool writes nothing to the session store
 *  while its overdue fire waits. */
export const FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS = 24 * 60 * 60_000;

// Sessions dir indirection for tests only (no module-level let — the
// factoryState/sessionState object pattern): null = real sessions store.
const sessionsDirState: { override: string | null } = { override: null };

/** Test hook: pin the sessions store root for owner-liveness lookups.
 *  null restores the real store (AGENT/sessions). */
export function _setSessionsDirForTests(dir: string | null): void {
  sessionsDirState.override = dir;
}

/**
 * Last-activity evidence for one session id: the mtime of its session file
 * in pi-core's store (files are named "..._<sessionId>.jsonl"), or null when
 * no file can be found. Two-level readdir only — sessions/<project>/*.jsonl;
 * a deeper future layout reads as "no evidence of life" (see the pruning
 * policy's admitted failure mode). Called only for foreign records overdue
 * beyond the servicing grace, never on the hot path.
 */
function sessionStoreMtime(sessionId: unknown): number | null {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const dir = sessionsDirState.override ?? join(AGENT, "sessions");
  let projects;
  try {
    projects = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const projectDir = join(dir, p.name);
    let files;
    try {
      files = readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl") || !f.includes(sessionId)) continue;
      try {
        return statSync(join(projectDir, f)).mtimeMs;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Keep-or-prune verdict for a FOREIGN persisted record (never called for
 *  records owned by the current session). See the module header for the
 *  policy and its admitted failure mode. */
function foreignRecordVerdict(t: any, now: number): "keep" | "prune" {
  // Unexpired: the owner may still service it on return — never touch.
  if (!(t.firesAt <= now)) return "keep";
  if (now - t.firesAt <= FOREIGN_TIMER_PRUNE_OVERDUE_MS) return "keep";
  const mtime = sessionStoreMtime(t.sessionId);
  if (mtime !== null && now - mtime <= FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS) return "keep";
  return "prune";
}

/**
 * Retention sweep: bound the growth of EVERY per-project timer store under
 * braidDir()/projects, including stores whose project no session ever runs
 * in again. The per-turn sweep (recoverPersistedTimers) prunes foreign
 * zombies only in the CURRENT project — a dormant store (e.g. a test cwd)
 * accumulated fixture records for ever because no sweep ever runs there.
 *
 * The cap reuses the foreign-zombie policy's two signals, so "conservative"
 * means "the same bar the store already applies, applied globally": a record
 * is dropped only when it is overdue beyond FOREIGN_TIMER_PRUNE_OVERDUE_MS
 * (30 min — a live owner's poller services its own fires within ~1s, so 30
 * minutes means nobody is servicing it) AND its owner shows no session-store
 * life within FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS (24 h) or has no
 * session file at all. That bounds the population to records of dead-or-never-
 * persisted sessions; live owners (fresh or recent store activity) and any
 * unexpired record always survive.
 *
 * Never touched: the current session's own records (their owner file may not
 * exist yet before the first persisted message, or be stale after a long
 * sleep — recovery depends on them), unparsable lines (kept verbatim —
 * never drop what cannot be classified), and non-number firesAt (reads as
 * unexpired). Runs once per session_start, not per turn: dormant stores get
 * serviced without adding cost to the hot turn path. Rewrites a store
 * line-verbatim (no re-serialization of foreign records); a store pruned to
 * nothing is removed, its directory with it. Non-fatal on any
 * per-file error.
 */
export function sweepProjectStoresRetention(currentSessionId?: string): void {
  try {
    const projectsDir = join(braidDir(), "projects");
    let projectDirs;
    try {
      projectDirs = readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return; // no projects dir (fresh braid home) — nothing to sweep
    }
    const now = Date.now();
    for (const p of projectDirs) {
      if (!p.isDirectory()) continue;
      const storeFile = join(projectsDir, p.name, "pending-timers.jsonl");
      let raw: string;
      try {
        raw = readFileSync(storeFile, "utf-8");
      } catch {
        continue; // no store in this project
      }
      const lines = raw.split("\n").filter((l) => l.length > 0);
      const kept: string[] = [];
      let dropped = 0;
      for (const line of lines) {
        let record: any;
        try {
          record = JSON.parse(line);
        } catch {
          kept.push(line);
          continue;
        }
        if (currentSessionId !== undefined && record?.sessionId === currentSessionId) {
          kept.push(line);
          continue;
        }
        if (foreignRecordVerdict(record, now) === "prune") {
          dropped++;
          continue;
        }
        kept.push(line);
      }
      if (dropped === 0) continue;
      // A pruned-to-nothing store is removed, not rewritten empty: the
      // emptied file would leave its directory behind for ever.
      writeTimerStore(storeFile, kept);
      log.info(
        `[timer] retention: dropped ${dropped} unserviceable timer record(s) from ${p.name}`,
      );
    }
  } catch {
    /* non-fatal: retention must never break session start */
  }
}

/**
 * Recover persisted timers that expired during a process gap (e.g. /reload).
 * Reads PENDING_TIMERS_FILE; expired ones are PARKED for post-settle delivery
 * (deferRecoveredFire — never fired inline in before_agent_start, the
 * competing-turn window) and the file is rewritten with only the unexpired
 * timers remaining (removed once nothing remains). FlushRecoveredFires() (timer extension agent_settled
 * handler + fallback listener) delivers the parked fires.
 * Called once per before_agent_start (every turn) but cheap: empty file = no-op.
 *
 * ── OWNING-SESSION SCOPING ──────────────────────────────────────────────
 * `currentSessionId` (the caller's ctx.sessionManager.getSessionId()) makes
 * the sweep owner-scoped: records with a different sessionId are never
 * delivered, re-armed, or restored into this process — they are kept on
 * disk verbatim unless the pruning policy proves the owner gone. The
 * per-project store is shared by sibling sessions; the shared invariant
 * lives here (in the timer module), not in any caller.
 *
 * Legacy contract: called WITHOUT a session id (the direct test surface,
 * where no session manager exists), the sweep runs unscoped over every
 * record — the pre-scoping behavior. Production callers MUST pass the id;
 * an unresolvable one (getSessionIdSafe's "?" sentinel) scopes to nothing,
 * which is the safe direction: every record goes inert here.
 *
 * Hardening (stacking/double-fire):
 *   - dedupPersistedTimers collapses stacked copies of the same logical
 *     (session, tag) timer before processing, so a stale expired duplicate
 *     is dropped instead of fired alongside the live re-armed copy.
 *     Scoped mode dedups ONLY the owning session's records — a foreign
 *     record is never rewritten by another session's recovery.
 *   - hasLiveEquivalent skips fire/re-arm for a timer the poller already
 *     owns — recovery runs every turn, and re-arming a still-live timer
 *     created a duplicate (original + re-armed copy both fire).
 * Expired fires defer to the agent_settled flush (never inline in
 *   before_agent_start, the competing-turn window) — a
 *   wake:true fire starts its own turn and failed deliveries retry with
 *   bounded backoff (wake-retry.ts).
 */
export function recoverPersistedTimers(_pi: ExtensionAPI, currentSessionId?: string): void {
  try {
    const timerFile = getTimerFilePath(process.cwd());
    if (!existsSync(timerFile)) return;
    const raw = readFileSync(timerFile, "utf-8").trim();
    if (!raw) return;
    const all = raw.split("\n").map((l) => JSON.parse(l));
    let timers: any[];
    if (currentSessionId === undefined) {
      // Legacy unscoped sweep: the owning session is unknown (direct test
      // surface). Production always passes the id — that path never lands
      // here.
      timers = dedupPersistedTimers(all);
    } else {
      // Dedup only the owning session's records; foreign records pass
      // through verbatim (this process must not rewrite another session's
      // entries).
      timers = [
        ...dedupPersistedTimers(all.filter((t) => t.sessionId === currentSessionId)),
        ...all.filter((t) => t.sessionId !== currentSessionId),
      ];
    }
    const now = Date.now();
    const remaining: unknown[] = [];
    let fired = 0;
    let restored = 0;
    let foreignKept = 0;
    let foreignPruned = 0;
    for (const t of timers) {
      // Foreign records: inert in this process.
      // A record whose sessionId differs from the current session belongs
      // to another session sharing this project store. Never delivered,
      // never re-armed, never restored into memory — the poller below only
      // ever fires the current session's bucket. Kept on disk unless the
      // pruning policy (module header) proves the owner gone.
      if (currentSessionId !== undefined && t.sessionId !== currentSessionId) {
        if (foreignRecordVerdict(t, now) === "keep") {
          remaining.push(t);
          foreignKept++;
        } else {
          foreignPruned++;
          log.info(
            `[timer] recovery: pruned foreign timer ${t.id} (session=${t.sessionId ?? "none"}, ` +
              `overdue ${Math.round((now - t.firesAt) / 60000)}m, owner inactive in session store)`,
          );
        }
        continue;
      }
      // A live equivalent already exists in the timer manager (same session
      // + tag, or same id for untagged): the poller owns it. Skip — re-arming
      // would create a duplicate that ALSO fires (original +
      // re-armed copy both fire). The live timer's fire path owns the disk
      // entry (rearm/remove), so keep the entry as-is.
      if (hasLiveEquivalent(t)) {
        remaining.push(t);
        continue;
      }
      const isRecurring = typeof t.intervalMs === "number" && t.intervalMs > 0;
      if (t.firesAt <= now) {
        // Do NOT deliver inline. This runs inside `before_agent_start`,
        // where a turn is already starting: a triggerTurn here races the
        // pre-flight (pi-core activeRun guard — the competing-turn bug), and
        // a steer here dies with the run if the pre-flight aborts (provider
        // 401: no agent loop, no event). Park the fire; the timer
        // extension's agent_settled handler (plus the fallback listener
        // registered below) flushes it POST-SETTLE via flushRecoveredFires()
        // — where a wake:true fire safely starts its own turn and feeds the
        // failed-wake retry queue. The [braid-whisper - timer] envelope stays
        // canonical; no inline sub-tag.
        try {
          wakeRetryQueue.deferRecoveredFire({
            id: t.id,
            sessionId: t.sessionId,
            reason: t.reason,
            tag: t.tag,
            createdAt: t.createdAt,
            firesAt: t.firesAt,
            wake: t.wake === true,
          });
          fired++;
          if (isRecurring) {
            // Recurring timer that expired during the process gap: fire the
            // overdue tick but DON'T drop the recurrence — re-arm with the
            // next cadence (same max() anti-catch-up formula as the live
            // expiry path) so it keeps recurring after the reload. The fires
            // counter advances too; a bounded recurrence whose count is now
            // exhausted is DONE and is dropped (not re-armed, not kept on
            // disk) so it cannot resurrect.
            const fires = (typeof t.fires === "number" ? t.fires : 0) + 1;
            if (t.count === undefined || fires < t.count) {
              const nextFiresAt = Math.max(t.firesAt + t.intervalMs, now + t.intervalMs);
              const newId = restoreTimer(
                t.sessionId,
                nextFiresAt - now,
                t.reason,
                t.tag,
                t.wake === true,
                t.intervalMs,
                t.count,
                fires,
              );
              remaining.push({
                ...t,
                id: newId,
                firesAt: nextFiresAt,
                intervalMs: t.intervalMs,
                count: t.count,
                fires,
              });
              restored++;
            }
          }
        } catch {
          remaining.push(t);
        }
      } else {
        // Re-arm unexpired timers into memory so the poller fires them on schedule.
        // restoreTimer() returns a new id; rewrite the disk entry with it.
        // intervalMs + count + fires are threaded through so a persisted
        // recurring timer keeps recurring after the reload (not just the next
        // single fire), and a bounded recurrence resumes mid-cadence.
        try {
          const newId = restoreTimer(
            t.sessionId,
            t.firesAt - now,
            t.reason,
            t.tag,
            t.wake === true,
            t.intervalMs,
            t.count,
            t.fires,
          );
          remaining.push({ ...t, id: newId });
          restored++;
        } catch {
          remaining.push(t);
        }
      }
    }
    writeTimerStore(
      timerFile,
      remaining.map((t) => JSON.stringify(t)),
    );
    if (fired > 0)
      log.info(`[timer] deferred ${fired} recovered persisted timer(s) to post-settle flush`);
    if (restored > 0) log.info(`[timer] re-armed ${restored} unexpired persisted timer(s)`);
    if (foreignKept > 0)
      log.info(
        `[timer] recovery: ${foreignKept} foreign-session timer(s) left inert ` +
          `(not owned by session ${currentSessionId})`,
      );
    if (foreignPruned > 0)
      log.info(
        `[timer] recovery: pruned ${foreignPruned} foreign-session timer(s) ` +
          `(overdue beyond ${Math.round(FOREIGN_TIMER_PRUNE_OVERDUE_MS / 60000)}m, ` +
          `owner inactive ${Math.round(FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS / 3600000)}h)`,
      );
  } catch {
    /* non-fatal */
  }
}
