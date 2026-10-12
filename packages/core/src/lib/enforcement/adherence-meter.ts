/**
 * Adherence Meter — read-side per-rule counters over durable injection entries.
 *
 * The problem: the repo measures that a fix landed (tests) but not whether a
 * stated behavioral rule kept holding in live sessions. The durable raw
 * material already exists: every whisper/steer is appended to the session as a
 * `braid_injection` entry (`INJECTION_ENTRY_TYPE`), and the dedup machinery
 * already computes repeat suppression events in-process. This module counts
 * from that stream; it adds no emitter and no new subsystem.
 *
 * What it computes, per rule and per session:
 *   - deliveries   — the rule's whisper was delivered (display !== false)
 *   - repeats      — deliveries beyond the first (deliveries - 1)
 *   - suppressions — the dedup/cap machinery recorded a filtered delivery
 *                    (display === false; the flood-cap and reprime paths)
 *
 * Rule identity is DATA, never a hardcoded rule name: the key is the entry's
 * `source` (the emitting detector path) plus the normalized body, using the
 * existing `reprimeBodyKey` normalization — the same definition of "the same
 * body" the reprime suppression path uses, so repeats and suppressions agree.
 *
 * Owner-facing only: this module appends one JSONL report line per session
 * under `~/.pi/agent/braid/adherence/` and is read by nothing that renders
 * into the agent's prompt or context. There is no judge and no aggregate
 * score (deterministic counters only, by design).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import { braidDir } from "../config/braid-paths.js";
import { INJECTION_ENTRY_TYPE, reprimeBodyKey } from "../utils/injection-tracker.js";

const log = createLogger("adherence-meter");

// ── Thresholds and bounds ───────────────────────────────────────────────────

/**
 * K — the repeat count past which a rule escalates. A rule that re-fires past
 * K repeats in one session has out-run the existing per-turn budgets
 * (`WHISPER_CAPS`) and the measured cross-call reprime window. 3 anchors on
 * `PER_SOURCE_CAP_OVERRIDES["enforcement/whisper"] = 3` in
 * `lib/enforcement/turn-dedup.ts`: the system's own allowance for how many
 * times that source may speak in a turn window. Lower values (1-2) fire on
 * by-design multi-fire signals (context thresholds); higher values (5+) let a
 * stuck rule ride most of a session unseen.
 */
export const ADHERENCE_REPEAT_THRESHOLD_K = 3;

/**
 * Re-escalation milestones, in repeats. The first crossing of K fires; the
 * next owner ping needs the next rung; after the last rung the rule is
 * terminal for the session. This is the watchdog's `REWARN_MILESTONES`
 * mechanism (extensions/self/watchdog/engine.ts) with the ladder scaled to
 * repeat counts instead of raw failure counts.
 */
export const ADHERENCE_ESCALATION_MILESTONES: readonly number[] = [3, 6, 15];

/**
 * Per-session escalation budget, copying the value and pattern of
 * `WATCHDOG_ESCALATION_BUDGET_PER_SESSION` (lib/detection/context-thresholds.ts).
 * Past it the meter is terminal for the session: the 13th owner ping would
 * carry no new information. The meter owns its own constant because the
 * semantics differ — these bound owner TG pings, not agent-context injections.
 */
export const ADHERENCE_ESCALATION_BUDGET_PER_SESSION = 12;

/** Rolling-window size: sessions in the "did rule R hold" view (current included). */
export const ADHERENCE_ROLLING_K = 10;

/**
 * Total byte budget for the session-end rolling scan. The scan runs
 * synchronously inside session shutdown, so it is bounded by bytes as well as
 * by k: a project with several very large session files must not stall
 * shutdown. Sessions beyond the budget are dropped from the view with a note.
 */
export const ADHERENCE_SCAN_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export const ADHERENCE_REPORT_SCHEMA = "braid-adherence-report/1";

const ADHERENCE_DIR_NAME = "adherence";
const ADHERENCE_REPORT_FILE_NAME = "report.jsonl";

/** Default report directory. Resolved through braidDir() on every call, so a
 *  BRAID_HOME-pinned run writes into the pinned tree, not the live one. */
export function adherenceDir(): string {
  return path.join(braidDir(), ADHERENCE_DIR_NAME);
}

/** Stable report path; injectable base dir for fixtures. */
export function adherenceReportPath(baseDir: string = adherenceDir()): string {
  return path.join(baseDir, ADHERENCE_REPORT_FILE_NAME);
}

// ── Entry reading ───────────────────────────────────────────────────────────

interface SessionEntryLike {
  id?: unknown;
  parentId?: unknown;
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

/**
 * Walk the active branch of a session entry array.
 *
 * Session files contain abandoned branches after a checkout / tree
 * navigation; only entries reachable by `parentId` from the last entry count,
 * because abandoned branches are alternative histories that never happened.
 * Arrays without resolvable parent links (synthetic input, exotic stores) are
 * returned unchanged.
 */
export function activeBranchEntries(entries: readonly unknown[]): unknown[] {
  const list = entries.filter((e): e is SessionEntryLike => typeof e === "object" && e !== null);
  const byId = new Map<string, SessionEntryLike>();
  for (const e of list) if (typeof e.id === "string") byId.set(e.id, e);
  const hasLinks = list.some((e) => typeof e.parentId === "string" && byId.has(e.parentId));
  const last = [...list].reverse().find((e) => typeof e.id === "string");
  if (!last || !hasLinks) return [...entries];

  const chain: SessionEntryLike[] = [];
  const seen = new Set<string>();
  let cur: SessionEntryLike | undefined = last;
  while (cur && typeof cur.id === "string" && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = typeof cur.parentId === "string" ? byId.get(cur.parentId) : undefined;
  }
  return chain.reverse();
}

/**
 * Read + parse a session JSONL file into entries. Malformed lines are skipped
 * (a truncated tail must not kill the meter); the whole file is parsed because
 * the active-branch walk needs every entry's id/parentId.
 */
export function readSessionEntriesFromFile(
  file: string,
  readFile: (file: string) => string = (f) => fs.readFileSync(f, "utf8"),
): unknown[] {
  const entries: unknown[] = [];
  let raw: string;
  try {
    raw = readFile(file);
  } catch {
    return entries;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // partial line (live file tail) or corruption — skip, never throw
    }
  }
  return entries;
}

/**
 * Session files next to `sessionFile`, newest first, excluding the file
 * itself. The pi naming scheme is `<ISO-timestamp>_<id>.jsonl`, so a
 * lexicographic filename sort is chronological; it stays deterministic for
 * names outside the scheme.
 */
export function listSiblingSessionFiles(
  sessionFile: string,
  readDir: (dir: string) => string[] = (d) => fs.readdirSync(d),
): string[] {
  const dir = path.dirname(sessionFile);
  const current = path.resolve(sessionFile);
  let names: string[];
  try {
    names = readDir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => path.join(dir, n))
    .filter((f) => path.resolve(f) !== current)
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}

/** Session id from the file's header entry, falling back to the filename. */
function sessionIdOf(file: string, entries: readonly unknown[]): string {
  for (const raw of entries) {
    const e = raw as { type?: unknown; id?: unknown } | null;
    if (e?.type === "session" && typeof e.id === "string" && e.id) return e.id;
  }
  const base = path.basename(file).replace(/\.jsonl$/, "");
  const parts = base.split("_");
  return parts.length > 1 ? parts[parts.length - 1] : base;
}

/** Last-write time of a session file (0 when unavailable). */
function fileMtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Size of a session file in bytes (0 when unavailable). */
function fileSizeBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// ── Aggregation ─────────────────────────────────────────────────────────────

/** Per-rule counts for one session. */
export interface RuleAdherence {
  /** Stable key: `<source>::<normalized body>`. */
  rule: string;
  /** Emitting detector path (the entry's `source`). */
  source: string;
  /** Human-readable body, envelope stripped (first occurrence wins). */
  signal: string;
  deliveries: number;
  repeats: number;
  suppressions: number;
  firstAt: number;
  lastAt: number;
}

/**
 * Strip the universal whisper envelope (and the end marker) that
 * `applyWhisperEnvelope` adds before `trackInjection` stores the content, so
 * the key and the readable signal carry no clock.
 */
export function stripWhisperEnvelope(content: string): string {
  return content
    .replace(/^\[braid-whisper - [^\]\n]*\]\n?/, "")
    .replace(/\s*\[braid-whisper-end\]\s*$/, "")
    .trim();
}

/**
 * Count durable injection entries into per-rule rows. Input should already be
 * branch-filtered (see `activeBranchEntries`); non-injection entries and
 * malformed payloads are skipped.
 */
export function aggregateRuleAdherence(entries: readonly unknown[]): RuleAdherence[] {
  const byRule = new Map<string, RuleAdherence>();
  for (const raw of entries) {
    const e = raw as SessionEntryLike | null;
    if (e?.type !== "custom" || e.customType !== INJECTION_ENTRY_TYPE) continue;
    const data = e.data as
      | { source?: unknown; content?: unknown; display?: unknown; timestamp?: unknown }
      | null
      | undefined;
    if (!data || typeof data.source !== "string" || typeof data.content !== "string") continue;

    const signal = stripWhisperEnvelope(data.content);
    const rule = `${data.source}::${reprimeBodyKey(signal)}`;
    const at = typeof data.timestamp === "number" ? data.timestamp : 0;
    let rec = byRule.get(rule);
    if (!rec) {
      rec = {
        rule,
        source: data.source,
        signal,
        deliveries: 0,
        repeats: 0,
        suppressions: 0,
        firstAt: at,
        lastAt: at,
      };
      byRule.set(rule, rec);
    }
    if (data.display === false) rec.suppressions++;
    else rec.deliveries++;
    if (at > 0) {
      if (rec.firstAt === 0 || at < rec.firstAt) rec.firstAt = at;
      if (at > rec.lastAt) rec.lastAt = at;
    }
  }
  for (const rec of byRule.values()) rec.repeats = Math.max(0, rec.deliveries - 1);
  return [...byRule.values()].sort(
    (a, b) =>
      b.deliveries + b.suppressions - (a.deliveries + a.suppressions) ||
      a.rule.localeCompare(b.rule),
  );
}

// ── Verdict + escalation planning ───────────────────────────────────────────

/**
 * The single hold definition: a rule holds in a session iff its whisper did
 * not repeat past K (`repeats < K`). Repeats measure re-fires beyond the
 * first delivery; a single fire is the needle doing its job.
 */
export function ruleHolds(repeats: number, k: number = ADHERENCE_REPEAT_THRESHOLD_K): boolean {
  return repeats < k;
}

/** Per-session escalation bookkeeping (lives in extension state). */
export interface AdherenceEscalationState {
  /** rule key -> highest rung fired (index into the milestone ladder). */
  rules: Record<string, { rung: number }>;
  /** Total escalations fired this session (all rules). */
  total: number;
  /** Violation records observed in-process this session, by event `rule`. */
  violations: Record<string, number>;
}

export function createEscalationState(): AdherenceEscalationState {
  return { rules: {}, total: 0, violations: {} };
}

export type EscalationPlanReason =
  | "crossing"
  | "below-threshold"
  | "rule-terminal"
  | "session-terminal";

export interface EscalationPlan {
  fire: boolean;
  /** The rung the plan is about (the crossed milestone, or the next one). */
  milestone: number;
  reason: EscalationPlanReason;
}

/**
 * Decide whether `ruleKey` should escalate at `repeats`. Pure: the caller
 * marks the rung with `markEscalated` only after the owner channel accepted
 * the message, so a down channel retries instead of silently spending a rung.
 */
export function planEscalation(
  state: AdherenceEscalationState,
  ruleKey: string,
  repeats: number,
  opts: { milestones?: readonly number[]; budget?: number } = {},
): EscalationPlan {
  const milestones = opts.milestones ?? ADHERENCE_ESCALATION_MILESTONES;
  const budget = opts.budget ?? ADHERENCE_ESCALATION_BUDGET_PER_SESSION;
  if (state.total >= budget) return { fire: false, milestone: 0, reason: "session-terminal" };
  const rung = state.rules[ruleKey]?.rung ?? 0;
  if (rung >= milestones.length) return { fire: false, milestone: 0, reason: "rule-terminal" };
  const next = milestones[rung];
  return repeats >= next
    ? { fire: true, milestone: next, reason: "crossing" }
    : { fire: false, milestone: next, reason: "below-threshold" };
}

/** Advance a rule to its next rung and count the escalation. Call on success. */
export function markEscalated(state: AdherenceEscalationState, ruleKey: string): void {
  const rec = state.rules[ruleKey] ?? (state.rules[ruleKey] = { rung: 0 });
  rec.rung++;
  state.total++;
}

// ── Report ──────────────────────────────────────────────────────────────────

export interface AdherenceHistoryEntry {
  sessionId: string;
  endedAt: number;
  deliveries: number;
  repeats: number;
  held: boolean;
}

export interface AdherenceRuleReport {
  rule: string;
  source: string;
  signal: string;
  /** Current-session counts. */
  deliveries: number;
  repeats: number;
  suppressions: number;
  held: boolean;
  /** Rungs fired for this rule this session. */
  escalations: number;
  /** Oldest → newest; the last entry is the current session. */
  history: AdherenceHistoryEntry[];
}

export interface AdherenceReport {
  schema: string;
  generatedAt: string;
  k: number;
  session: { id: string; file: string; cwd: string };
  rules: AdherenceRuleReport[];
  violations: Array<{ rule: string; count: number }>;
  escalation: { fired: number; budget: number; terminal: boolean };
  notes: string[];
}

export interface AdherenceSessionInput {
  /** Current-session entries; branch-walked internally. */
  entries: readonly unknown[];
  sessionId: string;
  sessionFile: string;
  cwd?: string;
  escalation?: AdherenceEscalationState;
}

export interface AdherenceReportDeps {
  now?: () => number;
  /** Report directory override (fixtures); defaults to `adherenceDir()`. */
  reportDir?: string;
  /** Rolling-window size (current session included). */
  k?: number;
  readFile?: (file: string) => string;
  writeFile?: (file: string, data: string) => void;
  mkdirp?: (dir: string) => void;
  readDir?: (dir: string) => string[];
}

/**
 * Build the owner-facing report: current-session per-rule counts plus the
 * `did rule R hold in each of the last k sessions` view. The prior sessions
 * are read from the current session's directory (same project), newest first,
 * each branch-walked — the JSONL stays the single source of truth, no ledger.
 */
export function buildAdherenceReport(
  input: AdherenceSessionInput,
  deps: AdherenceReportDeps = {},
): AdherenceReport {
  const now = deps.now ?? Date.now;
  const k = Math.max(1, deps.k ?? ADHERENCE_ROLLING_K);
  const notes: string[] = [];

  const currentRules = aggregateRuleAdherence(activeBranchEntries(input.entries));

  interface PriorSession {
    sessionId: string;
    endedAt: number;
    file: string;
    rules: Map<string, RuleAdherence>;
  }
  const priorSessions: PriorSession[] = [];
  if (input.sessionFile) {
    const siblings = listSiblingSessionFiles(input.sessionFile, deps.readDir);
    let scannedBytes = 0;
    for (const file of siblings.slice(0, k - 1)) {
      const size = fileSizeBytes(file);
      if (scannedBytes + size > ADHERENCE_SCAN_MAX_TOTAL_BYTES) {
        notes.push(
          `rolling view bounded: ${scannedBytes} bytes scanned of a ${ADHERENCE_SCAN_MAX_TOTAL_BYTES}-byte budget`,
        );
        break;
      }
      scannedBytes += size;
      const entries = readSessionEntriesFromFile(file, deps.readFile);
      const rules = aggregateRuleAdherence(activeBranchEntries(entries));
      priorSessions.push({
        sessionId: sessionIdOf(file, entries),
        endedAt: fileMtimeMs(file),
        file,
        rules: new Map(rules.map((r) => [r.rule, r])),
      });
    }
    if (priorSessions.length < k - 1) {
      notes.push(
        `rolling view: ${priorSessions.length} prior session(s) available (k=${k}, current included)`,
      );
    }
  } else {
    notes.push("rolling view unavailable: no session file");
  }
  // End-time order, filename as a deterministic tiebreak.
  priorSessions.sort((a, b) => a.endedAt - b.endedAt || a.file.localeCompare(b.file));

  // Union of rules seen in the window; current-session rows keep their counts.
  const rows = new Map<string, AdherenceRuleReport>();
  const ensureRow = (rule: string, r?: RuleAdherence): AdherenceRuleReport => {
    let row = rows.get(rule);
    if (!row) {
      row = {
        rule,
        source: r?.source ?? rule.split("::")[0] ?? "",
        signal: r?.signal ?? "",
        deliveries: 0,
        repeats: 0,
        suppressions: 0,
        held: true,
        escalations: input.escalation?.rules[rule]?.rung ?? 0,
        history: [],
      };
      rows.set(rule, row);
    }
    return row;
  };
  for (const r of currentRules) {
    const row = ensureRow(r.rule, r);
    row.deliveries = r.deliveries;
    row.repeats = r.repeats;
    row.suppressions = r.suppressions;
    row.held = ruleHolds(r.repeats);
  }
  for (const s of priorSessions) {
    for (const r of s.rules.values()) ensureRow(r.rule, r);
  }
  for (const row of rows.values()) {
    for (const s of priorSessions) {
      const r = s.rules.get(row.rule);
      row.history.push({
        sessionId: s.sessionId,
        endedAt: s.endedAt,
        deliveries: r?.deliveries ?? 0,
        repeats: r?.repeats ?? 0,
        held: ruleHolds(r?.repeats ?? 0),
      });
    }
    row.history.push({
      sessionId: input.sessionId,
      endedAt: now(),
      deliveries: row.deliveries,
      repeats: row.repeats,
      held: row.held,
    });
  }

  const state = input.escalation ?? createEscalationState();
  const rules = [...rows.values()].sort(
    (a, b) =>
      b.deliveries + b.suppressions - (a.deliveries + a.suppressions) ||
      a.rule.localeCompare(b.rule),
  );
  const violations = Object.entries(state.violations)
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
  notes.push("violations: current session only, in-process; not joined to rule keys");

  return {
    schema: ADHERENCE_REPORT_SCHEMA,
    generatedAt: new Date(now()).toISOString(),
    k,
    session: { id: input.sessionId, file: input.sessionFile, cwd: input.cwd ?? "" },
    rules,
    violations,
    escalation: {
      fired: state.total,
      budget: ADHERENCE_ESCALATION_BUDGET_PER_SESSION,
      terminal: state.total >= ADHERENCE_ESCALATION_BUDGET_PER_SESSION,
    },
    notes,
  };
}

export type AdherenceWriteResult =
  | { ok: true; path: string; report: AdherenceReport }
  | { ok: false; error: string };

/**
 * Build + append the report as one JSONL line. Best-effort by contract: a
 * report failure must never break session shutdown, so every error comes back
 * as `{ok:false}`.
 *
 * Append-only on purpose: concurrent sessions (multiple pi panes are the
 * norm) each end and write their own line; a rewritten single JSON would let
 * the last writer clobber the others. The latest line is the latest report.
 */
export function writeAdherenceReport(
  input: AdherenceSessionInput,
  deps: AdherenceReportDeps = {},
): AdherenceWriteResult {
  try {
    const report = buildAdherenceReport(input, deps);
    const file = adherenceReportPath(deps.reportDir);
    const mkdirp = deps.mkdirp ?? ((dir: string) => fs.mkdirSync(dir, { recursive: true }));
    const writeFile = deps.writeFile ?? ((f: string, d: string) => fs.appendFileSync(f, d));
    mkdirp(path.dirname(file));
    writeFile(file, JSON.stringify(report) + "\n");
    return { ok: true, path: file, report };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.debug(`[adherence] report write failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
