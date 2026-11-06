/**
 * Machine-wide poller ownership lock.
 *
 * Telegram's getUpdates is a per-bot singleton: only one consumer may long-
 * poll at a time. A module-local flag cannot provide this guarantee: it is
 * per-process state, so two pi processes could each "own" the poller and
 * 409-fight over the stream. This lock file is the machine-wide half.
 *
 * Liveness is a rule over an identity and a heartbeat, never over the pid
 * alone, because pids are namespace-local: a lock left by a dead container can
 * name a pid this namespace now happens to use (the file reads as held
 * forever), and a lock left by a live process in another namespace names a pid
 * that does not exist here (the file reads as dead and gets displaced, putting
 * two pollers on one bot). So the file records which boot wrote it and when
 * that process last proved it was running; the pid is read as evidence only on
 * the boot that wrote it. A recycled pid on one host is the same class, and the
 * same rule covers it.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { braidDir } from "./state-paths.js";

/** How often a holder refreshes `heartbeatAt` while it owns the lock. */
export const POLLER_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Age past which a holder's heartbeat stops counting as evidence that it is
 * polling. Three refreshes fit inside the window, so one late tick does not
 * cost a healthy holder the channel, and a process that stopped refreshing is
 * displaced within half a minute of going quiet.
 */
export const POLLER_HEARTBEAT_STALE_MS = 30_000;

/**
 * Slack between the moment a pre-identity holder wrote its lock and the start
 * time of the process now answering to the same pid. A pid can be recycled, so a
 * live pid alone cannot prove that the recorded holder is still there; a process
 * that started well after the record was written is someone else.
 */
const LEGACY_PID_REUSE_SLACK_MS = 60_000;

/** Boot identity recorded when the kernel offers no readable name at all. */
const BOOT_IDENTITY_FALLBACK = "boot-unknown";

/** Default lock location: beside the other braid-owned telegram state
 *  (~/.pi/agent/braid, BRAID_HOME-overridable). Null when no absolute braid
 *  root resolves: the poller refuses to start rather than lock beside the cwd. */
export function defaultPollerLockPath(): string | null {
  const root = braidDir();
  return root === null ? null : join(root, "telegram-poller.lock");
}

/**
 * What a lock file may hold. A pid is the one field every version wrote.
 * `instanceId` and `heartbeatAt` are optional here on purpose: the acquisition
 * rule has to judge a file it cannot fully read (an older braid's lock, a
 * truncated write), and a holder description has to render one.
 */
export interface PollerLockInfo {
  pid: number;
  startedAt: number;
  instanceId?: string;
  heartbeatAt?: number;
  role?: string;
  startedBy?: string;
}

/** What an acquirer stamps; identity and heartbeat are added by `acquirePollerLock`. */
export interface PollerLockStamp {
  pid: number;
  startedAt?: number;
  instanceId?: string;
  role?: string;
  startedBy?: string;
}

/**
 * Why an acquisition succeeded.
 *
 * - `fresh`: no lock file held the channel;
 * - `unreadable-file`: a file was there and named no holder, so nothing was
 *   displaced;
 * - `same-pid-refresh`: this process re-acquired its own lock (session reload);
 * - `stale-same-instance`: the holder shares this instance and is gone: its
 *   pid is dead, or its heartbeat is past the staleness window. A live pid with
 *   a quiet heartbeat is this case, not a refusal;
 * - `stale-across-namespace`: the holder belongs to another boot (or recorded
 *   none) and its heartbeat is past the staleness window.
 */
export type PollerLockTakeoverReason =
  | "fresh"
  | "unreadable-file"
  | "same-pid-refresh"
  | "stale-same-instance"
  | "stale-across-namespace"
  | "stale-legacy"
  | "stale-legacy-recycled";

/**
 * Why an acquisition refused.
 *
 * - `held-same-instance`: a different live pid on this instance, heartbeat
 *   within the window;
 * - `held-across-namespace`: a holder from another boot whose heartbeat is
 *   within the window: its pid says nothing here, the heartbeat says it polls;
 * - `stale-unknown`: a holder whose heartbeat cannot be read at all. Refused
 *   rather than guessed: without the heartbeat there is no evidence either way,
 *   and a wrong guess either steals a live channel or wedges a dead one.
 */
export type PollerLockRefusalReason =
  | "held-same-instance"
  | "held-across-namespace"
  | "held-legacy"
  | "stale-unknown";

export type PollerLockReason =
  | PollerLockTakeoverReason
  | PollerLockRefusalReason;

export type AcquirePollerLockResult =
  | {
      ok: true;
      reason: PollerLockTakeoverReason;
      tookOver: boolean;
      /** The displaced record, when one was readable. */
      previous?: PollerLockInfo;
    }
  | {
      ok: false;
      reason: PollerLockRefusalReason;
      holder: PollerLockInfo;
      /** The file the caller should name in a refusal message. */
      path: string;
    };

/** Injectable reads for the acquisition rule (tests supply a fake clock and
 *  process table; the live path uses the machine's). */
export interface AcquirePollerLockOptions {
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
  /** Start time of a live pid, in epoch ms. Injected so the legacy arm can be
   *  tested without depending on the machine's process table. */
  pidStartedAt?: (pid: number) => number | undefined;
}

/** Read the lock file; absent/corrupt/unreadable reads as "no holder". */
export function readPollerLock(path: string): PollerLockInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PollerLockInfo;
    if (Number.isFinite(parsed?.pid)) return parsed;
  } catch {
    // A file that does not parse names no holder.
  }
  return undefined;
}

/**
 * Live-pid probe. Signal-0 errors with EPERM when the pid exists but is not
 * ours to signal (still alive); ESRCH means the pid is gone. Meaningful only to
 * the boot that wrote the pid, which is why the acquisition rule gates it on
 * the instance identity.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Injectable kernel probes for the boot identity. Each returns the raw text
 *  its source offers, or undefined when that source is unreadable here. */
export interface BootIdentityProbes {
  /** Contents of `/proc/sys/kernel/random/boot_id`, where procfs is mounted. */
  readProcBootId?: () => string | undefined;
  /** `sysctl -n <name>` on this host. */
  readSysctl?: (name: string) => string | undefined;
}

/** The Linux kernel's own name for the boot. Absent where procfs is not mounted
 *  in this namespace. */
function readProcBootIdFile(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
  } catch {
    return undefined;
  }
}

/** One `sysctl -n <name>` read: undefined when the name does not exist on this
 *  platform or sysctl refuses. */
function runSysctl(name: string): string | undefined {
  try {
    return execFileSync("sysctl", ["-n", name], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/** A probe's answer names a boot only when it carries text: an empty read falls
 *  through to the next source. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The kernel's boot identity, in the order the kernel can be trusted to keep it.
 * `/proc/sys/kernel/random/boot_id` is written once per boot and is free where
 * procfs exists; `kern.bootsessionuuid` is darwin's name for the same fact.
 * `kern.boottime` is the wall clock minus uptime, so a clock step moves it and
 * two processes on one boot then compute different identities: it stays only as
 * the last resort, a documented degradation rather than the darwin default. The
 * recorded fallback covers a kernel that offers none of the three; two boots
 * that both fall back and share a hostname look identical, which the heartbeat
 * then has to cover.
 *
 * Probes are injected so a fixture can answer for two readings of one boot and
 * observe which source the identity took. The live path passes none and reads
 * this machine.
 */
export function readBootIdentity(probes: BootIdentityProbes = {}): string {
  const readProc = probes.readProcBootId ?? readProcBootIdFile;
  const sysctl = probes.readSysctl ?? runSysctl;
  const probe = (read: () => string | undefined): string | undefined => {
    try {
      return nonEmpty(read());
    } catch {
      // A probe that throws did not read its source.
      return undefined;
    }
  };
  const kernelId = probe(readProc);
  if (kernelId) return kernelId;
  const sessionUuid = probe(() => sysctl("kern.bootsessionuuid"));
  if (sessionUuid) return sessionUuid;
  const bootTime = probe(() => sysctl("kern.boottime"));
  if (bootTime) return bootTime;
  return BOOT_IDENTITY_FALLBACK;
}

let cachedInstanceId: string | undefined;

/**
 * Identity of the boot this process runs on: hostname plus the kernel's boot
 * id, so two boots, and a container's boot against its host's, never share
 * one. Memoized: the answer cannot change inside a process.
 */
export function resolveInstanceId(): string {
  cachedInstanceId ??= `${hostname()}:${readBootIdentity()}`;
  return cachedInstanceId;
}

function writeLock(path: string, info: PollerLockInfo): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(info));
}

// Best-effort release at process exit: the exit hook removes the lock this
// process last acquired. A hook that never runs (kill -9, crash) leaves the
// file behind, which is harmless: the next acquirer sees a dead or past-window
// record and takes the lock over.
let exitHookInstalled = false;
let heldLockPath: string | undefined;

/**
 * The exit hook's body, exported so a test can run it without exiting.
 * Ownership-checked on purpose: by the time a process exits, the file may name
 * a successor that took the channel over, and unlinking by path would hand the
 * singleton to a third process while the successor is still polling.
 */
export function releaseHeldLockAtExit(): void {
  if (!heldLockPath) return;
  releasePollerLock(heldLockPath);
}

function installExitRelease(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", releaseHeldLockAtExit);
}

/** Age of a heartbeat, rendered for a human reading a refusal. */
function describeHeartbeatAge(holder: PollerLockInfo, now: number): string {
  if (!Number.isFinite(holder.heartbeatAt)) return "no heartbeat recorded";
  const ageMs = now - (holder.heartbeatAt as number);
  const seconds = (Math.abs(ageMs) / 1000).toFixed(1);
  const rendered =
    Number(seconds) < 10
      ? `${seconds}s`
      : `${Math.round(Math.abs(ageMs) / 1000)}s`;
  // A heartbeat from the future is a skewed clock on the recording instance,
  // not a fresh holder; saying which way it is wrong keeps the refusal readable.
  return ageMs < 0
    ? `heartbeat ${rendered} in the future`
    : `heartbeat ${rendered} ago`;
}

/** Human-readable holder description for refusal messages. */
export function describeLockHolder(
  holder: PollerLockInfo,
  now: number = Date.now(),
): string {
  const since = Number.isFinite(holder.startedAt)
    ? new Date(holder.startedAt).toISOString()
    : "unknown time";
  const role = holder.role ?? "unknown role";
  const by = holder.startedBy ? `, started by ${holder.startedBy}` : "";
  const instance =
    typeof holder.instanceId === "string" && holder.instanceId
      ? ` on ${holder.instanceId}`
      : " on an instance that recorded no identity";
  return `pid ${holder.pid}${instance} since ${since} (${role}${by}), ${describeHeartbeatAge(holder, now)}`;
}

/**
 * One sentence per verdict: what the rule saw, and which holder a retry will
 * act on. A refusal an operator cannot classify is a support ticket; the four
 * situations (live holder, holder that stopped heartbeating, dead container,
 * garbled file) have to be tellable apart from the message alone.
 */
export function describeLockReason(
  reason: PollerLockReason,
  path: string,
): string {
  switch (reason) {
    case "held-same-instance":
      return "a live process on this instance holds it and its heartbeat is current, so it is polling, and this acquisition refuses until that heartbeat goes stale";
    case "held-across-namespace":
      return "the holder was recorded by another boot and its heartbeat is current, so it is polling (its pid is not evidence here), and this acquisition refuses until that heartbeat goes stale";
    case "stale-unknown":
      return `the holder records no readable heartbeat, so it cannot be judged live or gone, and this acquisition refuses rather than guess; inspect ${path} and remove it if its holder is finished`;
    case "fresh":
      return "no lock file held the channel";
    case "unreadable-file":
      return "the lock file named no readable holder, so nothing was displaced";
    case "same-pid-refresh":
      return "this process already held the lock";
    case "stale-same-instance":
      return "the holder shares this instance and is no longer polling (dead pid, or a heartbeat past the staleness window)";
    case "stale-across-namespace":
      return "the holder was recorded by another boot and its heartbeat is past the staleness window";
    case "stale-legacy":
      return "the holder was recorded by a build that kept no identity or heartbeat, and its pid is dead, so the channel is free";
    case "stale-legacy-recycled":
      return "the holder was recorded by a build that kept no identity or heartbeat, and the live pid now wearing its number started after that record was written, so it is a recycled pid and not the holder";
    case "held-legacy":
      return `the holder was recorded by a build that kept no identity or heartbeat, so liveness cannot be read from the record, and its pid is still alive; confirm it is not polling, then remove ${path} (a clean disable releases it)`;
  }
}

/** Whether a recorded heartbeat still counts as evidence that its process polls. */
function heartbeatIsCurrent(holder: PollerLockInfo, now: number): boolean {
  if (!Number.isFinite(holder.heartbeatAt)) return false;
  // A skewed or future-stamped heartbeat counts as current: the alternative is
  // displacing a holder that may be polling, which is the worse failure.
  return now - (holder.heartbeatAt as number) <= POLLER_HEARTBEAT_STALE_MS;
}

/**
 * Start time of a live pid in epoch ms, from `ps`. Undefined when ps cannot say:
 * an undated live pid is a refusal, never a takeover.
 */
function readPidStartedAt(pid: number): number | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return undefined;
    const parsed = Date.parse(out);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take the lock. The rule, in order:
 *
 * 1. no readable holder → acquire;
 * 2. this process's own record → acquire (session reload cycles re-arm);
 * 3. same instance, holder's pid dead → acquire, `stale-same-instance`;
 * 4. same instance, pid alive, heartbeat current → refuse `held-same-instance`;
 * 5. same instance, pid alive, heartbeat past the window → acquire,
 *    `stale-same-instance`: a live pid that stopped refreshing is not polling,
 *    and trusting it is what turns a stuck poller into a channel that never
 *    comes back;
 * 6. same instance, pid alive, no readable heartbeat → refuse `stale-unknown`
 *    (no evidence either way, so no guess);
 * 7. another boot or no recorded identity → refuse `held-across-namespace`
 *    while the heartbeat is current, acquire `stale-across-namespace` once it
 *    is not, and refuse `stale-unknown` when no heartbeat can be read at all.
 * 8. a record written before identity existed (`instanceId` absent, so no
 *    heartbeat ever): a dead pid is evidence enough, so acquire `stale-legacy`;
 *    a live pid whose process started later than the record was written is a
 *    recycled pid, so acquire `stale-legacy-recycled`; anything else refuses
 *    `held-legacy` and names the file, because a live pid we cannot date is the
 *    one case where guessing either steals a channel or wedges one.
 */
export function acquirePollerLock(
  path: string,
  stamp: PollerLockStamp,
  options: AcquirePollerLockOptions = {},
): AcquirePollerLockResult {
  const pidAlive = options.pidAlive ?? isPidAlive;
  const pidStartedAt = options.pidStartedAt ?? readPidStartedAt;
  const now = options.now ?? Date.now;
  const at = now();
  const instanceId = stamp.instanceId ?? resolveInstanceId();
  const existing = readPollerLock(path);

  const acquire = (reason: PollerLockTakeoverReason) => {
    writeLock(path, {
      pid: stamp.pid,
      startedAt: stamp.startedAt ?? at,
      instanceId,
      heartbeatAt: at,
      ...(stamp.role === undefined ? {} : { role: stamp.role }),
      ...(stamp.startedBy === undefined ? {} : { startedBy: stamp.startedBy }),
    });
    heldLockPath = path;
    installExitRelease();
    return {
      ok: true as const,
      reason,
      tookOver: existing !== undefined,
      ...(existing === undefined ? {} : { previous: existing }),
    };
  };

  if (existing === undefined) {
    // Distinguish "nothing there" from "something there that named no holder":
    // the second is an operator-visible takeover reason, not a clean start.
    return acquire(existsSync(path) ? "unreadable-file" : "fresh");
  }

  if (existing.instanceId === instanceId) {
    // Own pid first: a reload re-arm must re-take its own lock even though its
    // pid is alive by definition.
    if (existing.pid === stamp.pid) return acquire("same-pid-refresh");
    if (!pidAlive(existing.pid)) return acquire("stale-same-instance");
    if (!Number.isFinite(existing.heartbeatAt)) {
      return { ok: false, reason: "stale-unknown", holder: existing, path };
    }
    if (!heartbeatIsCurrent(existing, at))
      return acquire("stale-same-instance");
    return { ok: false, reason: "held-same-instance", holder: existing, path };
  }

  // A record from a build that had no instance identity and no heartbeat. Its
  // pid is the only field, and it is the field that used to wedge the channel:
  // the arm below read the absent heartbeat as "cannot tell" and refused
  // forever, even when the holder had died days earlier.
  if (existing.instanceId === undefined) {
    if (existing.pid === stamp.pid) return acquire("same-pid-refresh");
    if (!pidAlive(existing.pid)) return acquire("stale-legacy");
    const startedAt = pidStartedAt(existing.pid);
    const recordedAt = Number.isFinite(existing.startedAt)
      ? (existing.startedAt as number)
      : undefined;
    if (
      startedAt !== undefined &&
      recordedAt !== undefined &&
      startedAt - recordedAt > LEGACY_PID_REUSE_SLACK_MS
    ) {
      return acquire("stale-legacy-recycled");
    }
    return { ok: false, reason: "held-legacy", holder: existing, path };
  }

  if (!Number.isFinite(existing.heartbeatAt)) {
    return { ok: false, reason: "stale-unknown", holder: existing, path };
  }
  if (heartbeatIsCurrent(existing, at)) {
    return {
      ok: false,
      reason: "held-across-namespace",
      holder: existing,
      path,
    };
  }
  return acquire("stale-across-namespace");
}

/**
 * Refresh `heartbeatAt` for a lock this process holds. False when the file is
 * gone or names another holder: a beat never rewrites a successor's record.
 */
export function refreshPollerHeartbeat(
  path: string,
  options: { now?: () => number; pid?: number; instanceId?: string } = {},
): boolean {
  const holder = readPollerLock(path);
  if (!holder) return false;
  const pid = options.pid ?? process.pid;
  const instanceId = options.instanceId ?? resolveInstanceId();
  if (holder.pid !== pid || holder.instanceId !== instanceId) return false;
  writeLock(path, { ...holder, heartbeatAt: (options.now ?? Date.now)() });
  return true;
}

/** One running heartbeat: at most one per process, on one lock file. */
export interface PollerHeartbeat {
  readonly path: string;
  /** Refresh now; false once the lock is no longer ours. */
  beat(): boolean;
  /** Stop refreshing. Idempotent. */
  stop(): void;
}

let activeHeartbeat:
  | { path: string; timer: ReturnType<typeof setInterval> }
  | undefined;

/**
 * Refresh the lock's heartbeat on an interval. Replaces any heartbeat already
 * running in this process: one lock, one beat. The timer is unref'd: it serves
 * the lock, never the event loop, so it cannot keep a process alive after the
 * poller it belongs to is gone.
 */
export function startPollerHeartbeat(
  path: string,
  options: { intervalMs?: number; now?: () => number } = {},
): PollerHeartbeat {
  stopPollerHeartbeat();
  const beat = () => refreshPollerHeartbeat(path, { now: options.now });
  const timer = setInterval(
    beat,
    options.intervalMs ?? POLLER_HEARTBEAT_INTERVAL_MS,
  );
  timer.unref?.();
  const entry = { path, timer };
  activeHeartbeat = entry;
  return {
    path,
    beat,
    stop: () => {
      if (activeHeartbeat === entry) activeHeartbeat = undefined;
      clearInterval(timer);
    },
  };
}

/** Stop the running heartbeat, or the one on `path` when given. */
export function stopPollerHeartbeat(path?: string): boolean {
  const entry = activeHeartbeat;
  if (!entry) return false;
  if (path !== undefined && entry.path !== path) return false;
  activeHeartbeat = undefined;
  clearInterval(entry.timer);
  return true;
}

/**
 * Release the lock, and only when this process holds it; a foreign lock is never
 * touched. The heartbeat stops here so a released lock cannot keep being
 * stamped fresh. Best-effort: reports whether the file was removed.
 */
export function releasePollerLock(path: string): boolean {
  const existing = readPollerLock(path);
  const ours =
    existing !== undefined &&
    existing.pid === process.pid &&
    existing.instanceId === resolveInstanceId();
  // An older record without an identity is still ours when the pid is: this
  // process wrote it before the identity field existed only within one run of
  // a single build, so a pid match is the whole evidence available.
  const legacyOurs =
    existing !== undefined &&
    existing.pid === process.pid &&
    existing.instanceId === undefined;
  stopPollerHeartbeat(path);
  if (!existing || !(ours || legacyOurs)) return false;
  try {
    unlinkSync(path);
  } catch {
    // already gone: treat as released
  }
  if (heldLockPath === path) heldLockPath = undefined;
  return true;
}
