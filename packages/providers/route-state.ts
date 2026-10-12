/**
 * Cross-session route state.
 *
 * The key ring already remembers which keys are dead; this store remembers
 * what a ROUTE was last observed to be — its most recent probe, its last
 * recorded death, its fail-back target and the model ids it has warmed. A
 * fresh session therefore does not have to re-learn any of it.
 *
 * Placement: this module is pure mechanism. It stores one opaque record per
 * provider id and never interprets it — no provider id, no death-class
 * vocabulary and no probe-state vocabulary appears here. The words "ok",
 * "degraded" and "unavailable" live in the probe layer; the death classes live
 * with the rotation code that classifies errors. This store writes them down
 * and reads them back. A death record carries the caller's class name plus
 * whichever identity the caller knows — a key hash, a model id, an HTTP status
 * — and which of those is meaningful is the caller's business, not this
 * store's.
 *
 * Secret discipline: key identity is a HASH supplied by the caller (the same
 * convention as the key ring's persisted state). This module never receives a
 * key value, so it cannot persist one.
 *
 * Durability discipline: the file is shared by every pi process on the host,
 * so mutations copy the key ring's protocol verbatim — an exclusive `.lock`
 * beside the file serializes read-merge-write across processes (stale locks
 * stolen after a TTL), a monotonic `rev` is the compare-and-swap version, and
 * the write is a same-directory temp file renamed over the target. There is no
 * second locking mechanism.
 *
 * Read discipline: reads never throw. An absent file is the normal empty state
 * and stays silent; a corrupt or partial file yields the empty state plus ONE
 * throttled diagnostic, because that is a fault rather than a fresh install.
 *
 * @module
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createThrottledLogger, providerLog } from "./log";
import { homedirAgentDir } from "./state-paths";

// Types

/**
 * One probe snapshot as persisted. Deliberately opaque: `state` is a string
 * because the vocabulary belongs to the probe layer, and unknown extra fields
 * are preserved by the caller's own type, not by this module.
 */
export interface RouteProbeRecord {
  state: string;
  at: number;
  headroomPct?: number;
  spendUsd?: number;
  capUsd?: number;
  remainingUsd?: number;
  resetAt?: number;
  reason?: string;
}

/** A recorded route death. `keyHash` identifies the key WITHOUT carrying it. */
export interface RouteDeathRecord {
  /** Caller-supplied class name (the classifier owns the vocabulary). */
  class: string;
  /** Hash of the key that died, when one did; absent when no key was at fault. */
  keyHash?: string;
  at: number;
  /** The model id the route refused, when the death is request-scoped. */
  modelId?: string | null;
  /** The HTTP status the route answered with, when the caller knew it. */
  status?: number | null;
}

/** A recorded fail-back onto another route. */
export interface RouteFailbackRecord {
  target: string;
  at: number;
}

/** Everything remembered about one route. */
export interface RouteStateEntry {
  lastProbe: RouteProbeRecord | null;
  deathClass: string | null;
  deathAt: number;
  deathKeyHash: string | null;
  /** Model id of a request-scoped death; null when the death was not one. */
  deathModelId: string | null;
  /** HTTP status of a request-scoped death; null when the caller knew none. */
  deathStatus: number | null;
  failback: RouteFailbackRecord | null;
  warmModels: string[];
}

/** The persisted document. */
export interface RouteState {
  version: 1;
  /** Monotonic compare-and-swap counter, incremented on every write. */
  rev: number;
  savedAt: number;
  routes: Record<string, RouteStateEntry>;
}

// Defaults

const STATE_VERSION = 1;

// State-lock tuning, identical to the key ring's: the TTL must stay far above
// any legitimate critical section (a sub-millisecond write) so only a crashed
// holder gets stolen.
const LOCK_TTL_MS = 10_000;
const LOCK_POLL_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;
const MUTATE_MAX_ATTEMPTS = 3;

/** Thrown when the on-disk `rev` advanced past the base a mutation assumed. */
class StateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateConflictError";
  }
}

// Module state

/** The live in-memory document. Replaced wholesale on every disk merge. */
let state: RouteState = emptyState();
/** Path this process's in-memory state is bound to (re-bound when it changes). */
let boundPath: string | null = null;
/** Youngest on-disk snapshot this process folded in. */
let lastSyncedAt = 0;
let lastSyncedRev = 0;
/** Whether THIS process currently owns the state lock. */
let lockHeldByUs = false;

const corruptLog = createThrottledLogger();

function emptyState(): RouteState {
  return { version: STATE_VERSION, rev: 0, savedAt: 0, routes: {} };
}

function emptyEntry(): RouteStateEntry {
  return {
    lastProbe: null,
    deathClass: null,
    deathAt: 0,
    deathKeyHash: null,
    deathModelId: null,
    deathStatus: null,
    failback: null,
    warmModels: [],
  };
}

/**
 * Store location, or `null` when no absolute state directory can be resolved.
 * With no path, reads see the empty document and mutations stay in memory:
 * the store is never written relative to the cwd.
 */
function defaultPath(): string | null {
  const dir = homedirAgentDir();
  return dir ? join(dir, ".provider-route-state.json") : null;
}

/**
 * Resolve the store's file and bind the in-memory document to it. A changed
 * path (a different HOME) drops the cache and loads the new file, so two paths
 * never share memory.
 */
function file(): string | null {
  const path = defaultPath();
  if (path !== boundPath) {
    boundPath = path;
    state = emptyState();
    lastSyncedAt = 0;
    lastSyncedRev = 0;
    mergeFromDiskIfNewer();
  }
  return path;
}

// Public API

/** The current document, tolerant of an absent/corrupt/partial file. */
export function readRouteState(): RouteState {
  file();
  mergeFromDiskIfNewer();
  return snapshot();
}

/** Record one probe outcome for a route (replaces any previous probe). */
export function recordProbe(
  providerId: string,
  outcome: RouteProbeRecord,
): void {
  mutate(providerId, (entry) => {
    entry.lastProbe = { ...outcome };
    return true;
  });
}

/** Record a route death (class + optional key identity + request identity + time). */
export function recordDeath(providerId: string, death: RouteDeathRecord): void {
  mutate(providerId, (entry) => {
    entry.deathClass = death.class;
    entry.deathKeyHash = death.keyHash ?? null;
    entry.deathModelId = death.modelId ?? null;
    entry.deathStatus = death.status ?? null;
    entry.deathAt = death.at;
    return true;
  });
}

/** Record that a route failed back onto `target`. */
export function recordFailback(
  providerId: string,
  failback: RouteFailbackRecord,
): void {
  mutate(providerId, (entry) => {
    entry.failback = { ...failback };
    return true;
  });
}

/** Clear a route's fail-back record; a no-op when none is set. */
export function clearFailback(providerId: string): void {
  mutate(providerId, (entry) => {
    if (!entry.failback) return false;
    entry.failback = null;
    return true;
  });
}

/** Replace the model ids a route has warmed (deduplicated, order kept). */
export function setWarmModels(
  providerId: string,
  modelIds: readonly string[],
): void {
  mutate(providerId, (entry) => {
    const next = dedupe(modelIds);
    if (sameStrings(entry.warmModels, next)) return false;
    entry.warmModels = next;
    return true;
  });
}

// Mutation

/** Said once per process: repeated mutation attempts must not flood the log. */
let warnedMemoryOnly = false;

function warnMemoryOnlyOnce(): void {
  if (warnedMemoryOnly) return;
  warnedMemoryOnly = true;
  providerLog(
    "warn",
    "providers/route-state",
    "[route-state] no absolute state directory (os.homedir() unavailable) - route state is memory-only for this process",
  );
}

/**
 * Apply one entry mutation under the lock with a fresh read-merge-write: the
 * newest on-disk snapshot replaces the in-memory document, the mutation runs,
 * and the result is written with a CAS `rev` — and only when the mutation
 * reports a change, so a no-op does not bump the counter.
 *
 * With no resolvable store path (no absolute home) the mutation still applies
 * to the in-memory document and is reported once as memory-only: refusing the
 * mutation would break live routing to avoid a write nobody asked for.
 */
function mutate(
  providerId: string,
  apply: (entry: RouteStateEntry) => boolean,
): void {
  const path = file();
  if (!path) {
    warnMemoryOnlyOnce();
    const entry = state.routes[providerId] ?? emptyEntry();
    if (apply(entry)) state.routes[providerId] = entry;
    return;
  }
  withLockedMutation(path, () => {
    const entry = state.routes[providerId] ?? emptyEntry();
    const changed = apply(entry);
    state.routes[providerId] = entry;
    return changed;
  });
}

function withLockedMutation(path: string, run: () => boolean): void {
  for (let attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt++) {
    acquireLock(path);
    try {
      const persisted = readPersisted(path);
      if (persisted) {
        state = persisted;
        lastSyncedAt = persisted.savedAt;
        lastSyncedRev = persisted.rev;
      } else {
        lastSyncedAt = 0;
        lastSyncedRev = 0;
      }
      if (!run()) return; // nothing to record -> skip the write (no rev bump)
      const written = writeCAS(path, lastSyncedRev);
      lastSyncedRev = written.rev;
      lastSyncedAt = written.savedAt;
      return;
    } catch (err) {
      if (err instanceof StateConflictError) continue; // lost CAS -> retry fresh
      providerLog(
        "warn",
        "providers/route-state",
        `[route-state] failed to persist: ${errorText(err)}`,
      );
      return;
    } finally {
      releaseLock(path);
    }
  }
  providerLog(
    "warn",
    "providers/route-state",
    `[route-state] failed to commit state after ${MUTATE_MAX_ATTEMPTS} attempts — mutation kept in memory only`,
  );
}

/**
 * Fold a NEWER on-disk snapshot into the in-memory document. The whole
 * document is replaced (the file is the newest committed truth); `>=` rather
 * than `>` so an equal-millisecond write by a peer is still folded in, with
 * `rev` disambiguating.
 */
function mergeFromDiskIfNewer(): void {
  if (!boundPath) return;
  const persisted = readPersisted(boundPath);
  if (!persisted) return;
  if (persisted.savedAt >= lastSyncedAt) {
    state = persisted;
    lastSyncedAt = persisted.savedAt;
    lastSyncedRev = persisted.rev;
  }
}

// Persistence

function readPersisted(path: string): RouteState | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    diagnoseUnreadable(path, errorText(err));
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    diagnoseUnreadable(path, "partial or malformed json");
    return null;
  }
  const normalized = normalizeState(parsed);
  if (!normalized) {
    diagnoseUnreadable(path, "unexpected schema");
    return null;
  }
  return normalized;
}

/** ONE throttled diagnostic line, then the empty state stands. */
function diagnoseUnreadable(path: string, why: string): void {
  corruptLog.occurrence(
    "warn",
    "providers/route-state",
    `[route-state] ignoring unreadable state file ${path} (${why}); starting from empty route state`,
  );
}

/**
 * Validate the document envelope; entries are normalized leniently so one bad
 * entry never discards the rest. Returns null only when the envelope itself is
 * unusable.
 */
function normalizeState(value: unknown): RouteState | null {
  const doc = asRecord(value);
  if (!doc) return null;
  if (doc.version !== STATE_VERSION) return null;
  const rawRoutes = asRecord(doc.routes);
  if (!rawRoutes) return null;
  const routes: Record<string, RouteStateEntry> = {};
  for (const [providerId, rawEntry] of Object.entries(rawRoutes)) {
    const entry = asRecord(rawEntry);
    if (entry) routes[providerId] = normalizeEntry(entry);
  }
  return {
    version: STATE_VERSION,
    rev: asNumber(doc.rev) ?? 0,
    savedAt: asNumber(doc.savedAt) ?? 0,
    routes,
  };
}

function normalizeEntry(raw: Record<string, unknown>): RouteStateEntry {
  const probe = asRecord(raw.lastProbe);
  const failback = asRecord(raw.failback);
  return {
    lastProbe: probe ? normalizeProbe(probe) : null,
    deathClass: asString(raw.deathClass) ?? null,
    deathAt: asNumber(raw.deathAt) ?? 0,
    deathKeyHash: asString(raw.deathKeyHash) ?? null,
    deathModelId: asString(raw.deathModelId) ?? null,
    deathStatus: asNumber(raw.deathStatus) ?? null,
    failback: failback ? normalizeFailback(failback) : null,
    warmModels: dedupe(
      Array.isArray(raw.warmModels)
        ? raw.warmModels.filter((m): m is string => typeof m === "string")
        : [],
    ),
  };
}

function normalizeProbe(raw: Record<string, unknown>): RouteProbeRecord {
  const probe: RouteProbeRecord = {
    state: asString(raw.state) ?? "unknown",
    at: asNumber(raw.at) ?? 0,
  };
  const headroom = asNumber(raw.headroomPct);
  if (headroom !== undefined) probe.headroomPct = headroom;
  const spend = asNumber(raw.spendUsd);
  if (spend !== undefined) probe.spendUsd = spend;
  const cap = asNumber(raw.capUsd);
  if (cap !== undefined) probe.capUsd = cap;
  const remaining = asNumber(raw.remainingUsd);
  if (remaining !== undefined) probe.remainingUsd = remaining;
  const reset = asNumber(raw.resetAt);
  if (reset !== undefined) probe.resetAt = reset;
  const reason = asString(raw.reason);
  if (reason !== undefined) probe.reason = reason;
  return probe;
}

function normalizeFailback(raw: Record<string, unknown>): RouteFailbackRecord {
  return { target: asString(raw.target) ?? "", at: asNumber(raw.at) ?? 0 };
}

/**
 * Atomic, CAS-guarded write: serialize to a same-directory temp file, then
 * rename() over the target (POSIX-atomic — no reader or second writer sees a
 * torn file). The on-disk `rev` is re-read immediately before the rename and
 * must still equal `baseRev`; otherwise a concurrent writer is surfaced as a
 * conflict and the caller retries with a fresh base.
 */
function writeCAS(
  path: string,
  baseRev: number,
): { rev: number; savedAt: number } {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const onDisk = readPersisted(path);
    if (onDisk && onDisk.rev !== baseRev) {
      throw new StateConflictError(
        `state rev ${onDisk.rev} != base ${baseRev}`,
      );
    }
  } catch (err) {
    if (err instanceof StateConflictError) throw err;
    // Unreadable disk file: fall through and overwrite (best-effort repair).
  }
  const rev = baseRev + 1;
  const savedAt = Date.now();
  state.rev = rev;
  state.savedAt = savedAt;
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
  return { rev, savedAt };
}

// State lock

/**
 * Exclusive lock beside the state file (`O_EXCL` create, `{pid, acquiredAt}`
 * payload), stale-steal after LOCK_TTL_MS, bounded poll, and a loud timeout
 * that proceeds WITHOUT the lock — the CAS on `rev` still guards that write.
 */
function acquireLock(path: string): void {
  const lockFile = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const maxPolls = Math.ceil(LOCK_TIMEOUT_MS / LOCK_POLL_MS) + 1;
  let polls = 0;
  for (;;) {
    try {
      const fd = openSync(lockFile, "wx");
      writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
      );
      closeSync(fd);
      lockHeldByUs = true;
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const parsed = JSON.parse(readFileSync(lockFile, "utf8")) as {
            acquiredAt?: number;
          };
          if (Date.now() - (parsed.acquiredAt ?? 0) > LOCK_TTL_MS) {
            unlinkSync(lockFile);
            continue;
          }
        } catch {
          /* unreadable/absent -> not provably stale; keep waiting */
        }
      } else {
        providerLog(
          "warn",
          "providers/route-state",
          `[route-state] failed to create state lock: ${errorText(err)}`,
        );
        return;
      }
      polls += 1;
      if (Date.now() >= deadline || polls > maxPolls) {
        providerLog(
          "warn",
          "providers/route-state",
          `[route-state] state lock not acquired within ${LOCK_TIMEOUT_MS}ms — proceeding WITHOUT lock (CAS on rev still guards the write)`,
        );
        return;
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

function releaseLock(path: string): void {
  if (!lockHeldByUs) return;
  lockHeldByUs = false;
  try {
    unlinkSync(`${path}.lock`);
  } catch {
    /* already gone — e.g. stolen as stale */
  }
}

// Helpers

function snapshot(): RouteState {
  const routes: Record<string, RouteStateEntry> = {};
  for (const [providerId, entry] of Object.entries(state.routes)) {
    routes[providerId] = {
      lastProbe: entry.lastProbe ? { ...entry.lastProbe } : null,
      deathClass: entry.deathClass,
      deathAt: entry.deathAt,
      deathKeyHash: entry.deathKeyHash,
      deathModelId: entry.deathModelId,
      deathStatus: entry.deathStatus,
      failback: entry.failback ? { ...entry.failback } : null,
      warmModels: [...entry.warmModels],
    };
  }
  return {
    version: STATE_VERSION,
    rev: state.rev,
    savedAt: state.savedAt,
    routes,
  };
}

function dedupe(modelIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of modelIds) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Synchronous thread sleep (Atomics.wait on the main thread). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
