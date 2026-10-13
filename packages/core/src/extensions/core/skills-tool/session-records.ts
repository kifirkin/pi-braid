/**
 * Durable per-session skill-adoption records + monthly adoption rollup.
 *
 * Every session that reaches an agent turn gets ONE logical record:
 *   { sessionId, role, month, hadSkillLoad, updatedAt }
 * `role` carries the session's profile name from the braid config (see
 * lib/config/session-profiles.ts), or the neutral default when no profile
 * matches; `month` is the local-time "YYYY-MM" of the write, and
 * `hadSkillLoad` is true only after a DETECTED SKILL.md read — a verbal
 * load claim does not count, matching the `actual` counter and
 * sessionHasSkillLoad semantics in auto-inject.
 *
 * Store: append-only JSONL (getSkillsSessionsFilePath()). Writers only
 * append whole lines — there is no read-modify-write — so sessions running
 * concurrently in separate processes cannot lose each other's records.
 * The upsert (one logical record per sessionId) happens at read time:
 * records fold in file order, and for the same sessionId the latest role
 * and month win while `hadSkillLoad` ORs across all occurrences (a
 * session that starts in one month and loads a skill in the next is
 * counted once, in the month of the load). Residual race: simultaneous
 * appends from two processes can theoretically tear a line on some
 * filesystems; the tolerant reader skips unparseable lines, the window is
 * a single small write, and this is accepted as best-effort telemetry.
 *
 * Back-compat: records written before profiles existed carry a role from
 * the retired fixed set; those values pass the profile-name gate
 * unchanged, so older buckets keep folding under their original names.
 * Records whose role does not pass the gate (missing, non-string, empty,
 * malformed) fold to the neutral default.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { getSkillsSessionsFilePath } from "../../../lib/config/braid-paths.js";
import {
  NEUTRAL_SESSION_PROFILE,
  normalizeProfileName,
  resolveSessionProfileForCwd,
  type ResolvedSessionProfile,
} from "../../../lib/config/session-profiles.js";

const log = createLogger("skills-tool");

/** One durable per-session adoption record (a single JSONL line on disk). */
export interface SkillSessionRecord {
  /** pi session id (from ctx.sessionManager.getSessionId()). */
  sessionId: string;
  /**
   * Session profile name resolved from the braid config, or the neutral
   * default; the monthly rollup excludes the neutral bucket.
   */
  role: string;
  /** Local-time calendar month of this write, "YYYY-MM". */
  month: string;
  /** True only after a DETECTED SKILL.md read in this session. */
  hadSkillLoad: boolean;
  /** ISO timestamp of this write. */
  updatedAt: string;
}

/** Local-time calendar month of a date, "YYYY-MM". */
export function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

// Store I/O (append-only JSONL)

/** Normalize one raw JSONL entry; undefined when the entry is not usable. */
function normalizeRecord(raw: unknown): SkillSessionRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || !r.sessionId) return undefined;
  if (typeof r.month !== "string" || !/^\d{4}-\d{2}$/.test(r.month)) return undefined;
  const role = normalizeProfileName(r.role) ?? NEUTRAL_SESSION_PROFILE;
  return {
    sessionId: r.sessionId,
    role,
    month: r.month,
    hadSkillLoad: r.hadSkillLoad === true,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
  };
}

/**
 * Fold raw records into one logical record per sessionId (the upsert
 * semantics): the latest role and month win, `hadSkillLoad` ORs across
 * all occurrences, `updatedAt` keeps the newest timestamp. Pure.
 */
export function foldSessionRecords(records: SkillSessionRecord[]): SkillSessionRecord[] {
  const byId = new Map<string, SkillSessionRecord>();
  for (const rec of records) {
    const prev = byId.get(rec.sessionId);
    byId.set(
      rec.sessionId,
      prev
        ? {
            sessionId: rec.sessionId,
            role: rec.role,
            month: rec.month,
            hadSkillLoad: prev.hadSkillLoad || rec.hadSkillLoad,
            updatedAt: prev.updatedAt > rec.updatedAt ? prev.updatedAt : rec.updatedAt,
          }
        : rec,
    );
  }
  return [...byId.values()];
}

/**
 * Read + fold the store. Missing or unreadable file → empty (never
 * throws); corrupt lines are skipped.
 */
export function readSessionRecords(storePath: string): SkillSessionRecord[] {
  let text: string;
  try {
    text = readFileSync(storePath, "utf-8");
  } catch {
    return []; // missing or unreadable → no records
  }
  const out: SkillSessionRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = normalizeRecord(JSON.parse(trimmed));
      if (rec) out.push(rec);
    } catch {
      // torn or corrupt line — skip
    }
  }
  return out;
}

/**
 * Append one record. Best-effort: every error is swallowed (this runs on
 * the agent-loop and tool-result paths — a telemetry failure must never
 * break a turn). Returns true when the line landed on disk.
 */
export function appendSessionRecord(record: SkillSessionRecord, storePath: string): boolean {
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    appendFileSync(storePath, `${JSON.stringify(record)}\n`, "utf-8");
    return true;
  } catch (err) {
    reportRecordFailure(err);
    return false;
  }
}

/** Warned once per process about a refused adoption-record append. */
let _warnedRecordFailure = false;

function reportRecordFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (_warnedRecordFailure) {
    log.debug(`session adoption record write failed (best-effort): ${message}`);
    return;
  }
  _warnedRecordFailure = true;
  log.warn(`session adoption record write failed (best-effort): ${message}`);
}

interface SessionRecordState {
  /** Set once the session's start record has been written. */
  startRecorded: boolean;
  /** Session-scoped profile resolution — the config is read once per session. */
  profile?: ResolvedSessionProfile;
}

const RECORDS_STATE_KEY = "skills-session-records";

/** Extract (sessionId, cwd) from a real extension context; undefined otherwise. */
function resolveSession(ctx: ExtensionContext): { sessionId: string; cwd?: string } | undefined {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    return sessionId ? { sessionId, cwd: ctx.cwd } : undefined;
  } catch {
    return undefined; // fake/partial ctx (tests) or session not ready
  }
}

/**
 * The session's effective profile, resolved from the braid config on first
 * use and cached with the records state, so telemetry and the hint path
 * always agree on one name for one session.
 */
export function getSessionProfile(ctx: ExtensionContext): ResolvedSessionProfile {
  const state = getExtensionState(
    ctx,
    RECORDS_STATE_KEY,
    (): SessionRecordState => ({ startRecorded: false }),
  );
  if (!state.profile) state.profile = resolveSessionProfileForCwd(ctx.cwd);
  return state.profile;
}

/**
 * Write the session's start record (hadSkillLoad=false) exactly once per
 * session — the denominator of the adoption rate. Later writes for the
 * same session only ever flip the flag upward (see fold semantics).
 */
export function recordSessionStart(ctx: ExtensionContext, storePath?: string): void {
  try {
    const sess = resolveSession(ctx);
    if (!sess) return;
    const state = getExtensionState(
      ctx,
      RECORDS_STATE_KEY,
      (): SessionRecordState => ({
        startRecorded: false,
      }),
    );
    if (state.startRecorded) return;
    const ok = appendSessionRecord(
      {
        sessionId: sess.sessionId,
        role: getSessionProfile(ctx).name,
        month: monthOf(new Date()),
        hadSkillLoad: false,
        updatedAt: new Date().toISOString(),
      },
      storePath ?? getSkillsSessionsFilePath(),
    );
    if (ok) state.startRecorded = true;
  } catch (err) {
    reportRecordFailure(err);
  }
}

/**
 * Append a hadSkillLoad=true record after a DETECTED SKILL.md read (the
 * numerator of the adoption rate). Claims must NOT route here.
 */
export function recordSessionSkillLoad(ctx: ExtensionContext, storePath?: string): void {
  try {
    const sess = resolveSession(ctx);
    if (!sess) return;
    appendSessionRecord(
      {
        sessionId: sess.sessionId,
        role: getSessionProfile(ctx).name,
        month: monthOf(new Date()),
        hadSkillLoad: true,
        updatedAt: new Date().toISOString(),
      },
      storePath ?? getSkillsSessionsFilePath(),
    );
  } catch (err) {
    reportRecordFailure(err);
  }
}

/** Adoption numbers for one profile in one month. */
export interface ProfileAdoption {
  /** Sessions active in the month (records with a turn). */
  sessions: number;
  /** Of those, sessions with at least one detected skill load. */
  sessionsWithLoad: number;
  /** sessionsWithLoad / sessions, rounded to 2 decimals; 0 when no sessions. */
  adoptionRate: number;
}

/** current month first, then the two previous — month → profile name → numbers. */
export type MonthlyAdoptionRollup = Record<string, Record<string, ProfileAdoption>>;

/**
 * Compute the monthly adoption rollup for the current + previous 2
 * months, keyed by session profile name. Pure (given records + now).
 * Sessions recorded before the rollup existed simply don't exist in the
 * store — the rollup starts from deployment and deliberately undercounts
 * rather than estimating history. The neutral profile stays out: it is
 * the "no profile configured" bucket, not an adoption target.
 *
 * Profile buckets are staged in a Map and copied out at the end, so a
 * profile named like an Object.prototype member (e.g. "constructor")
 * cannot corrupt the rollup.
 */
export function computeMonthlyRollup(
  records: SkillSessionRecord[],
  now: Date = new Date(),
): MonthlyAdoptionRollup {
  const months = [0, 1, 2].map((i) => monthOf(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  const bucketsByMonth = new Map<string, Map<string, ProfileAdoption>>();
  for (const month of months) bucketsByMonth.set(month, new Map());
  for (const rec of foldSessionRecords(records)) {
    const monthBuckets = bucketsByMonth.get(rec.month);
    if (!monthBuckets) continue; // outside the 3-month window
    if (rec.role === NEUTRAL_SESSION_PROFILE) continue; // neutral excluded from the rollup
    let bucket = monthBuckets.get(rec.role);
    if (!bucket) {
      bucket = { sessions: 0, sessionsWithLoad: 0, adoptionRate: 0 };
      monthBuckets.set(rec.role, bucket);
    }
    bucket.sessions++;
    if (rec.hadSkillLoad) bucket.sessionsWithLoad++;
  }
  const rollup: MonthlyAdoptionRollup = {};
  for (const month of months) {
    const monthRollup: Record<string, ProfileAdoption> = {};
    for (const [name, bucket] of bucketsByMonth.get(month)!) {
      bucket.adoptionRate =
        bucket.sessions > 0
          ? Math.round((bucket.sessionsWithLoad / bucket.sessions) * 100) / 100
          : 0;
      monthRollup[name] = bucket;
    }
    rollup[month] = monthRollup;
  }
  return rollup;
}

/** Read the store and compute the rollup (store path injectable for tests). */
export function getMonthlyAdoptionRollup(
  options: { now?: Date; storePath?: string } = {},
): MonthlyAdoptionRollup {
  let storePath: string;
  try {
    storePath = options.storePath ?? getSkillsSessionsFilePath();
  } catch (err) {
    // Reader: a refused path (no absolute braid root) is a miss, not a throw.
    reportRecordFailure(err);
    return {};
  }
  return computeMonthlyRollup(readSessionRecords(storePath), options.now);
}
