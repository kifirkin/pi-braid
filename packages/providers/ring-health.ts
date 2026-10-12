/**
 * Read-only health surface over the key-ring and route-state files.
 *
 * Two stores already record what a session learns about keys and routes:
 * key-ring.ts persists per-key cooldown state to
 * `~/.pi/agent/.key-ring-state-{provider}.json`, and route-state.ts remembers
 * what each route was last observed to be in
 * `~/.pi/agent/.provider-route-state.json`. Until now only the writers read
 * the files back. This module is the reader: it summarizes both for a human or
 * a consumer script, carrying no key material and mutating nothing.
 *
 * Placement: pure mechanism, beside the code whose schemas it reads. It knows
 * the ring file's naming convention and both documents' shapes because it
 * lives with the writers; it knows NO provider id, because every id arrives as
 * an argument or is discovered from the files themselves. It never writes,
 * locks or migrates: the stores own exactly one write protocol, and a second
 * writer is the class of bug this reader must not become.
 *
 * Secret discipline: the ring file is hash-only by construction (key-ring.ts
 * persists `hash`, never the key value). This reader copies that field and the
 * plain counters around it, so a value the ring never wrote cannot surface
 * here.
 *
 * Read discipline, kept identical to route-state.ts's: an absent file is the
 * normal empty state and stays silent; a malformed, partial or wrong-version
 * file yields `present: false` plus exactly ONE throttled diagnostic, never a
 * throw.
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createThrottledLogger } from "./log";
import { homedirAgentDir } from "./state-paths";
import { readRouteState } from "./route-state";
import type {
  RouteFailbackRecord,
  RouteProbeRecord,
  RouteState,
} from "./route-state";
import { deathInForce } from "./virtual-router";

// Types

/** One key's persisted health, by hash. Never the key value. */
export interface RingHealthEntry {
  exhausted: boolean;
  exhaustedAt: number;
  retryCount: number;
  /**
   * Pid that recorded the exhaustion (key-ring.ts persists the process id in
   * this field), or null when the file does not carry it.
   */
  exhaustedBy: number | null;
  /** The key's persisted identity. */
  keyHash: string;
}

/** No ring state file, or one this reader cannot trust. */
export interface RingHealthAbsent {
  provider: string;
  present: false;
}

/** The ring state file's summary. Hash-only. */
export interface RingHealthPresent {
  provider: string;
  present: true;
  rev: number;
  savedAt: number;
  activeIndex: number;
  entries: RingHealthEntry[];
}

export type RingHealth = RingHealthAbsent | RingHealthPresent;

/** Where to read a ring file from. */
export interface RingHealthOptions {
  /**
   * Directory holding `.key-ring-state-<provider>.json`. Defaults to the
   * pi agent directory under $HOME (the same base the writer uses).
   */
  stateDir?: string;
  /** Explicit ring state-file path; wins over `stateDir` + provider id. */
  file?: string;
}

/** One route's ring summary plus the facts the route store already holds. */
export interface RouteHealth {
  provider: string;
  ring: RingHealth;
  lastProbe: RouteProbeRecord | null;
  deathClass: string | null;
  deathAt: number;
  failback: RouteFailbackRecord | null;
  warmModels: string[];
}

/** How `routeHealth` decides which routes to report and where to read. */
export interface RouteHealthOptions {
  /** Directory holding the ring files; see `RingHealthOptions.stateDir`. */
  stateDir?: string;
  /**
   * Route ids to summarize. The default set is discovered: the routes the
   * route store already carries, plus the providers with a ring file in
   * `stateDir`. Ids named here are always included.
   */
  providers?: readonly string[];
  /**
   * The route document to summarize. Defaults to the route store's own reader
   * (`readRouteState`), which resolves its file from $HOME; a caller holding
   * the document (or pointing somewhere else) passes it in.
   */
  routeState?: RouteState;
}

/**
 * The window a recorded death is judged against, handed in by the caller that
 * already resolved it: the SAME `braid.providers.probeFreshnessMs` the router's
 * death gate is built with (`freshnessMs`), so the surface and the gate cannot
 * disagree about which deaths act. Required, because a renderer that prints a
 * death without stating whether it still holds is the defect this parameter
 * exists to make impossible. The age rule itself is the gate's (`deathInForce`).
 */
export interface DeathFreshness {
  /** How long (ms) a recorded death stays in force; `<= 0` ⇒ none does. */
  freshnessMs: number;
  /** Clock for the age test; defaults to `Date.now()`. */
  now?: number;
}

// Path resolution

const RING_FILE_PREFIX = ".key-ring-state-";
const RING_FILE_SUFFIX = ".json";

/** The directory the pi agent keeps its state files in: the writers' base
 *  (providers/state-paths.ts), so the reader looks where the writers wrote.
 *  `null` when no absolute home can be resolved - then there is no state
 *  directory to read, and the absent-file shape follows. */
function defaultStateDir(): string | null {
  return homedirAgentDir();
}

/**
 * The ring's state-file name for a provider id (key-ring.ts `stateFilePath`:
 * one file per ring, named by the provider id the ring was created with).
 */
function ringFileName(providerId: string): string {
  return `${RING_FILE_PREFIX}${providerId}${RING_FILE_SUFFIX}`;
}

/** Provider ids discoverable from ring files in `stateDir`, sorted. */
function ringProvidersIn(stateDir: string | null): string[] {
  if (!stateDir) return [];
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    return []; // absent/unreadable directory: nothing to discover, not a fault
  }
  const ids: string[] = [];
  for (const name of names) {
    if (
      !name.startsWith(RING_FILE_PREFIX) ||
      !name.endsWith(RING_FILE_SUFFIX)
    ) {
      continue;
    }
    const id = name.slice(
      RING_FILE_PREFIX.length,
      name.length - RING_FILE_SUFFIX.length,
    );
    if (id) ids.push(id);
  }
  return ids.sort();
}

// Ring read

const corruptLog = createThrottledLogger();

/** One entry as persisted by key-ring.ts. */
interface PersistedRingEntry {
  hash: string;
  exhausted: boolean;
  exhaustedAt: number;
  retryCount: number;
  exhaustedBy?: number;
}

/** The persisted ring document (key-ring.ts `PersistedState`, version 1). */
interface PersistedRingState {
  version: 1;
  rev: number;
  savedAt: number;
  activeIndex: number;
  entries: PersistedRingEntry[];
}

/**
 * Summarize one route's key ring. Absent file: `{ provider, present: false }`,
 * silent. Present file: the envelope plus one hash-only entry per key. A
 * malformed or wrong-version file is the same absent shape with ONE diagnostic.
 * Never throws.
 */
export function ringHealth(
  providerId: string,
  opts: RingHealthOptions = {},
): RingHealth {
  const dir = opts.stateDir ?? defaultStateDir();
  const file = opts.file ?? (dir ? join(dir, ringFileName(providerId)) : null);
  if (!file) return { provider: providerId, present: false };
  const persisted = readRingState(file);
  if (!persisted) return { provider: providerId, present: false };
  return {
    provider: providerId,
    present: true,
    rev: persisted.rev,
    savedAt: persisted.savedAt,
    activeIndex: persisted.activeIndex,
    entries: persisted.entries.map((entry) => ({
      exhausted: entry.exhausted,
      exhaustedAt: entry.exhaustedAt,
      retryCount: entry.retryCount,
      exhaustedBy: entry.exhaustedBy ?? null,
      keyHash: entry.hash,
    })),
  };
}

/** Parse a ring file. Absent stays silent; unreadable gets one diagnostic. */
function readRingState(file: string): PersistedRingState | null {
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    diagnoseUnreadable(file, errorText(err));
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    diagnoseUnreadable(file, "partial or malformed json");
    return null;
  }
  const normalized = normalizeRingState(parsed);
  if (!normalized) {
    diagnoseUnreadable(file, "unexpected schema");
    return null;
  }
  return normalized;
}

/** ONE throttled diagnostic line, then the absent state stands. */
function diagnoseUnreadable(file: string, why: string): void {
  corruptLog.occurrence(
    "warn",
    "providers/ring-health",
    `[ring-health] ignoring unreadable key-ring state file ${file} (${why}); reporting no ring state`,
  );
}

/**
 * Validate the document envelope (version 1 + an entries array, the guard
 * key-ring.ts itself applies) and normalize entries leniently, so one bad
 * entry never discards the rest. Returns null only when the envelope is
 * unusable. Only `hash` and the plain counters are copied out.
 */
function normalizeRingState(value: unknown): PersistedRingState | null {
  const doc = asRecord(value);
  if (!doc) return null;
  if (doc.version !== 1 || !Array.isArray(doc.entries)) return null;
  const entries: PersistedRingEntry[] = [];
  for (const raw of doc.entries) {
    const entry = asRecord(raw);
    const hash = entry ? asString(entry.hash) : undefined;
    if (!entry || hash === undefined) continue; // identity is the entry's point
    const exhaustedBy = asNumber(entry.exhaustedBy);
    entries.push({
      hash,
      exhausted: entry.exhausted === true,
      exhaustedAt: asNumber(entry.exhaustedAt) ?? 0,
      retryCount: asNumber(entry.retryCount) ?? 0,
      ...(exhaustedBy === undefined ? {} : { exhaustedBy }),
    });
  }
  return {
    version: 1,
    rev: asNumber(doc.rev) ?? 0,
    savedAt: asNumber(doc.savedAt) ?? 0,
    activeIndex: asNumber(doc.activeIndex) ?? 0,
    entries,
  };
}

// Route read

/**
 * Every route's ring summary plus the facts the route store already holds.
 * The route set is the union of the ids the caller names, the routes the route
 * document carries, and the providers with a ring file in `stateDir`. A route
 * with no recorded state still reports its ring (and empty facts); a route
 * with no ring file still reports its recorded facts. Never throws.
 */
export function routeHealth(opts: RouteHealthOptions = {}): RouteHealth[] {
  const stateDir = opts.stateDir ?? defaultStateDir();
  const routeState = opts.routeState ?? readRouteState();

  const providers = new Set<string>(opts.providers ?? []);
  for (const id of Object.keys(routeState.routes)) providers.add(id);
  for (const id of ringProvidersIn(stateDir)) providers.add(id);

  return [...providers].map((provider) => {
    const entry = routeState.routes[provider];
    return {
      provider,
      ring: ringHealth(provider, stateDir ? { stateDir } : {}),
      lastProbe: entry?.lastProbe ? { ...entry.lastProbe } : null,
      deathClass: entry?.deathClass ?? null,
      deathAt: entry?.deathAt ?? 0,
      failback: entry?.failback ? { ...entry.failback } : null,
      warmModels: entry ? [...entry.warmModels] : [],
    };
  });
}

// Rendering
//
// Two pure projections of a `routeHealth` report, for the `ring_health` tool:
// `summarizeRouteHealth` drops every key identity and keeps the counts and
// timestamps, and `formatRingHealth` renders those facts as text. The text is
// therefore hash-free by construction. It cannot carry a field the summary
// does not have, which is the property the tool's "no key material" promise
// rests on.
//
// The text's first line is the route preference order, handed in by the caller
// that owns the route table (the same array the rotation engine is built from).
// It is not discoverable here: the report's own order is the union of
// route-state keys and ring files on disk, and a union carries no preference.
// The renderer prints the names it is given, first to last, and learns nothing
// about where they come from.
//
// A recorded death is also currency-tagged: `deathExpired` says the router's
// own freshness gate would not act on it, and the text marks that `(expired)`.
// The window is settings, not a fact of the state files, so it is not known
// here: the caller that resolved it hands it in (`DeathFreshness`), the same
// resolved value the router is built with.

/** One key's health, identity-free. */
export interface RingEntrySummary {
  exhausted: boolean;
  exhaustedAt: number;
  retryCount: number;
}

/** A ring's counts and clock, identity-free. */
export type RingSummary =
  | { present: false }
  | {
      present: true;
      rev: number;
      savedAt: number;
      activeIndex: number;
      usable: number;
      total: number;
      entries: RingEntrySummary[];
    };

/** The route store's facts about one route, narrowed to what is printed. */
export interface RouteSummary {
  state: string;
  headroomPct: number | null;
  remainingUsd: number | null;
  resetAt: number | null;
  reason: string | null;
  /** The recorded death class, or null when the store has no death. */
  deathClass: string | null;
  /** Epoch ms of the recorded death; 0 when there is none. */
  deathAt: number;
  /**
   * A death is recorded but the router's gate would ignore it (older than the
   * window, untimed, or the window switched off). False when there is no death
   * at all, so `(expired)` never describes a route with nothing recorded.
   */
  deathExpired: boolean;
}

/** What one route reports, with every key identity dropped. */
export interface RouteHealthSummary {
  provider: string;
  ring: RingSummary;
  /** The recorded probe snapshot, or null when the store has none. */
  route: RouteSummary | null;
}

const RING_HEALTH_HEADER =
  "ring health (read-only: no probe, no rotation, no provider request, no write)";

/** Prefix of the preference-order line. */
const ROUTE_ORDER_PREFIX = "route order (preference):";

/**
 * Project a `routeHealth` report onto counts, timestamps and route state.
 * The mapping is field-by-field into new objects: `keyHash` has no seat here,
 * so a consumer holding only this output cannot print or persist one.
 */
export function summarizeRouteHealth(
  routes: readonly RouteHealth[],
  freshness: DeathFreshness,
): RouteHealthSummary[] {
  return routes.map((route) => ({
    provider: route.provider,
    ring: summarizeRing(route.ring),
    // A route with a probe OR a recorded death has facts to show; a route with
    // neither stays null so an untouched route prints no `route:` part.
    route:
      route.lastProbe || route.deathClass
        ? summarizeRoute(route, freshness)
        : null,
  }));
}

/**
 * The tool's text report: the configured route order, the header, one line per
 * route, one summary line. Pure, so same facts in means same text out: the
 * extension handler stays a call and the test can pin the rendering without
 * loading pi. `freshness` is the window a recorded death is judged against; see
 * `DeathFreshness`. `order` is the configured preference order - route ids,
 * first to last - which the caller owns and this renderer only prints.
 */
export function formatRingHealth(
  routes: readonly RouteHealth[],
  freshness: DeathFreshness,
  order: readonly string[],
): string {
  const summaries = summarizeRouteHealth(routes, freshness);
  const lines = [formatRouteOrderLine(order), RING_HEALTH_HEADER];
  for (const summary of summaries) lines.push(formatRouteLine(summary));
  lines.push(formatSummaryLine(summaries));
  return lines.join("\n");
}

/**
 * The preference order as one line, first to last. An empty order names no
 * route: the line says the order is empty rather than borrowing a name from the
 * report, because a set of reported routes is not a preference between them.
 */
function formatRouteOrderLine(order: readonly string[]): string {
  if (order.length === 0) return `${ROUTE_ORDER_PREFIX} none configured`;
  return (
    `${ROUTE_ORDER_PREFIX} ${order.join(" > ")};` +
    " a fresh session starts at the first healthy route"
  );
}

function summarizeRing(ring: RingHealth): RingSummary {
  if (!ring.present) return { present: false };
  let usable = 0;
  const entries: RingEntrySummary[] = ring.entries.map((entry) => {
    if (!entry.exhausted) usable++;
    return {
      exhausted: entry.exhausted,
      exhaustedAt: entry.exhaustedAt,
      retryCount: entry.retryCount,
    };
  });
  return {
    present: true,
    rev: ring.rev,
    savedAt: ring.savedAt,
    activeIndex: ring.activeIndex,
    usable,
    total: entries.length,
    entries,
  };
}

function summarizeRoute(
  route: RouteHealth,
  freshness: DeathFreshness,
): RouteSummary {
  const probe = route.lastProbe;
  return {
    state: probe?.state ?? "no probe",
    headroomPct: probe?.headroomPct ?? null,
    remainingUsd: probe?.remainingUsd ?? null,
    resetAt: probe?.resetAt ?? null,
    reason: probe?.reason ?? null,
    deathClass: route.deathClass,
    deathAt: route.deathAt,
    deathExpired:
      route.deathClass !== null &&
      !deathInForce(route.deathClass, route.deathAt, freshness),
  };
}

/** `<provider>  ring: …  route: …` — one line, the route part only when known. */
function formatRouteLine(summary: RouteHealthSummary): string {
  const route = summary.route ? `  route: ${formatRoute(summary.route)}` : "";
  return `${summary.provider}  ring: ${formatRing(summary.ring)}${route}`;
}

function formatRing(ring: RingSummary): string {
  if (!ring.present) return "no ring state";
  const keys =
    ring.total === 0
      ? "keys none"
      : `keys [${ring.entries.map(formatEntry).join(" | ")}]`;
  return (
    `rev ${ring.rev} saved ${formatLocalTime(ring.savedAt)}` +
    ` active #${ring.activeIndex} usable ${ring.usable}/${ring.total} ${keys}`
  );
}

/** `#i usable`, or `#i exhausted <when> retries <n>`. */
function formatEntry(entry: RingEntrySummary, index: number): string {
  if (!entry.exhausted) return `#${index} usable`;
  return (
    `#${index} exhausted ${formatLocalTime(entry.exhaustedAt)}` +
    ` retries ${entry.retryCount}`
  );
}

function formatRoute(route: RouteSummary): string {
  const headroom =
    route.headroomPct === null
      ? "headroom -"
      : `headroom ${route.headroomPct}%`;
  const remaining =
    route.remainingUsd === null
      ? "remaining -"
      : `remaining $${route.remainingUsd.toFixed(2)}`;
  const reset =
    route.resetAt === null
      ? "reset none"
      : `reset ${formatLocalTime(route.resetAt)}`;
  const reason = route.reason === null ? "" : ` reason "${route.reason}"`;
  const death =
    route.deathClass === null
      ? ""
      : ` death ${route.deathClass} ${formatLocalTime(route.deathAt)}` +
        (route.deathExpired ? " (expired)" : "");
  return `${route.state} ${headroom} ${remaining} ${reset}${reason}${death}`;
}

function formatSummaryLine(summaries: readonly RouteHealthSummary[]): string {
  let withRing = 0;
  let usable = 0;
  let total = 0;
  for (const summary of summaries) {
    if (!summary.ring.present) continue;
    withRing++;
    usable += summary.ring.usable;
    total += summary.ring.total;
  }
  return (
    `summary: routes ${summaries.length}, with ring state ${withRing},` +
    ` keys usable ${usable}/${total}`
  );
}

/**
 * Local wall-clock `YYYY-MM-DD HH:MM:SS`, built from the Date getters rather
 * than a locale format so the line reads the same on every host. A zero
 * timestamp is the absence the state files default to, not 1970.
 */
function formatLocalTime(ms: number): string {
  if (!ms) return "unknown";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

// Helpers

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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
