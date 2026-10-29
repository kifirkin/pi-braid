/**
 * Durable per-session skill records + the monthly adoption rollup.
 *
 * The store is one append-only JSONL file with three record kinds, told apart
 * by `kind`:
 *
 *   (absent)         an ADOPTION record, the older shape:
 *                    { sessionId, role, month, hadSkillLoad, updatedAt }
 *   "applicability"  an APPLICABILITY record: the session's skill verdicts
 *                    (see ApplicabilityRecord)
 *   "obligation"     an OBLIGATION record: one skill's legs in one session
 *                    (see ObligationLegRecord)
 *
 * An adoption record exists for every session that reaches an agent turn, so
 * every such session gets ONE logical record (the rollup denominator);
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
 * Each reader reads its own kind and ignores the others. The adoption reader
 * is fail-closed on an unknown `kind`, so a record type added later cannot
 * enter the adoption numbers by looking enough like one; and a build that
 * predates the applicability kind reads those lines as adoption records of
 * the same session, which folds to the same numbers because it carries no
 * new sessions and never sets `hadSkillLoad`.
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
import { MAX_APPLICABILITY_EVIDENCE } from "./applicability.js";
import type { ApplicabilityEvidence, SkillApplicabilityVerdict } from "./applicability.js";

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
  // One file, several record kinds: the adoption reader accepts its own kind
  // (no `kind`, or an explicit "adoption") and refuses anything else.
  if (r.kind !== undefined && r.kind !== "adoption") return undefined;
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
 * Append one record line. Best-effort: every error is swallowed (this runs on
 * the agent-loop and tool-result paths — a telemetry failure must never
 * break a turn). Returns true when the line landed on disk.
 */
function appendLine(record: object, storePath: string): boolean {
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    appendFileSync(storePath, `${JSON.stringify(record)}\n`, "utf-8");
    return true;
  } catch (err) {
    reportRecordFailure(err);
    return false;
  }
}

/** Append one adoption record (see appendLine for the failure contract). */
export function appendSessionRecord(record: SkillSessionRecord, storePath: string): boolean {
  return appendLine(record, storePath);
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

// Applicability records (the verdict kind)

/**
 * One skill's applicability verdict for one session.
 *
 * The three classes, as this instrument names them:
 *
 *   not-applicable  the skill's own declared condition did not meet the
 *                   session's task text. Derived, never a row: the census's
 *                   `evaluated` minus the verdict rows. A row per non-match
 *                   would multiply every session's record by the installed
 *                   catalog to say "nothing here".
 *   ignored         the condition held and no detected read followed. This is
 *                   the class the adoption counters cannot express.
 *   read            the condition held and a detected SKILL.md read followed.
 *
 * `undeclared` sits outside all three: those skill files state no condition, so
 * no verdict about them is honest (see applicability.ts).
 */

/** One verdict row: the skill, its class, and the phrases that decided it. */
export interface ApplicabilityVerdictRecord {
  kind: "applicability";
  sessionId: string;
  role: string;
  month: string;
  updatedAt: string;
  /** The skill this row answers for. */
  skill: string;
  /** read | ignored — a row exists only where a condition held. */
  applicability: "read" | "ignored";
  evidence: ApplicabilityEvidence[];
}

/**
 * One session's census row: how much task text was read, how many skills
 * declared a condition, and which ones declared none. Written once per
 * session, so `not-applicable` is derivable without a row per non-match.
 */
export interface ApplicabilityCensusRecord {
  kind: "applicability";
  sessionId: string;
  role: string;
  month: string;
  updatedAt: string;
  /** Characters of task text the first evaluation read. */
  taskChars: number;
  /** Installed skills declaring at least one condition phrase. */
  evaluated: number;
  /** Installed skills whose files declare no condition phrase. */
  undeclared: string[];
}

/**
 * An applicability record. The two shapes share the kind and the session
 * identity, and a reader tells them apart by `skill`: a row with one answers
 * for that skill, a row without one is the session's census. The split is what
 * lets a per-skill record join the sibling compliance record on
 * (sessionId, skill) without either store learning the other's fields.
 */
export type ApplicabilityRecord = ApplicabilityVerdictRecord | ApplicabilityCensusRecord;

/** A session's applicability after folding every record written for it. */
export interface SessionApplicability {
  sessionId: string;
  role: string;
  month: string;
  updatedAt: string;
  /** Characters of task text the census read. */
  taskChars: number;
  /** Skills that declared a condition. */
  evaluated: number;
  /** Skills that declared none — the blind spot, named. */
  undeclared: string[];
  /** One entry per applicable skill, `read` beating `ignored`. */
  verdicts: SkillApplicabilityVerdict[];
  /** The three classes as counts: read + ignored = applicable. */
  classes: { read: number; ignored: number; notApplicable: number };
}

/** One evidence row, normalizing an unknown source to "no source recorded". */
function normalizeEvidence(raw: unknown): ApplicabilityEvidence | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  if (typeof e.phrase !== "string" || !e.phrase) return undefined;
  return e.source === "frontmatter" || e.source === "heading" || e.source === "description"
    ? { phrase: e.phrase, source: e.source }
    : { phrase: e.phrase };
}

/**
 * Normalize one raw applicability line; undefined when the line is not one.
 * Field junk is coerced to a safe default rather than trusted, matching the
 * adoption reader's posture.
 */
function normalizeApplicabilityRecord(raw: unknown): ApplicabilityRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "applicability") return undefined;
  if (typeof r.sessionId !== "string" || !r.sessionId) return undefined;
  if (typeof r.month !== "string" || !/^\d{4}-\d{2}$/.test(r.month)) return undefined;
  const base = {
    kind: "applicability" as const,
    sessionId: r.sessionId,
    role: normalizeProfileName(r.role) ?? NEUTRAL_SESSION_PROFILE,
    month: r.month,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
  };
  if (typeof r.skill === "string" && r.skill) {
    if (r.applicability !== "read" && r.applicability !== "ignored") return undefined;
    const evidence: ApplicabilityEvidence[] = [];
    for (const item of Array.isArray(r.evidence) ? r.evidence : []) {
      const normalized = normalizeEvidence(item);
      if (normalized) evidence.push(normalized);
    }
    return { ...base, skill: r.skill, applicability: r.applicability, evidence };
  }
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    ...base,
    taskChars: count(r.taskChars),
    evaluated: count(r.evaluated),
    undeclared: (Array.isArray(r.undeclared) ? r.undeclared : []).filter(
      (name): name is string => typeof name === "string" && name !== "",
    ),
  };
}

/**
 * Read the applicability records from the store. Missing or unreadable file →
 * empty (never throws); non-applicability and corrupt lines are skipped.
 */
export function readApplicabilityRecords(storePath: string): ApplicabilityRecord[] {
  let text: string;
  try {
    text = readFileSync(storePath, "utf-8");
  } catch {
    return []; // missing or unreadable → no records
  }
  const out: ApplicabilityRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = normalizeApplicabilityRecord(JSON.parse(trimmed));
      if (rec) out.push(rec);
    } catch {
      // torn or corrupt line — skip
    }
  }
  return out;
}

/**
 * Merge two verdicts for the same skill: `read` beats `ignored` (a read is
 * evidence the skill's content reached the session, whatever the turn order
 * was), and the evidence unions by (phrase, source), bounded like every other
 * evidence surface. Pure.
 */
function mergeVerdict(
  current: SkillApplicabilityVerdict | undefined,
  next: SkillApplicabilityVerdict,
): SkillApplicabilityVerdict {
  if (!current) return next;
  const byPhrase = new Map<string, ApplicabilityEvidence>();
  for (const evidence of [...current.evidence, ...next.evidence]) {
    const key = `${evidence.phrase}\u0000${evidence.source ?? ""}`;
    if (!byPhrase.has(key) && byPhrase.size < MAX_APPLICABILITY_EVIDENCE) {
      byPhrase.set(key, evidence);
    }
  }
  return {
    name: next.name,
    verdict: current.verdict === "read" || next.verdict === "read" ? "read" : "ignored",
    evidence: [...byPhrase.values()],
  };
}

/**
 * Fold the store into one logical record per sessionId: the newest census wins
 * the session facts, verdict rows union across writes with `read` beating
 * `ignored`. Pure. The fold is what makes a torn, duplicated or out-of-order
 * append harmless: the record set, not the line order, decides a verdict.
 */
export function foldApplicabilityRecords(records: ApplicabilityRecord[]): SessionApplicability[] {
  const byId = new Map<string, SessionApplicability>();
  const empty = (rec: ApplicabilityRecord): SessionApplicability => ({
    sessionId: rec.sessionId,
    role: rec.role,
    month: rec.month,
    updatedAt: rec.updatedAt,
    taskChars: 0,
    evaluated: 0,
    undeclared: [],
    verdicts: [],
    classes: { read: 0, ignored: 0, notApplicable: 0 },
  });
  for (const rec of records) {
    const prev = byId.get(rec.sessionId) ?? empty(rec);
    // Session facts come from the newest CENSUS row; verdict rows carry no
    // census of their own and must not erase it.
    const newer = rec.updatedAt >= prev.updatedAt;
    const verdicts = new Map(prev.verdicts.map((v) => [v.name, v]));
    if ("skill" in rec) {
      verdicts.set(
        rec.skill,
        mergeVerdict(verdicts.get(rec.skill), {
          name: rec.skill,
          verdict: rec.applicability,
          evidence: rec.evidence,
        }),
      );
    }
    const census = "evaluated" in rec ? (newer ? rec : undefined) : undefined;
    byId.set(rec.sessionId, {
      sessionId: rec.sessionId,
      role: newer ? rec.role : prev.role,
      month: newer ? rec.month : prev.month,
      updatedAt: newer ? rec.updatedAt : prev.updatedAt,
      taskChars: census ? census.taskChars : prev.taskChars,
      evaluated: census ? census.evaluated : prev.evaluated,
      undeclared: census ? census.undeclared : prev.undeclared,
      verdicts: [...verdicts.values()],
      classes: { read: 0, ignored: 0, notApplicable: 0 },
    });
  }
  for (const rec of byId.values()) {
    const read = rec.verdicts.filter((v) => v.verdict === "read").length;
    const ignored = rec.verdicts.length - read;
    rec.classes = { read, ignored, notApplicable: Math.max(0, rec.evaluated - read - ignored) };
  }
  return [...byId.values()];
}

/** Fields a caller supplies for the session's census row. */
export interface ApplicabilityCensusInput {
  taskChars: number;
  evaluated: number;
  undeclared: string[];
}

/** Resolve the session identity a record needs, or undefined for a fake ctx. */
function applicabilityBase(
  ctx: ExtensionContext,
): { sessionId: string; role: string; month: string; updatedAt: string } | undefined {
  const sess = resolveSession(ctx);
  if (!sess) return undefined;
  return {
    sessionId: sess.sessionId,
    role: getSessionProfile(ctx).name,
    month: monthOf(new Date()),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Append the session's census row. Best-effort like every other writer here: a
 * false return means the line did not land, never a thrown turn.
 */
export function recordApplicabilityCensus(
  ctx: ExtensionContext,
  census: ApplicabilityCensusInput,
  storePath?: string,
): boolean {
  try {
    const base = applicabilityBase(ctx);
    if (!base) return false;
    return appendLine(
      { kind: "applicability", ...base, ...census },
      storePath ?? getSkillsSessionsFilePath(),
    );
  } catch (err) {
    reportRecordFailure(err);
    return false;
  }
}

/**
 * Append one skill's verdict row. The same function writes the `read` upgrade:
 * the fold decides, so no line is ever rewritten.
 */
export function recordApplicabilityVerdict(
  ctx: ExtensionContext,
  verdict: { skill: string; applicability: "read" | "ignored"; evidence: ApplicabilityEvidence[] },
  storePath?: string,
): boolean {
  try {
    const base = applicabilityBase(ctx);
    if (!base) return false;
    return appendLine(
      { kind: "applicability", ...base, ...verdict },
      storePath ?? getSkillsSessionsFilePath(),
    );
  } catch (err) {
    reportRecordFailure(err);
    return false;
  }
}

/**
 * The folded applicability record for the context's own session, or undefined
 * when the session wrote none. Reader: a refused path or a torn store is a
 * miss, not a throw.
 */
export function getSessionApplicability(
  ctx: ExtensionContext,
  options: { storePath?: string } = {},
): SessionApplicability | undefined {
  try {
    const sess = resolveSession(ctx);
    if (!sess) return undefined;
    const storePath = options.storePath ?? getSkillsSessionsFilePath();
    return foldApplicabilityRecords(readApplicabilityRecords(storePath)).find(
      (rec) => rec.sessionId === sess.sessionId,
    );
  } catch (err) {
    reportRecordFailure(err);
    return undefined;
  }
}

// Obligation records (the applied leg)

/**
 * One skill's legs in one session: what the instrument saw happen to the body
 * an obligation names.
 *
 * These are facts about reads and calls, not verdicts. `read` here means a
 * DETECTED SKILL.md read, and it is deliberately not the applicability record's
 * `applicability: "read"` class — that one is a verdict about a skill whose
 * declared condition held, and the applicability record refuses to classify a
 * read whose condition never held. This record states the read and leaves the
 * verdict where it belongs.
 *
 * `called` and `applied` are the applied leg, and they are the reason the
 * record exists:
 *   called   a tool call in a family this skill declares happened this
 *            session, whatever the call's outcome — a refusal fires before the
 *            call and cannot know the result.
 *   applied  the FIRST such call came after a detected read of this body.
 *
 * The pair is decided once, at the first call, because that is the only moment
 * the ordering exists: a later read followed by a later call must not turn an
 * earlier violation into satisfaction. Both stay false when the skill declares
 * no family; most declare none, and an obligation that names no family is
 * satisfied by the read alone.
 *
 * `suggested` and `listed` are the surfaces that made the body findable in
 * this session (a delivered suggestion, a list_skills row); they carry the
 * "was it offered" half of adoption, which the call facts cannot.
 */
export interface ObligationLegRecord {
  kind: "obligation";
  sessionId: string;
  role: string;
  month: string;
  updatedAt: string;
  skill: string;
  suggested: boolean;
  listed: boolean;
  read: boolean;
  called: boolean;
  applied: boolean;
}

/** A record's five legs, read back as one row per skill. */
export interface ObligationLegs {
  skill: string;
  suggested: boolean;
  listed: boolean;
  read: boolean;
  called: boolean;
  applied: boolean;
}

/** One session's obligation rows, folded. */
export interface SessionObligation {
  sessionId: string;
  role: string;
  month: string;
  updatedAt: string;
  /** One row per skill seen, in first-seen order. */
  skills: ObligationLegs[];
}

/** Normalize a parsed JSON line into an obligation record, or null. */
export function normalizeObligationRecord(raw: unknown): ObligationLegRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "obligation") return null;
  if (typeof r.sessionId !== "string" || typeof r.skill !== "string" || !r.skill.trim()) {
    return null;
  }
  return {
    kind: "obligation",
    sessionId: r.sessionId,
    role: typeof r.role === "string" ? r.role : NEUTRAL_SESSION_PROFILE,
    month: typeof r.month === "string" ? r.month : "",
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
    skill: r.skill,
    suggested: r.suggested === true,
    listed: r.listed === true,
    read: r.read === true,
    called: r.called === true,
    applied: r.applied === true,
  };
}

/**
 * Read the obligation records from the store. Missing or unreadable file →
 * empty (never throws); other kinds and corrupt lines are skipped.
 */
export function readObligationRecords(
  storePath: string = getSkillsSessionsFilePath(),
): ObligationLegRecord[] {
  let text: string;
  try {
    text = readFileSync(storePath, "utf-8");
  } catch {
    return []; // missing or unreadable → no records
  }
  const out: ObligationLegRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = normalizeObligationRecord(JSON.parse(trimmed));
      if (rec) out.push(rec);
    } catch {
      // torn or corrupt line — skip
    }
  }
  return out;
}

/**
 * Fold a session's obligation rows into one record: the five legs OR across
 * every row, so a row that saw one leg never erases a leg a later row did not
 * have. `called`/`applied` are written once per skill, so the OR is exact
 * rather than convenient. A torn or duplicated row folds; a malformed one is
 * dropped at normalize, before this sees it.
 */
export function foldObligationRecords(records: ObligationLegRecord[]): SessionObligation[] {
  const bySession = new Map<string, SessionObligation>();
  for (const rec of records) {
    let session = bySession.get(rec.sessionId);
    if (!session) {
      session = {
        sessionId: rec.sessionId,
        role: rec.role,
        month: rec.month,
        updatedAt: rec.updatedAt,
        skills: [],
      };
      bySession.set(rec.sessionId, session);
    } else if (rec.updatedAt >= session.updatedAt) {
      session.role = rec.role;
      session.month = rec.month;
      session.updatedAt = rec.updatedAt;
    }
    const held = session.skills.find((legs) => legs.skill === rec.skill);
    if (!held) {
      session.skills.push({
        skill: rec.skill,
        suggested: rec.suggested,
        listed: rec.listed,
        read: rec.read,
        called: rec.called,
        applied: rec.applied,
      });
      continue;
    }
    held.suggested = held.suggested || rec.suggested;
    held.listed = held.listed || rec.listed;
    held.read = held.read || rec.read;
    held.called = held.called || rec.called;
    held.applied = held.applied || rec.applied;
  }
  return [...bySession.values()];
}

/**
 * Append one skill's legs. Best-effort like the sibling writer: a refused or
 * missing store returns false so the caller can retry on a later turn.
 */
export function recordObligationLegs(
  ctx: ExtensionContext,
  legs: ObligationLegs,
  storePath?: string,
): boolean {
  try {
    const base = applicabilityBase(ctx);
    if (!base) return false;
    const record: ObligationLegRecord = {
      kind: "obligation",
      ...base,
      skill: legs.skill,
      suggested: legs.suggested,
      listed: legs.listed,
      read: legs.read,
      called: legs.called,
      applied: legs.applied,
    };
    return appendLine(record, storePath ?? getSkillsSessionsFilePath());
  } catch (err) {
    reportRecordFailure(err);
    return false;
  }
}

/** The current session's obligation rows, folded. Missing store → undefined. */
export function getSessionObligation(
  ctx: ExtensionContext,
  options: { storePath?: string } = {},
): SessionObligation | undefined {
  try {
    const sess = resolveSession(ctx);
    if (!sess) return undefined;
    const storePath = options.storePath ?? getSkillsSessionsFilePath();
    return foldObligationRecords(readObligationRecords(storePath)).find(
      (rec) => rec.sessionId === sess.sessionId,
    );
  } catch (err) {
    reportRecordFailure(err);
    return undefined;
  }
}

/**
 * An obligation is satisfied when the body was read AND, if the session ever
 * called into a family the skill declares, that the first call came after the
 * read. Without a declared family the second clause is vacuous: reading the
 * body is the whole obligation.
 */
export function obligationSatisfied(legs: ObligationLegs): boolean {
  return legs.read && (!legs.called || legs.applied);
}

/** One judged skill: its legs, plus whether it was even an obligation. */
export interface JudgedSkill extends ObligationLegs {
  /** null when the skill's declared condition never held: no obligation. */
  satisfied: boolean | null;
}

/** A session's judgement: every leg it recorded, and the session boolean. */
export interface SessionJudgement {
  skills: JudgedSkill[];
  allSatisfied: boolean;
  /** Obligations that applied (leg rows whose condition held). */
  obligations: number;
}

/**
 * Judge one session against its obligation rows. Pure.
 *
 * A skill is an obligation when the applicability fold carries a verdict for
 * it: the previous record's question was whether the skill applied, and this
 * one takes that answer as given. An obligation is decided by this record's
 * legs alone, which is why the two kinds can be folded independently and
 * joined on (sessionId, skill) without either re-reading the other.
 */
export function judgeSessionObligations(
  applicable: SessionApplicability | undefined,
  obligation: SessionObligation | undefined,
): SessionJudgement | undefined {
  if (!applicable) return undefined;
  const applied = new Set(applicable.verdicts.map((verdict) => verdict.name));
  const skills: JudgedSkill[] = (obligation?.skills ?? []).map((legs) => ({
    ...legs,
    satisfied: applied.has(legs.skill) ? obligationSatisfied(legs) : null,
  }));
  // An applicable skill with no leg row still owes the read: a session that was
  // never offered, listed, or read the body it owed is the ignored population,
  // and dropping it from the denominator would report only the sessions that
  // happened to be instrumented.
  const seen = new Set(skills.map((legs) => legs.skill));
  for (const skill of applied) {
    if (seen.has(skill)) continue;
    skills.push({
      skill,
      suggested: false,
      listed: false,
      read: false,
      called: false,
      applied: false,
      satisfied: false,
    });
  }
  if (!applicable.verdicts.length) {
    return { skills, allSatisfied: false, obligations: 0 };
  }
  const obligations = skills.filter((legs) => legs.satisfied !== null);
  return {
    skills,
    obligations: obligations.length,
    allSatisfied: obligations.every((legs) => legs.satisfied === true),
  };
}

/**
 * The design's own decision rule: a gap this small makes the rate a duplicate
 * of the read rate, and a duplicate should be deleted rather than shipped.
 */
export const FALSIFIER_GAP_POINTS = 5;

/**
 * The two rates and their shared denominator.
 *
 * `sessions` is the population both rates are divided by: sessions with at
 * least one obligation that applied AND at least one obligation row, i.e. the
 * sessions this build's instrument saw. A session whose applicable verdicts
 * predate the instrument is counted in `uninstrumented` instead of scored as
 * unsatisfied — a zero the instrument did not observe is not a zero it found.
 *
 * `readRate` is the older measurement restricted to this population: a session
 * counts when ANY detected read landed in it, which is the adoption counter's
 * own definition (`actual > 0`), so the difference between the two numbers is
 * the satisfaction criterion and nothing else.
 */
export interface ObligationRate {
  sessions: number;
  allSatisfied: number;
  /** 0-1, rounded to 4 decimals (a percentage point is 2 of these). */
  allSatisfiedRate: number;
  withRead: number;
  readRate: number;
  /** allSatisfiedRate - readRate, in percentage points, 2 decimals. */
  gapPoints: number;
  /** Obligations that applied, across the population. */
  obligations: number;
  unsatisfied: number;
  /** False when the gap is under FALSIFIER_GAP_POINTS: the metric is a copy. */
  discriminating: boolean;
  /** Sessions with an applicable skill but no obligation row: not scored. */
  uninstrumented: number;
}

/** Compute both rates over one store's folds. Pure. */
export function computeObligationRate(
  sessions: SessionApplicability[],
  obligations: SessionObligation[],
): ObligationRate {
  const bySession = new Map(obligations.map((rec) => [rec.sessionId, rec]));
  let population = 0;
  let allSatisfied = 0;
  let withRead = 0;
  let obligationsSeen = 0;
  let unsatisfied = 0;
  let uninstrumented = 0;
  for (const session of sessions) {
    if (!session.verdicts.length) continue;
    const legs = bySession.get(session.sessionId);
    if (!legs || !legs.skills.length) {
      uninstrumented++;
      continue;
    }
    const judgement = judgeSessionObligations(session, legs);
    if (!judgement) continue;
    population++;
    obligationsSeen += judgement.obligations;
    if (judgement.allSatisfied) allSatisfied++;
    if (legs.skills.some((row) => row.read)) withRead++;
    unsatisfied += judgement.skills.filter((row) => row.satisfied === false).length;
  }
  const allSatisfiedRate = population ? round4(allSatisfied / population) : 0;
  const readRate = population ? round4(withRead / population) : 0;
  const gapPoints = Math.round((allSatisfiedRate - readRate) * 10000) / 100;
  return {
    sessions: population,
    allSatisfied,
    allSatisfiedRate,
    withRead,
    readRate,
    gapPoints,
    obligations: obligationsSeen,
    unsatisfied,
    discriminating: Math.abs(gapPoints) >= FALSIFIER_GAP_POINTS,
    uninstrumented,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * The store-wide rate, or undefined when the store carries no obligation row
 * at all. Undefined is the absent record: a reader of a store this build has
 * not written to sees the payload it always saw, byte for byte.
 */
export function getObligationRate(
  options: { storePath?: string } = {},
): ObligationRate | undefined {
  try {
    const storePath = options.storePath ?? getSkillsSessionsFilePath();
    const obligationRecords = readObligationRecords(storePath);
    if (!obligationRecords.length) return undefined;
    return computeObligationRate(
      foldApplicabilityRecords(readApplicabilityRecords(storePath)),
      foldObligationRecords(obligationRecords),
    );
  } catch (err) {
    reportRecordFailure(err);
    return undefined;
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
