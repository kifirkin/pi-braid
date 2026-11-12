/**
 * rotation-census.ts: a durable, bounded count of the route rotations this
 * host performed, grouped by day, by failure class and by route pair.
 *
 * Every rotation the engine performs produces one whisper, and that whisper
 * lives in a session transcript and dies with it. So the question "these
 * sessions moved from one route to another, why" was answerable only by
 * grepping thousands of session files. This module keeps the fact the whisper
 * already carries (from route, to route, class, status, time) in one small
 * file beside the other two provider state files, so the answer exists
 * tomorrow.
 *
 * Three properties hold by construction:
 *
 *   - The class is handed in. This module has no message text, no classifier
 *     and no provider table: a second reading of the same failure is how two
 *     answers to one question start existing. Whatever the walk decided is
 *     what gets counted, even when a later build would decide differently.
 *   - The record is bounded. At most CENSUS_DAYS day buckets and at most
 *     CENSUS_ROWS_PER_DAY rows in one bucket, the oldest dropped first, so the
 *     file cannot grow with history.
 *   - The write never throws. A full disk, a read-only directory or a state
 *     directory that cannot be resolved loses one diagnostic row, never the
 *     turn that rotated. The same shape the poller heartbeat took after a full
 *     disk turned into a dead process.
 *
 * The file is not guarded by a lock, unlike route-state.ts: a lock on the LLM
 * path costs a bounded stall (route-state waits up to 2 s) and this record is a
 * counter, not routing state. Two processes rotating inside the same
 * read-write window can therefore drop one row; the census is diagnostic, and
 * that loss is the price of never delaying a turn.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createThrottledLogger } from "./log";
import { homedirAgentDir } from "./state-paths";

const CENSUS_VERSION = 1;

/**
 * Day buckets kept on disk. Beyond this the oldest bucket is dropped on every
 * write. Two windows wide on purpose: the read surface reports a week, the
 * file keeps a fortnight, so yesterday's table is still there after a quiet
 * week.
 */
export const CENSUS_DAYS = 14;

/**
 * Rows kept per day. A rotation storm is bounded: a broken route that makes
 * every turn rotate writes 200 rows and then keeps the newest 200, instead of
 * growing until the disk fills. The file's ceiling is therefore
 * CENSUS_DAYS * CENSUS_ROWS_PER_DAY rows.
 */
export const CENSUS_ROWS_PER_DAY = 200;

/** Days the `ring_health` section counts back from today, today included. */
export const CENSUS_WINDOW_DAYS = 7;

/**
 * The classes a rotation can carry: exactly the failure classes the walk hands
 * the engage path (`handleMessageEnd` consults it for a WAF block, a shape
 * rejection, a capacity refusal and an exhausted ring, and for nothing else).
 *
 * `payload` and `transport` never rotate: a payload keeps its own recovery
 * (core's offload plus one in-place retry), and a transport failure means the
 * route never answered, so `buildPlan` returns null and the connectivity
 * watchdog owns it. `none` never rotates either. The list exists so a section
 * can print a zero for a class that did not happen this week (a `key` zero is
 * the answer to "did the credentials die"), not to filter the record: a stored
 * class outside this list still prints its own line.
 */
export const ROTATION_CLASSES: readonly string[] = [
  "shape",
  "capacity",
  "waf",
  "key",
];

/** The record's file name, in the same directory as the other state files. */
const FILE_NAME = ".provider-rotation-census.json";

/** One recorded rotation. Route ids only: no key, no hash, no model id. */
export interface RotationRow {
  /** The route the turn was on when it refused. */
  from: string;
  /** The route the walk engaged. */
  to: string;
  /** The walk's class for the refusal, as handed in. */
  class: string;
  /** The HTTP status the route answered with, when the walk had one. */
  status: number | null;
  /** Epoch ms. */
  at: number;
}

/** Rows per local day key (`YYYY-MM-DD`), oldest first. */
export type RotationDays = Record<string, RotationRow[]>;

/**
 * How the record was found. Kept apart because the two empty readings mean
 * different things to a reader: nothing has been recorded yet (a legitimate
 * zero), or the record cannot be reached at all (no state directory resolves,
 * or a file exists that cannot be read), which must not render as zeros.
 */
export type CensusState = "ok" | "absent" | "unavailable";

/**
 * What a reader gets. `days` is empty for both empty states; `state` is what
 * tells them apart, so a consumer can print a zero table for a fresh host and
 * `no record` for a file it could not read.
 */
export interface RotationCensus {
  state: CensusState;
  savedAt: number;
  days: RotationDays;
}

/** Where the record lives; both legs must be absolute or the write is refused. */
export interface RotationCensusOptions {
  /** Directory holding the record; defaults to the providers state directory. */
  stateDir?: string;
  /** The record's own path; wins over `stateDir` when both are given. */
  file?: string;
}

/** What the rotation path hands the recorder, one per rotation. */
export interface RotationInput {
  from: string;
  to: string;
  class: string;
  status: number | null;
  at: number;
}

/** ONE throttled line per burst: a failing write must not flood the TUI. */
const failureLog = createThrottledLogger();
const corruptLog = createThrottledLogger();
/** Said once per process: an unresolvable state directory is a standing fact. */
let warnedNoStateDir = false;

// Paths

/**
 * The record's path, or `null` when none can be resolved absolutely. With no
 * override this is `homedirAgentDir()`, the helper route-state.ts resolves its
 * own file with, so both stores live in the same pi-owned directory and no
 * second convention exists. A relative override is refused rather than
 * resolved against the process cwd, exactly as state-paths.ts refuses one.
 */
function resolvePath(options: RotationCensusOptions): string | null {
  const file = options.file?.trim();
  if (file) return isAbsolute(file) ? file : null;
  const dir = (options.stateDir ?? homedirAgentDir())?.trim();
  if (!dir || !isAbsolute(dir)) return null;
  return join(dir, FILE_NAME);
}

// Public API

/**
 * Record one rotation. Called once per rotation by the walk, with the class
 * the walk already decided. Never throws and never blocks on a lock: a failure
 * is reported once per burst and the row is lost.
 */
export function recordRotation(
  row: RotationInput,
  options: RotationCensusOptions = {},
): void {
  try {
    appendRotation(row, options);
  } catch (err) {
    // The diagnostic sink is the owner's `ctx.ui.notify`, which can throw too;
    // a census that breaks the LLM path through its own warning would be the
    // failure it exists to prevent.
    try {
      failureLog.occurrence(
        "warn",
        "providers/rotation-census",
        `[rotation-census] failed to record a rotation: ${errorText(err)}`,
      );
    } catch {
      /* nothing left to report through */
    }
  }
}

/**
 * The record as it exists on disk. A corrupt or wrong-version file reads as
 * `state: "unavailable"` plus ONE throttled diagnostic; an absent file is
 * `state: "absent"` and silent. Neither ever throws.
 */
export function readRotationCensus(
  options: RotationCensusOptions = {},
): RotationCensus {
  const path = resolvePath(options);
  if (!path) return emptyCensus("unavailable");
  return readAt(path);
}

// Write

function appendRotation(
  row: RotationInput,
  options: RotationCensusOptions,
): void {
  const path = resolvePath(options);
  if (!path) {
    if (!warnedNoStateDir) {
      warnedNoStateDir = true;
      failureLog.occurrence(
        "warn",
        "providers/rotation-census",
        "[rotation-census] no absolute state directory; rotations are not recorded in this process",
      );
    }
    return;
  }
  const at = Number.isFinite(row.at) ? Math.trunc(row.at) : Date.now();
  const from = asRouteId(row.from);
  const to = asRouteId(row.to);
  // A row naming no route is not a rotation: the walk cannot produce one
  // (buildPlan returns null without a provider id), so this only stops a
  // malformed caller from poisoning the counters.
  if (!from || !to) return;
  const census = readAt(path);
  const key = dayKey(at);
  const bucket = census.days[key] ?? [];
  bucket.push({
    from,
    to,
    class: asClassName(row.class),
    status:
      typeof row.status === "number" && Number.isFinite(row.status)
        ? Math.trunc(row.status)
        : null,
    at,
  });
  // Sorted before the cap so "oldest dropped first" is about time, not about
  // the order rows happened to arrive in.
  bucket.sort((a, b) => a.at - b.at);
  census.days[key] = bucket.slice(-CENSUS_ROWS_PER_DAY);
  writeAtomic(path, {
    version: CENSUS_VERSION,
    savedAt: Date.now(),
    days: pruneCensus(census.days),
  });
}

/**
 * Apply both bounds: the newest CENSUS_DAYS day buckets (keys sort
 * chronologically as `YYYY-MM-DD`) and the newest CENSUS_ROWS_PER_DAY rows in
 * each. An empty bucket is dropped rather than kept as a placeholder.
 */
function pruneCensus(days: RotationDays): RotationDays {
  const kept: RotationDays = {};
  for (const key of Object.keys(days).sort().slice(-CENSUS_DAYS)) {
    const rows = days[key].slice(-CENSUS_ROWS_PER_DAY);
    if (rows.length > 0) kept[key] = rows;
  }
  return kept;
}

/**
 * Serialize to a same-directory temp file, then rename() over the target:
 * POSIX-atomic, so a reader sees either the previous record or the new one and
 * never a torn file. A failed step removes the temp and rethrows to the one
 * caller that decides what a failure means (nothing, for the LLM path).
 */
function writeAtomic(path: string, doc: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort: the temp never became the record */
    }
    throw err;
  }
}

// Read

function emptyCensus(state: "absent" | "unavailable"): RotationCensus {
  return { state, savedAt: 0, days: {} };
}

/** Tolerant read. Every failure mode returns an empty document. */
function readAt(path: string): RotationCensus {
  let raw: string;
  try {
    if (!existsSync(path)) return emptyCensus("absent");
    raw = readFileSync(path, "utf8");
  } catch (err) {
    diagnoseUnreadable(path, errorText(err));
    return emptyCensus("unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    diagnoseUnreadable(path, "partial or malformed json");
    return emptyCensus("unavailable");
  }
  const normalized = normalizeCensus(parsed);
  if (!normalized) {
    diagnoseUnreadable(path, "unexpected schema");
    return emptyCensus("unavailable");
  }
  return normalized;
}

/**
 * ONE throttled diagnostic line, then the empty document stands. The write path
 * runs through the same reader, so a corrupt file is named once and then
 * replaced by the next rotation instead of failing it.
 */
function diagnoseUnreadable(path: string, why: string): void {
  try {
    corruptLog.occurrence(
      "warn",
      "providers/rotation-census",
      `[rotation-census] ignoring unreadable census file ${path} (${why}); starting from empty`,
    );
  } catch {
    /* a throwing sink must not turn a tolerant read into a throw */
  }
}

/**
 * Validate the envelope; rows are normalized leniently so one bad row never
 * discards the rest of the record.
 */
function normalizeCensus(value: unknown): RotationCensus | null {
  const doc = asRecord(value);
  if (!doc) return null;
  if (doc.version !== CENSUS_VERSION) return null;
  const rawDays = asRecord(doc.days);
  if (!rawDays) return null;
  const days: RotationDays = {};
  for (const [key, rawBucket] of Object.entries(rawDays)) {
    if (!Array.isArray(rawBucket)) continue;
    const rows: RotationRow[] = [];
    for (const rawRow of rawBucket) {
      const row = normalizeRow(rawRow);
      if (row) rows.push(row);
    }
    if (rows.length > 0) days[key] = rows.sort((a, b) => a.at - b.at);
  }
  return {
    state: "ok",
    savedAt: asNumber(doc.savedAt) ?? 0,
    days,
  };
}

function normalizeRow(value: unknown): RotationRow | null {
  const row = asRecord(value);
  if (!row) return null;
  const from = asRouteId(row.from);
  const to = asRouteId(row.to);
  if (!from || !to) return null;
  const status = asNumber(row.status);
  return {
    from,
    to,
    class: asClassName(row.class),
    status: status === undefined ? null : Math.trunc(status),
    at: asNumber(row.at) ?? 0,
  };
}

// Rendering

/** What a caller may vary: the window and the clock it is measured from. */
export interface RotationSectionOptions {
  /** Days counted back from `now`, today included; defaults to a week. */
  days?: number;
  /** Epoch ms "today" is measured from; defaults to Date.now(). */
  now?: number;
}

/**
 * The `ring_health` section: one header line, one line per class, per-pair
 * counts inside each class line, highest count first. Pure: same record and
 * same clock in means same text out.
 *
 * Three readings, kept apart on purpose:
 *
 *   - a record that could not be read, or no record handed in at all, prints
 *     `no record`: a broken instrument must not render as a table of zeros;
 *   - a host that has recorded nothing inside the window prints the zero table
 *     with one line saying so, so a quiet week cannot be read as a broken
 *     instrument either;
 *   - a populated window prints every class a rotation can carry (a `key` zero
 *     answers "did the credentials die") plus any class the record holds.
 */
export function formatRotationSection(
  census: RotationCensus | null | undefined,
  options: RotationSectionOptions = {},
): string {
  const days = Math.max(1, Math.trunc(options.days ?? CENSUS_WINDOW_DAYS));
  const now = options.now ?? Date.now();
  const header = `rotations, last ${days} day(s):`;
  if (!census || census.state === "unavailable") return `${header} no record`;
  const rows = rowsInWindow(census, now, days);
  if (rows.length === 0) {
    return `${header} 0 total\n  no rotations in this window`;
  }
  const byClass = new Map<string, Map<string, number>>();
  for (const row of rows) {
    let pairs = byClass.get(row.class);
    if (!pairs) {
      pairs = new Map();
      byClass.set(row.class, pairs);
    }
    const pair = `${row.from} -> ${row.to}`;
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  const lines = [`${header} ${rows.length} total`];
  for (const entry of classCounts(byClass)) {
    const pairs = [...(byClass.get(entry.name) ?? new Map<string, number>())];
    pairs.sort((a, b) => b[1] - a[1] || compare(a[0], b[0]));
    const detail =
      pairs.length === 0
        ? ""
        : `   ${pairs.map(([pair, n]) => `${pair} (${n})`).join(", ")}`;
    lines.push(
      `  ${entry.name.padEnd(11)}${String(entry.count).padStart(2)}${detail}`,
    );
  }
  return lines.join("\n");
}

/**
 * Every class the section prints: the classes a rotation can carry, plus any
 * class the record actually holds, so a stored row is never hidden. Highest
 * count first, ties by name, which puts the zero lines last.
 */
function classCounts(
  byClass: ReadonlyMap<string, ReadonlyMap<string, number>>,
): { name: string; count: number }[] {
  const names = new Set<string>([...ROTATION_CLASSES, ...byClass.keys()]);
  return [...names]
    .map((name) => ({
      name,
      count: [...(byClass.get(name)?.values() ?? [])].reduce(
        (sum, n) => sum + n,
        0,
      ),
    }))
    .sort((a, b) => b.count - a.count || compare(a.name, b.name));
}

/** The rows whose day key falls in the window, flattened. */
function rowsInWindow(
  census: RotationCensus,
  now: number,
  days: number,
): RotationRow[] {
  const keys = new Set(dayKeysEndingAt(now, days));
  const rows: RotationRow[] = [];
  for (const [key, bucket] of Object.entries(census.days)) {
    if (keys.has(key)) rows.push(...bucket);
  }
  return rows;
}

/**
 * The window's day keys, today first. Built from local calendar fields
 * (`getDate() - i`) rather than by subtracting 24 h, so a daylight-saving
 * boundary cannot repeat or skip a day.
 */
function dayKeysEndingAt(now: number, days: number): string[] {
  const today = new Date(now);
  const keys: string[] = [];
  for (let i = 0; i < days; i++) {
    keys.push(
      dayKey(
        new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate() - i,
          12,
        ).getTime(),
      ),
    );
  }
  return keys;
}

/** Local wall-clock day (`YYYY-MM-DD`): "last night" is the owner's local day. */
function dayKey(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Helpers

/** Locale-independent string order, so the text is byte-identical on any host. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asRouteId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A class is stored as given; a blank one is named rather than dropped. */
function asClassName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  return name || "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
