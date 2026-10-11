/**
 * Generalized API key ring with exponential backoff.
 *
 * Supports multi-key rotation via P0..P9 env vars with fallback to a single
 * key, exponential per-key backoff (10s initial, 5min max), and deduplication
 * by value.
 *
 * Optional stateFile persistence: exhausted-key state (identified by hash,
 * never the raw value) survives restarts in ~/.pi/agent/.key-ring-state-*.json
 * so known-dead keys are skipped on startup.
 *
 * User-facing diagnostics route through providerLog
 * (native notify sink, never console.*): rotation events surface at info,
 * per-key exhaustion throttled at warn, and a loud ALL-KEYS-EXHAUSTED warn
 * (with the account's exhaustionNotice) fires at most once per window so a
 * 403 flood cannot spam the TUI.
 *
 * Cross-process safety (the keyring race):
 * The state file is SHARED by every pi process (orchestrator + parallel
 * workers resolve the same $prefix ring). A naive read-modify-write is
 * last-writer-wins across processes: one worker's exhaust/success can clobber
 * another's, leaving the file with a key marked usable that a peer just proved
 * dead. Four mechanisms close it:
 *
 *   1. State-lock (per state file): an exclusive `<file>.lock` (O_EXCL create,
 *      pid + acquiredAt payload) serializes every read-merge-write mutation
 *      ACROSS processes on the same host. Stale locks (holder crashed) are
 *      stolen after a TTL; acquisition timeouts warn loudly and proceed
 *      WITHOUT the lock, where CAS (2) still guards the write.
 *   2. CAS on a monotonic `rev` field (not just the wall-clock savedAt): each
 *      write increments `rev` and re-reads the on-disk rev immediately before
 *      the atomic temp-file+rename, aborting with a conflict if it advanced.
 *      A lost update becomes a bounded retry instead of a silent clobber.
 *   3. Persisted per-key cooldown applied on selection: getActiveKey merges
 *      any NEWER on-disk snapshot before serving, so a key a peer just
 *      exhausted is never served by this process — parallel processes converge
 *      on the same "dead until cooldown" set instead of each believing its
 *      own stale snapshot.
 *   4. Served-key pinning: exhaustActiveKey/markSuccess pin the exact key
 *      THIS process's getActiveKey served (captured before the lock/merge),
 *      and markSuccess refuses to clear a key whose exhaustion landed in a
 *      snapshot NEWER than the one this process's serve was based on (the
 *      monotonic `rev`), or was stamped after we started serving - a
 *      concurrent 403 signal wins over a concurrent success, so recovery
 *      cannot resurrect a dead key.
 *
 * @module
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { providerLog, createThrottledLogger } from "./log";

// Types

export interface KeyRingConfig {
  /** Env var prefix, e.g. "AGENT_ZERO_API_KEY". */
  prefix: string;
  /** Max keys to scan in P0..P{N-1} naming. Default: 10. */
  maxKeys?: number;
  /** Initial backoff in ms. Default: 10_000 (10s). */
  initialBackoffMs?: number;
  /** Max backoff in ms. Default: 300_000 (5 min). */
  maxBackoffMs?: number;
  /** State file name for persistence (stored under ~/.pi/agent/.key-ring-state-{name}.json). */
  stateFile?: string;
  /**
   * Provider/account-specific tail appended to the loud ALL-KEYS-EXHAUSTED
   * warning — e.g. the account daily-quota limit and its
   * reset time so the owner knows when retries will succeed.
   */
  exhaustionNotice?: string;
  /**
   * Repeats of the exhaustion warns are suppressed inside this window
   * (default 5 min). Injectable for tests.
   */
  exhaustWarnWindowMs?: number;
  /**
   * When set, emit ONE warn at creation when fewer than this many keys are
   * configured (the ring needs 4+ keys to survive a
   * daily-quota window). Production rings set 4; tests leave it unset so
   * exact-count log assertions stay exact.
   */
  warnBelowKeyCount?: number;
  /**
   * When set, append a health suffix (usable/total, exhausted, active index)
   * to the rotation INFO lines in getActiveKey so key rotation surfaces
   * keys-remaining. Off by default.
   */
  healthInRotationInfo?: boolean;
  /** Injectable clock for tests (drives the throttle windows). */
  now?: () => number;
}

export interface RingHealth {
  total: number;
  usable: number;
  exhausted: number;
  activeIndex: number;
}

export interface KeyRing {
  /** Get the active (non-exhausted) key, retrying any whose backoff expired. */
  getActiveKey(): string | null;
  /** Mark the currently active key exhausted; returns true if any key remains usable. */
  exhaustActiveKey(): boolean;
  /** Mark the active key as successful — resets its retry count and un-exhausts it. */
  markSuccess(): void;
  /** True when every key is exhausted and none are past their backoff window. */
  isFullyExhausted(): boolean;
  /** Snapshot of key ring health for diagnostics. */
  getStatus(): { usable: number; total: number; nextRetryMs: number | null };
  /** Rotation health snapshot: keys remaining / exhausted + active index. */
  health(): RingHealth;
  /** Number of keys loaded. */
  get size(): number;
}

// Internal State

interface KeyEntry {
  key: string;
  exhausted: boolean;
  exhaustedAt: number;
  retryCount: number;
  /** Persisted pid that last marked this key exhausted (see markSuccess guard). */
  exhaustedByPid?: number;
}

interface RingState {
  entries: KeyEntry[];
  activeIndex: number;
}

// Factory

export function createKeyRing(config: KeyRingConfig): KeyRing {
  const maxKeys = config.maxKeys ?? 10;
  const initialBackoffMs = config.initialBackoffMs ?? 10_000;
  const maxBackoffMs = config.maxBackoffMs ?? 300_000;
  const prefix = config.prefix;

  const state: RingState = initEntries(prefix, maxKeys);

  if (
    typeof config.warnBelowKeyCount === "number" &&
    state.entries.length < config.warnBelowKeyCount
  ) {
    providerLog(
      "warn",
      "providers/key-ring",
      `[key-ring:${prefix}] Only ${state.entries.length} key(s) configured — add ` +
        `${prefix}_P0..P${Math.max(0, config.warnBelowKeyCount - 1)} ` +
        `(${config.warnBelowKeyCount}+ keys) so the ring survives a daily-quota window.`,
    );
  }

  // One throttler per warn source so a 403 flood surfaces the FIRST line loud
  // and then goes quiet, and the human-readable all-exhausted warn
  // is never drowned out by the per-key line it was just preceded by.
  const exhaustWarnWindowMs = config.exhaustWarnWindowMs ?? 5 * 60 * 1000;
  const now = config.now ?? Date.now;
  const perKeyExhaustLog = createThrottledLogger(exhaustWarnWindowMs, now);
  const allExhaustLog = createThrottledLogger(exhaustWarnWindowMs, now);

  // Persistence
  // Load known-dead keys from disk so restarts skip them. Key identity is a
  // hash, never the raw value.
  let stateFile: string | null = null;
  // Youngest on-disk snapshot this process has seen: `savedAt` (wall clock)
  // drives the cross-process merge decision, `rev` (monotonic, per-write CAS
  // counter) is the compare-and-swap version that turns a lost update into a
  // bounded retry. Between them a stale worker cannot clobber another
  // worker's exhaustion/recovery (the key-ring race).
  let lastSyncedAt = 0;
  let lastSyncedRev = 0;
  // The key THIS process's last getActiveKey() served, when (`now()`), and the
  // state revision that serve was based on, used to pin exhaust/success onto
  // the exact served entry and to refuse clearing a key a peer exhausted after
  // we started serving it.
  let lastServed: { idx: number; at: number; rev: number } | null = null;

  if (config.stateFile) {
    stateFile = stateFilePath(config.stateFile);
    try {
      const persisted = readPersistedState(stateFile);
      if (persisted) {
        applyPersistedState(state, persisted);
        lastSyncedAt = persisted.savedAt;
        lastSyncedRev = persisted.rev ?? 0;
      }
    } catch (e) {
      providerLog(
        "warn",
        "providers/key-ring",
        `[key-ring:${prefix}] failed to load persisted state: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Re-read the persisted state file and, if another process has written a
   * NEWER snapshot than the last one this process synced, MERGE its per-key
   * exhaustion/cooldown into the local ring BEFORE a selection or mutation.
   * `mergeExcludeHashes` (the served-key pin) are left untouched so a just-
   * decided local mutation is never reverted by the merge.
   *
   * Read errors/absent files keep the local state untouched (the ring stays
   * functional) and never throw.
   */
  function mergeFromDiskIfNewer(mergeExcludeHashes?: Set<string>): void {
    if (!stateFile) return;
    let persisted: PersistedState | null;
    try {
      persisted = readPersistedState(stateFile);
    } catch {
      return; // read failure -> keep local state
    }
    if (!persisted) return;
    // >= (not >) so an equal-millisecond write by another process is still
    // folded in (Date.now() granularity can collide under a burst); rev (the
    // CAS version) disambiguates beyond the timestamp. Merging an identical
    // snapshot is idempotent and harmless.
    if (persisted.savedAt >= lastSyncedAt) {
      applyPersistedState(state, persisted, mergeExcludeHashes);
      lastSyncedAt = persisted.savedAt;
      lastSyncedRev = persisted.rev ?? 0;
    }
  }

  /**
   * Run a state mutation under the per-state-file lock with a fresh
   * read-merge-write: acquire the lock, re-read the newest snapshot and merge
   * it (excluding pinned hashes), apply `run` (returns true when it changed
   * state — only then is the file rewritten), write with CAS `rev`, release.
   * A CAS conflict (only reachable on the no-lock timeout path) retries with a
   * fresh base; after bounded attempts it warns and keeps the mutation in
   * memory so the ring stays functional.
   */
  function withLockedMutation(
    run: () => boolean,
    mergeExcludeHashes?: Set<string>,
  ): void {
    if (!stateFile) {
      run();
      return;
    }
    for (let attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt++) {
      acquireStateLock();
      try {
        const persisted = readPersistedState(stateFile);
        if (persisted) {
          applyPersistedState(state, persisted, mergeExcludeHashes);
          lastSyncedAt = persisted.savedAt;
          lastSyncedRev = persisted.rev ?? 0;
        } else {
          lastSyncedAt = 0;
          lastSyncedRev = 0;
        }
        const changed = run();
        if (!changed) return; // nothing to record -> skip the write (no rev bump)
        const written = writePersistedStateCAS(stateFile, state, lastSyncedRev);
        lastSyncedRev = written.rev;
        lastSyncedAt = written.savedAt;
        return;
      } catch (e) {
        if (e instanceof StateConflictError) {
          continue; // CAS lost (no-lock timeout path) — retry with a fresh read
        }
        providerLog(
          "warn",
          "providers/key-ring",
          `[key-ring:${prefix}] failed to persist state: ${(e as Error).message}`,
        );
        return;
      } finally {
        releaseStateLock();
      }
    }
    providerLog(
      "warn",
      "providers/key-ring",
      `[key-ring:${prefix}] failed to commit state after ${MUTATE_MAX_ATTEMPTS} attempts — mutation kept in memory only`,
    );
  }

  /**
   * Persist cooldown-expired (re-enabled) keys so peers and restarts see the
   * cooldown ended. Pinned from the merge so disk's older exhausted flag
   * cannot re-apply over the just-re-enabled local state. No-op when the ring
   * has no state file or nothing was re-enabled.
   */
  function flushCooldownExpiry(unExhaustedHashes: Set<string>): void {
    if (!stateFile || unExhaustedHashes.size === 0) return;
    withLockedMutation(() => true, unExhaustedHashes);
  }

  /** Compute exponential backoff for a given retry count. */
  function backoffMs(retryCount: number): number {
    const delay = initialBackoffMs * Math.pow(2, retryCount);
    return Math.min(delay, maxBackoffMs);
  }

  function getActiveKey(): string | null {
    const { entries } = state;
    if (entries.length === 0) return null;

    // Capture the rotation baseline BEFORE folding in newer on-disk state so
    // the rotation INFO still shows the real "was index" for a selection that
    // moved across a peer's persisted rotation.
    const prevActiveIndex = state.activeIndex;
    // Fold in any NEWER on-disk per-key cooldown another process persisted, so
    // this process never serves a key a peer just exhausted (cross-process
    // convergence, point 3 in the module doc). Read roll only — atomic reads
    // never race the lock-held writers, so this hot path takes no lock.
    mergeFromDiskIfNewer();

    const n = entries.length;
    const unExhaustedHashes = new Set<string>();
    for (let i = 0; i < n; i++) {
      const idx = (state.activeIndex + i) % n;
      const entry = entries[idx];

      if (!entry.exhausted) {
        state.activeIndex = idx;
        lastServed = { idx, at: now(), rev: lastSyncedRev };
        // Surface rotation (key switched) at info — only when the active key
        // actually changed, so a steady single-key ring stays quiet.
        if (idx !== prevActiveIndex) {
          providerLog(
            "info",
            "providers/key-ring",
            `[key-ring:${prefix}] Rotating to key index ${idx} (was ${prevActiveIndex}).` +
              (config.healthInRotationInfo ? healthSuffix() : ""),
          );
        }
        flushCooldownExpiry(unExhaustedHashes);
        return entry.key;
      }

      const elapsed = now() - entry.exhaustedAt;
      if (elapsed >= backoffMs(entry.retryCount)) {
        // Un-exhaust and reuse (capture the backoff BEFORE resetting the
        // retry count so the info line reports the real elapsed window).
        const reenabledBackoffMs = backoffMs(entry.retryCount);
        entry.exhausted = false;
        entry.exhaustedAt = 0;
        entry.retryCount = 0;
        entry.exhaustedByPid = undefined;
        state.activeIndex = idx;
        lastServed = { idx, at: now(), rev: lastSyncedRev };
        unExhaustedHashes.add(hashKey(entry.key));
        providerLog(
          "info",
          "providers/key-ring",
          `[key-ring:${prefix}] Key index ${idx} retry backoff elapsed (${reenabledBackoffMs}ms) — re-enabling` +
            (idx !== prevActiveIndex
              ? `, rotating from index ${prevActiveIndex}`
              : "") +
            "." +
            (config.healthInRotationInfo ? healthSuffix() : ""),
        );
        flushCooldownExpiry(unExhaustedHashes);
        return entry.key;
      }
    }

    flushCooldownExpiry(unExhaustedHashes);
    return null; // all entries exhausted and none past backoff
  }

  function exhaustActiveKey(): boolean {
    const { entries } = state;
    if (entries.length === 0) return false;

    // Pin the key THIS process is acting on — the one getActiveKey() just
    // served — BEFORE the lock + merge, so the merge's activeIndex advance can
    // never re-target this exhaustion onto a different key (point 4).
    const targetIdx = state.activeIndex;
    const targetEntry = entries[targetIdx];
    if (!targetEntry) return true;
    const targetHash = hashKey(targetEntry.key);

    let usable = 0;
    let retryCount = 0;
    withLockedMutation(
      () => {
        const entry = entries[targetIdx];
        entry.exhausted = true;
        entry.exhaustedAt = now();
        entry.exhaustedByPid = process.pid;
        entry.retryCount += 1;
        retryCount = entry.retryCount;
        usable = countUsable(entries);
        return true;
      },
      // Exclude the served key from the merge: our exhaustion of it is the
      // newest fact; the merge must not re-apply an older cooldown onto it.
      new Set([targetHash]),
    );

    // Throttled: a 403 flood exhausts the same key once per turn — the
    // first line is loud, repeats are silent, re-loud once per window.
    // Logged OUTSIDE the lock (notify-sink calls are sync) to keep the
    // state-lock critical section sub-millisecond.
    perKeyExhaustLog.occurrence(
      "warn",
      "providers/key-ring",
      `[key-ring:${prefix}] Key index ${targetIdx} exhausted ` +
        `(retry ${retryCount}, backoff ${backoffMs(retryCount)}ms, ` +
        `${usable}/${entries.length} usable)`,
    );

    if (usable === 0) {
      // Loud, human-readable, throttled once per window. The
      // exhaustionNotice (per-provider) makes it actionable for the owner.
      allExhaustLog.occurrence(
        "warn",
        "providers/key-ring",
        `[key-ring:${prefix}] ALL KEYS EXHAUSTED (0/${entries.length} usable). ` +
          `Next retry in ${backoffMs(Math.max(...entries.map((e) => e.retryCount)))}ms. ` +
          `Add keys via ${prefix}_P0..P${entries.length - 1} env vars or top up existing keys.` +
          (config.exhaustionNotice ? ` ${config.exhaustionNotice}` : ""),
      );
      return false;
    }
    return true;
  }

  function markSuccess(): void {
    const { entries } = state;
    if (entries.length === 0) return;

    // Same pin-before-merge pattern as exhaustActiveKey: clear the key THIS
    // process actually served, not whatever index the on-disk merge happens
    // to land on.
    const targetIdx = state.activeIndex;
    const targetEntry = entries[targetIdx];
    if (!targetEntry) return;
    const served =
      lastServed && lastServed.idx === targetIdx ? lastServed : null;

    let cleared = false;
    let wasExhausted = false;
    withLockedMutation(() => {
      const entry = entries[targetIdx];
      // Concurrent-exhaustion guard: if a DIFFERENT process marked this key
      // exhausted in a snapshot NEWER than the one this process's serve was
      // based on, or stamped that exhaustion after we started serving
      // (exhaustedAt > servedAt), that 403 is the newer signal for this key —
      // a stale success must not resurrect it (the reported "entry 0 usable
      // again" clobber). The revision comparison is the causal one:
      // exhaustedAt is stamped when the exhaustion is DECIDED, while the
      // snapshot carrying it lands LATER inside withLockedMutation, so a
      // peer's snapshot can be strictly newer than ours while carrying an
      // OLDER exhaustedAt and the wall clock alone misses. The wall-clock term
      // stays for snapshots written without a rev counter. A same-process
      // self-exhaust followed by a later success (e.g. direct-call feed-back
      // healing its own ring) still heals. Only applies when this process
      // actually served the target (served !== null); direct test-driven
      // markSuccess keeps pre-fix semantics.
      if (
        entry.exhausted &&
        entry.exhaustedByPid !== undefined &&
        entry.exhaustedByPid !== process.pid &&
        served !== null &&
        (lastSyncedRev > served.rev || entry.exhaustedAt > served.at)
      ) {
        cleared = false;
        wasExhausted = false;
        return false; // unchanged -> no write
      }
      wasExhausted = entry.exhausted || entry.retryCount > 0;
      cleared = wasExhausted;
      if (wasExhausted) {
        entry.exhausted = false;
        entry.exhaustedAt = 0;
        entry.retryCount = 0;
        entry.exhaustedByPid = undefined;
      }
      // Write only when a key was actually un-exhausted: a healthy successful
      // turn does not bump the state-file rev.
      return wasExhausted;
    });

    if (cleared && wasExhausted) {
      // Surface recovery at info and reset the exhaustion throttlers so the
      // NEXT burst starts loud again (mirrors the telegram 16d reset).
      providerLog(
        "info",
        "providers/key-ring",
        `[key-ring:${prefix}] Key index ${targetIdx} succeeded — backoff cleared.`,
      );
      perKeyExhaustLog.reset();
      allExhaustLog.reset();
    }
  }

  function isFullyExhausted(): boolean {
    return countUsable(state.entries) === 0;
  }

  function health(): RingHealth {
    const total = state.entries.length;
    const usable = countUsable(state.entries);
    return {
      total,
      usable,
      exhausted: total - usable,
      activeIndex: state.activeIndex,
    };
  }

  function healthSuffix(): string {
    const h = health();
    return ` (health: ${h.usable}/${h.total} usable, ${h.exhausted} exhausted, active ${h.activeIndex})`;
  }

  function getStatus(): {
    usable: number;
    total: number;
    nextRetryMs: number | null;
  } {
    const { entries } = state;
    const total = entries.length;
    const usable = countUsable(entries);

    let nextRetryMs: number | null = null;
    for (const e of entries) {
      if (e.exhausted) {
        const remaining = backoffMs(e.retryCount) - (now() - e.exhaustedAt);
        if (
          remaining > 0 &&
          (nextRetryMs === null || remaining < nextRetryMs)
        ) {
          nextRetryMs = remaining;
        }
      }
    }

    return { usable, total, nextRetryMs };
  }

  /**
   * Cross-process state lock for THIS state file. Exclusive create
   * (`O_EXCL`), payload = { pid, acquiredAt }, stale-steal after
   * LOCK_TTL_MS (a holder that crashed leaves a descendant lock), bounded
   * poll, and a loud timeout that proceeds WITHOUT the lock — the CAS `rev`
   * still guards that write. Returns true when this process holds the lock.
   */
  function acquireStateLock(): boolean {
    if (!stateFile) return true;
    const lockFile = stateFile + ".lock";
    // The lock lives next to the state file, whose directory does not exist
    // yet on a fresh tree. Create it first: open(..., "wx") on a missing
    // parent throws ENOENT (never EEXIST), and mistaking that for "lock
    // unavailable" silently drops cross-process serialization, leaving only
    // the rev CAS behind the read-merge-write.
    try {
      mkdirSync(dirname(lockFile), { recursive: true });
    } catch (e) {
      providerLog(
        "warn",
        "providers/key-ring",
        `[key-ring:${prefix}] failed to create state lock directory: ${(e as Error).message}`,
      );
      return false;
    }
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let polls = 0;
    const maxPolls = Math.ceil(LOCK_TIMEOUT_MS / LOCK_POLL_MS) + 1;
    for (;;) {
      try {
        const fd = openSync(lockFile, "wx");
        writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
        );
        closeSync(fd);
        lockHeldByUs = true;
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          // Another process holds it. Steal only if the holder is provably
          // stale (crashed): a lock held past TTL. Legitimate holders finish a
          // mutation in well under TTL.
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
            "providers/key-ring",
            `[key-ring:${prefix}] failed to create state lock: ${(e as Error).message}`,
          );
          return false;
        }
        polls += 1;
        if (Date.now() >= deadline || polls > maxPolls) {
          providerLog(
            "warn",
            "providers/key-ring",
            `[key-ring:${prefix}] state lock not acquired within ${LOCK_TIMEOUT_MS}ms — proceeding WITHOUT lock (CAS on rev still guards the write)`,
          );
          return false;
        }
        sleepSync(LOCK_POLL_MS);
      }
    }
  }

  function releaseStateLock(): void {
    if (!stateFile || !lockHeldByUs) return;
    lockHeldByUs = false;
    try {
      unlinkSync(stateFile + ".lock");
    } catch {
      /* already gone — e.g. stolen as stale */
    }
  }

  return {
    getActiveKey,
    exhaustActiveKey,
    markSuccess,
    isFullyExhausted,
    getStatus,
    health,
    get size() {
      return state.entries.length;
    },
  };
}

// Helpers

function initEntries(prefix: string, maxKeys: number): RingState {
  const seen = new Set<string>();
  const entries: KeyEntry[] = [];

  // Try P0..P{N-1} keys (multi-key setup)
  for (let i = 0; i < maxKeys; i++) {
    const val = process.env[`${prefix}_P${i}`];
    if (val?.trim() && !seen.has(val.trim())) {
      seen.add(val.trim());
      entries.push({
        key: val.trim(),
        exhausted: false,
        exhaustedAt: 0,
        retryCount: 0,
      });
    }
  }

  // Fall back to single key (e.g. AGENT_ZERO_API_KEY)
  const single = process.env[prefix];
  if (single?.trim() && !seen.has(single.trim())) {
    seen.add(single.trim());
    entries.push({
      key: single.trim(),
      exhausted: false,
      exhaustedAt: 0,
      retryCount: 0,
    });
  }

  return { entries, activeIndex: 0 };
}

function countUsable(entries: KeyEntry[]): number {
  return entries.filter((e) => !e.exhausted).length;
}

// Persistence Helpers

interface PersistedEntry {
  hash: string;
  exhausted: boolean;
  exhaustedAt: number;
  retryCount: number;
  /** pid that exhausted this key (absent on older files) — cross-process identity for the success-veto guard. */
  exhaustedBy?: number;
}

interface PersistedState {
  /** Schema version (always 1). */
  version: 1;
  /**
   * Monotonic CAS counter, incremented on every write. The compare-and-swap
   * version for the read-merge-write: a writer aborts (and retries) if the
   * on-disk rev advanced past the base its mutation was built on. Absent on
   * files written by older builds (then treated as 0).
   */
  rev: number;
  savedAt: number;
  activeIndex: number;
  entries: PersistedEntry[];
}

/** Thrown when the on-disk `rev` advanced past the base a mutation assumed (CAS lost). */
class StateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateConflictError";
  }
}

// State-lock tuning. LOCK_TTL_MS must stay far above any legitimate critical
// section (sub-millisecond write) so only crashed holders get stolen.
const LOCK_TTL_MS = 10_000;
const LOCK_POLL_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;
const MUTATE_MAX_ATTEMPTS = 3;

/** Process-wide flag: whether THIS process currently owns the state lock. */
let lockHeldByUs = false;

/** Synchronous thread sleep (Atomics.wait on the main thread). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function hashKey(key: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function stateFilePath(name: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return join(home, ".pi", "agent", `.key-ring-state-${name}.json`);
}

function readPersistedState(file: string): PersistedState | null {
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Merge a persisted snapshot into the local ring by hash. `mergeExcludeHashes`
 * (the served-key / just-re-enabled pin set) are left untouched so a
 * just-decided local mutation survives the merge.
 */
function applyPersistedState(
  state: RingState,
  persisted: PersistedState,
  mergeExcludeHashes?: Set<string>,
): void {
  const entries = persisted.entries ?? [];
  // Apply matched entries by hash
  for (const se of state.entries) {
    const h = hashKey(se.key);
    if (mergeExcludeHashes?.has(h)) continue; // pinned: keep local state
    const pe = entries.find(
      (e) => e.hash === h && typeof e.exhausted === "boolean",
    );
    if (pe) {
      se.exhausted = pe.exhausted;
      se.exhaustedAt = pe.exhaustedAt;
      se.retryCount = pe.retryCount;
      se.exhaustedByPid =
        typeof pe.exhaustedBy === "number" ? pe.exhaustedBy : se.exhaustedByPid;
    }
  }
  // Advance activeIndex past exhausted keys so the first request uses a
  // (known-)working key instead of a dead one.
  const n = state.entries.length;
  if (n > 0) {
    const start =
      typeof persisted.activeIndex === "number" ? persisted.activeIndex : 0;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      if (!state.entries[idx].exhausted) {
        state.activeIndex = idx;
        return;
      }
    }
    state.activeIndex = start % n;
  }
}

/**
 * Atomic, CAS-guarded write: serialize to a same-directory temp file, then
 * rename() over the target (POSIX-atomic — a concurrent reader or second
 * writer can never observe a torn file). Before renaming, re-read the on-disk
 * rev and abort with StateConflictError if it advanced past `baseRev` — the
 * compare-and-swap that turns a lost update into a caller retry. Returns the
 * written rev + savedAt so the caller's last-synced cursor advances.
 */
function writePersistedStateCAS(
  file: string,
  state: RingState,
  baseRev: number,
): { rev: number; savedAt: number } {
  mkdirSync(dirname(file), { recursive: true });
  // CAS guard: the on-disk rev must still equal the base this mutation was
  // built on. Under the state lock this always holds; on the no-lock timeout
  // path it surfaces a concurrent writer so the caller retries with a fresh
  // read instead of silently clobbering.
  try {
    const onDisk = readPersistedState(file);
    if (onDisk && (onDisk.rev ?? 0) !== baseRev) {
      throw new StateConflictError(
        `state rev ${onDisk.rev ?? 0} != base ${baseRev}`,
      );
    }
  } catch (e) {
    if (e instanceof StateConflictError) throw e;
    // Unreadable disk file: fall through and overwrite (best-effort).
  }
  const rev = baseRev + 1;
  const savedAt = Date.now();
  const persisted: PersistedState = {
    version: 1,
    rev,
    savedAt,
    activeIndex: state.activeIndex,
    entries: state.entries.map((e) => ({
      hash: hashKey(e.key),
      exhausted: e.exhausted,
      exhaustedAt: e.exhaustedAt,
      retryCount: e.retryCount,
      ...(typeof e.exhaustedByPid === "number"
        ? { exhaustedBy: e.exhaustedByPid }
        : {}),
    })),
  };
  // The temp name carries the pid so concurrent writers don't collide; the
  // rename is atomic, so two writers can never interleave bytes into a torn
  // file.
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(persisted, null, 2));
  renameSync(tmp, file);
  return { rev, savedAt };
}
