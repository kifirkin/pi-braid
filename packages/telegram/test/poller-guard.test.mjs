/**
 * poller-guard.test.mjs — the two ownership nets around the Telegram poller:
 * (1) the session-role gate (BRAID_SESSION_ROLE=worker registers no tool, no
 * command and no turn_end sender, and never starts the poller) and (2) the
 * machine-wide ownership lock, whose liveness is a rule over an instance
 * identity and a heartbeat rather than a bare pid: a holder on another boot is
 * never displaced while it heartbeats, a holder that stopped heartbeating is
 * taken over even while its pid answers alive, and every verdict is reported
 * with a reason an operator can classify. Drives the factory with a fake
 * ExtensionAPI and recorded-fixture fetch, like index.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import telegramExtension, {
  ENV_CHAT_ID,
  ENV_POLL_ENABLED,
  ENV_POLLER_LOCK_FILE,
  ENV_SESSION_ROLE,
  ENV_STATE_FILE,
  ENV_TOKEN,
} from "../dist/index.js";
import {
  acquirePollerLock,
  defaultPollerLockPath,
  describeLockHolder,
  describeLockReason,
  isPidAlive,
  POLLER_HEARTBEAT_INTERVAL_MS,
  POLLER_HEARTBEAT_STALE_MS,
  readPollerLock,
  releasePollerLock,
  releaseHeldLockAtExit,
  resolveInstanceId,
  startPollerHeartbeat,
  stopPollerHeartbeat,
} from "../dist/lib/poller-lock.js";
import { resolveSessionRole } from "../dist/lib/session-role.js";
import { runTelegramSend } from "../dist/lib/tool-logic.js";
import {
  BOT_TOKEN,
  jsonResponse,
  makeFakeFetch,
  sendMessageResult,
} from "./fixtures.mjs";
import { sleep, waitFor } from "./helpers/poll.mjs";

const FOREIGN_PID = 424242;

/** Set process.env for the duration of fn, restoring every prior value after. */
function withEnv(pairs, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(pairs)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === "function") {
    return result.finally(restore);
  }
  restore();
  return result;
}

/** Minimal pi-like surface the factory touches (same shape as index.test.mjs). */
function makeFakePi() {
  const handlers = new Map();
  const messages = [];
  const commands = [];
  const pi = {
    tools: [],
    handlers,
    messages,
    commands,
    registerTool: (tool) => pi.tools.push(tool),
    registerCommand: (name, options) => pi.commands.push({ name, ...options }),
    sendUserMessage: (...args) => messages.push(args),
    on: (event, fn) =>
      handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    emit: (event, ...args) => {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
  };
  return pi;
}

function tmpPath(prefix) {
  const dir = join(
    tmpdir(),
    `tg-guard-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return join(dir, "state.json");
}

function tmpLockFile(prefix) {
  return tmpPath(`lock-${prefix}`);
}

/** Fake fetch answering every request with an empty getUpdates result. */
function emptyUpdatesFetch() {
  return makeFakeFetch(async () => jsonResponse({ ok: true, result: [] }));
}

/** Base env every factory test needs: token, tmp state, tmp lock, chat id. */
function baseEnv(overrides = {}) {
  return {
    [ENV_TOKEN]: BOT_TOKEN,
    TELEGRAM_BOT_TOKEN: undefined,
    [ENV_STATE_FILE]: tmpPath("state"),
    TELEGRAM_STATE_FILE: undefined,
    [ENV_POLLER_LOCK_FILE]: tmpLockFile("default"),
    TELEGRAM_POLLER_LOCK_FILE: undefined,
    [ENV_CHAT_ID]: "999888777",
    TELEGRAM_CHAT_ID: undefined,
    [ENV_SESSION_ROLE]: undefined,
    BRAID_TG_LIVE_UPDATE_STATE_FILE: tmpPath("live"),
    ...overrides,
  };
}

/** Pre-write a lock file as if `info` holds it. */
function writeLock(path, info) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(info));
}

test("resolveSessionRole: unset/seat/other keep the seat default; 'worker' (any case/spacing) selects worker", () => {
  assert.equal(resolveSessionRole({}), "seat");
  assert.equal(resolveSessionRole({ [ENV_SESSION_ROLE]: "seat" }), "seat");
  assert.equal(resolveSessionRole({ [ENV_SESSION_ROLE]: "worker" }), "worker");
  assert.equal(
    resolveSessionRole({ [ENV_SESSION_ROLE]: " WORKER " }),
    "worker",
  );
  assert.equal(
    resolveSessionRole({ [ENV_SESSION_ROLE]: "orchestrator" }),
    "seat",
  );
});

test("isPidAlive: own pid alive, impossible pid dead", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(99999999), false); // beyond every real pid_max
});

// ── Acquisition arms: identity and heartbeat, not a bare pid ───────────────
// The clock and the liveness predicate are injected, so each arm is decided by
// arithmetic over a fixture rather than by this machine's process table (the
// one arm that asserts about a real pid says so and uses the real probe).

const INSTANCE = "testhost:test-boot";
const FOREIGN_INSTANCE = "otherhost:other-boot";
const IMPOSSIBLE_PID = 99999999; // beyond every real pid_max
const OTHER_PID = process.pid + 1; // a different pid than ours
const CLOCK = 1_700_000_000_000;

/** Fixed clock: heartbeat freshness is a subtraction, not a sleep. */
function fixedClock(start = CLOCK) {
  let at = start;
  return {
    now: () => at,
    set: (value) => {
      at = value;
    },
  };
}

test("lock acquire: no holder takes the lock fresh and stamps identity and heartbeat", () => {
  const path = tmpLockFile("arm-empty");
  const clock = fixedClock();
  const res = acquirePollerLock(
    path,
    {
      pid: process.pid,
      instanceId: INSTANCE,
      role: "seat",
      startedBy: "/telegram enable",
    },
    { now: clock.now, pidAlive: () => false },
  );
  assert.deepEqual(res, { ok: true, reason: "fresh", tookOver: false });
  assert.deepEqual(readPollerLock(path), {
    pid: process.pid,
    startedAt: CLOCK,
    instanceId: INSTANCE,
    heartbeatAt: CLOCK,
    role: "seat",
    startedBy: "/telegram enable",
  });
});

test("lock acquire: same instance, different live pid, current heartbeat refuses as held", () => {
  const path = tmpLockFile("arm-same-fresh");
  const clock = fixedClock();
  writeLock(path, {
    pid: OTHER_PID,
    startedAt: CLOCK - 9_000,
    instanceId: INSTANCE,
    heartbeatAt: CLOCK - 1_000,
    role: "seat",
    startedBy: "orchestrator seat",
  });
  const before = readFileSync(path, "utf8");
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    { now: clock.now, pidAlive: (pid) => pid === OTHER_PID },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "held-same-instance");
  assert.equal(res.holder.pid, OTHER_PID);
  assert.equal(res.path, path);
  const named = describeLockHolder(res.holder, CLOCK);
  assert.match(named, new RegExp(`pid ${OTHER_PID}`));
  assert.ok(
    named.includes(INSTANCE),
    `the refusal names the holder's identity: ${named}`,
  );
  assert.match(named, /heartbeat 1\.0s ago/);
  assert.match(
    describeLockReason(res.reason, path),
    /refuses until that heartbeat goes stale/,
  );
  assert.equal(
    readFileSync(path, "utf8"),
    before,
    "a refused acquirer never rewrites the holder's file",
  );
});

test("lock acquire: same instance, holder pid dead, takes over with a reported reason", () => {
  const path = tmpLockFile("arm-same-dead");
  const clock = fixedClock();
  writeLock(path, {
    pid: IMPOSSIBLE_PID,
    startedAt: CLOCK - 5_000,
    instanceId: INSTANCE,
    heartbeatAt: CLOCK - 500, // fresh, and still displaced: the pid is dead
  });
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    { now: clock.now, pidAlive: () => false },
  );
  assert.equal(res.ok, true);
  assert.equal(res.reason, "stale-same-instance");
  assert.equal(res.tookOver, true);
  assert.equal(res.previous.pid, IMPOSSIBLE_PID);
  assert.equal(readPollerLock(path).pid, process.pid);
});

test("lock acquire: same instance, pid alive, heartbeat past the window takes over", () => {
  const path = tmpLockFile("arm-same-stale");
  const clock = fixedClock();
  // process.ppid is genuinely alive in this namespace and is not this process.
  assert.equal(isPidAlive(process.ppid), true);
  writeLock(path, {
    pid: process.ppid,
    startedAt: CLOCK - 120_000,
    instanceId: INSTANCE,
    heartbeatAt: CLOCK - POLLER_HEARTBEAT_STALE_MS - 1,
    role: "seat",
  });
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    { now: clock.now },
  );
  assert.equal(res.ok, true);
  assert.equal(res.reason, "stale-same-instance");
  assert.equal(res.tookOver, true);
  assert.equal(
    isPidAlive(process.ppid),
    true,
    "a live pid whose heartbeat stopped is not polling: the takeover has to happen while the process table still answers alive",
  );
  assert.equal(readPollerLock(path).pid, process.pid);
});

test("lock acquire: the staleness window is the named constant, edge included", () => {
  const clock = fixedClock();
  const at = (age) => {
    const path = tmpLockFile("arm-window");
    writeLock(path, {
      pid: OTHER_PID,
      startedAt: CLOCK - 200_000,
      instanceId: INSTANCE,
      heartbeatAt: CLOCK - age,
    });
    return acquirePollerLock(
      path,
      { pid: process.pid, instanceId: INSTANCE },
      { now: clock.now, pidAlive: () => true },
    );
  };
  // Inside the window (and exactly on it) the holder still counts as polling.
  assert.equal(at(POLLER_HEARTBEAT_STALE_MS - 1).ok, false);
  assert.equal(at(POLLER_HEARTBEAT_STALE_MS).ok, false);
  // One millisecond past it, the same pid stops counting.
  assert.equal(at(POLLER_HEARTBEAT_STALE_MS + 1).ok, true);
});

test("lock acquire: self re-acquire wins while the same pid is recorded (reload re-arm)", () => {
  const path = tmpLockFile("arm-self");
  const clock = fixedClock();
  const first = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE, startedBy: "first" },
    { now: clock.now },
  );
  assert.equal(first.reason, "fresh");
  clock.set(CLOCK + 2_000);
  const second = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE, startedBy: "reload" },
    { now: clock.now },
  );
  assert.equal(second.ok, true);
  assert.equal(second.reason, "same-pid-refresh");
  assert.equal(second.tookOver, true);
  assert.equal(readPollerLock(path).heartbeatAt, CLOCK + 2_000);
});

test("lock acquire: another boot's holder with a current heartbeat is never displaced", () => {
  const path = tmpLockFile("arm-foreign-fresh");
  const clock = fixedClock();
  // The pid is dead here — which is exactly the evidence that says nothing
  // about a holder recorded on another boot. Only the heartbeat does.
  writeLock(path, {
    pid: IMPOSSIBLE_PID,
    startedAt: CLOCK - 3_000,
    instanceId: FOREIGN_INSTANCE,
    heartbeatAt: CLOCK - 2_000,
    role: "seat",
  });
  const before = readFileSync(path, "utf8");
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    { now: clock.now, pidAlive: () => false },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "held-across-namespace");
  assert.equal(res.holder.instanceId, FOREIGN_INSTANCE);
  assert.match(
    describeLockReason(res.reason, path),
    /its pid is not evidence here/,
  );
  assert.equal(readFileSync(path, "utf8"), before);
});

test("lock acquire: another boot's holder past the window is taken over", () => {
  const path = tmpLockFile("arm-foreign-stale");
  const clock = fixedClock();
  writeLock(path, {
    pid: IMPOSSIBLE_PID,
    startedAt: CLOCK - 90_000,
    instanceId: FOREIGN_INSTANCE,
    heartbeatAt: CLOCK - POLLER_HEARTBEAT_STALE_MS - 5_000,
    role: "seat",
  });
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    { now: clock.now, pidAlive: () => false },
  );
  assert.equal(res.ok, true);
  assert.equal(res.reason, "stale-across-namespace");
  assert.equal(res.tookOver, true);
  assert.equal(res.previous.instanceId, FOREIGN_INSTANCE);
  assert.equal(readPollerLock(path).instanceId, INSTANCE);
});

test("lock acquire: a heartbeat from the future counts as current, so a skewed clock cannot displace a holder", () => {
  const path = tmpLockFile("arm-skew");
  const clock = fixedClock();
  writeLock(path, {
    pid: IMPOSSIBLE_PID,
    startedAt: CLOCK,
    instanceId: FOREIGN_INSTANCE,
    heartbeatAt: CLOCK + 5_000,
  });
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    { now: clock.now, pidAlive: () => false },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "held-across-namespace");
  assert.match(
    describeLockHolder(res.holder, CLOCK),
    /heartbeat 5\.0s in the future/,
  );
});

test("lock acquire: an unreadable heartbeat on another boot refuses and names the file", () => {
  const path = tmpLockFile("arm-unknown");
  const clock = fixedClock();
  writeLock(path, {
    pid: IMPOSSIBLE_PID,
    startedAt: CLOCK - 60_000,
    instanceId: FOREIGN_INSTANCE,
  });
  const before = readFileSync(path, "utf8");
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    { now: clock.now, pidAlive: () => false },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "stale-unknown");
  assert.ok(
    describeLockReason(res.reason, path).includes(path),
    "the refusal names the file an operator has to inspect",
  );
  assert.match(describeLockHolder(res.holder, CLOCK), /no heartbeat recorded/);
  assert.equal(
    readFileSync(path, "utf8"),
    before,
    "an unreadable file is never guessed away",
  );
});

test("lock acquire: a garbled heartbeat on another boot reads as unknown, not as stale", () => {
  const path = tmpLockFile("arm-garbled");
  const clock = fixedClock();
  writeLock(path, {
    pid: IMPOSSIBLE_PID,
    startedAt: CLOCK - 60_000,
    instanceId: FOREIGN_INSTANCE,
    heartbeatAt: "not-a-timestamp",
  });
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    { now: clock.now, pidAlive: () => false },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "stale-unknown");
});

test("lock acquire: a record without identity is judged by its pid, and a live holder still refuses", () => {
  const path = tmpLockFile("arm-legacy");
  const clock = fixedClock();
  // An older writer's file: no instanceId, no heartbeatAt. Its pid is the only
  // field, so a live pid is the only thing that can stop a takeover; a dead or
  // recycled one is taken over by the legacy arm and its fixtures.
  writeLock(path, {
    pid: process.ppid,
    startedAt: CLOCK - 60_000,
    role: "seat",
  });
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    {
      now: clock.now,
      pidAlive: () => true,
      pidStartedAt: () => CLOCK - 60_000 - 200,
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "held-legacy");
  assert.match(describeLockHolder(res.holder, CLOCK), /no identity/);
});

test("lock acquire: a file that names no holder is taken over with a reported reason", () => {
  const path = tmpLockFile("arm-corrupt");
  const clock = fixedClock();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{not json");
  assert.equal(readPollerLock(path), undefined);
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    { now: clock.now },
  );
  assert.equal(res.ok, true);
  assert.equal(res.reason, "unreadable-file");
  assert.equal(res.tookOver, false); // no holder was recorded, so none was displaced
  assert.equal(readPollerLock(path).instanceId, INSTANCE);
});

test("lock: release removes only our own lock", () => {
  const ours = tmpLockFile("release-ours");
  const foreign = tmpLockFile("release-foreign");
  writeLock(ours, { pid: process.pid, startedAt: 1 });
  writeLock(foreign, {
    pid: FOREIGN_PID,
    startedAt: 1,
    instanceId: FOREIGN_INSTANCE,
    heartbeatAt: Date.now(),
  });
  assert.equal(releasePollerLock(ours), true);
  assert.equal(existsSync(ours), false);
  assert.equal(releasePollerLock(foreign), false); // foreign lock untouched
  assert.equal(existsSync(foreign), true);
});

test("worker role: no tool, no command, no turn_end sender", async () => {
  const pi = makeFakePi();
  await withEnv(baseEnv({ [ENV_SESSION_ROLE]: "worker" }), async () => {
    await telegramExtension(pi, { fetch: emptyUpdatesFetch() });
  });
  assert.deepEqual(pi.tools, []);
  assert.deepEqual(pi.commands, []);
  assert.deepEqual(
    [...pi.handlers.keys()].sort(),
    ["session_shutdown", "session_start"],
    "the pre-gate TUI log sink is the only handler left; the turn_end senders are absent",
  );
});

test("worker role: env auto-start is suppressed — no poll, no lock file", async () => {
  const env = baseEnv({
    [ENV_SESSION_ROLE]: "worker",
    [ENV_POLL_ENABLED]: "1",
  });
  const fetchFn = emptyUpdatesFetch();
  const pi = makeFakePi();
  await withEnv(env, async () => {
    await telegramExtension(pi, { fetch: fetchFn });
  });
  await sleep(150);
  assert.equal(
    fetchFn.calls.length,
    0,
    "worker role must never engage the getUpdates long-poll",
  );
  assert.equal(
    existsSync(env[ENV_POLLER_LOCK_FILE]),
    false,
    "worker role must never take the ownership lock",
  );
});

test("no marker (seat default): all three tools, warn still advises telegram_poller", async () => {
  const pi = makeFakePi();
  await withEnv(baseEnv(), async () => {
    await telegramExtension(pi, { fetch: emptyUpdatesFetch() });
  });
  assert.deepEqual(pi.tools.map((t) => t.name).sort(), [
    "telegram_inbox",
    "telegram_poller",
    "telegram_send",
  ]);

  const fetchFn = makeFakeFetch(async () => jsonResponse(sendMessageResult(8)));
  const pi2 = makeFakePi();
  await withEnv(baseEnv(), async () => {
    await telegramExtension(pi2, { fetch: fetchFn });
    const send = pi2.tools.find((t) => t.name === "telegram_send");
    const r = await send.execute("id", { text: "hello" }, undefined, undefined);
    const outcome = JSON.parse(r.content[0].text);
    assert.match(outcome.warn, /enable via telegram_poller action=enable/);
  });
});

test("seat enable refused while another boot's holder keeps its heartbeat current", async () => {
  const lockFile = tmpLockFile("live-holder");
  const env = baseEnv({ [ENV_POLLER_LOCK_FILE]: lockFile });
  // Dead pid here, current heartbeat: the shape a live holder in another
  // container has. A pid-only check would displace it and put two pollers on
  // one bot, so this is the case the refusal exists for.
  writeLock(lockFile, {
    pid: FOREIGN_PID,
    startedAt: Date.now() - 4_000,
    instanceId: FOREIGN_INSTANCE,
    heartbeatAt: Date.now() - 1_500,
    role: "seat",
    startedBy: "orchestrator seat",
  });
  const fetchFn = emptyUpdatesFetch();
  const pi = makeFakePi();
  await withEnv(env, async () => {
    await telegramExtension(pi, {
      fetch: fetchFn,
      pidAlive: () => false,
    });
    const poller = pi.tools.find((t) => t.name === "telegram_poller");
    const r = await poller.execute(
      "id",
      { action: "enable" },
      undefined,
      undefined,
    );
    assert.equal(r.details.ok, false);
    assert.equal(r.details.running, false);
    // The refusal names the holder: pid, its boot, its heartbeat age, and
    // which rule decision this is.
    assert.match(r.details.error, /pid 424242/);
    assert.ok(r.details.error.includes(FOREIGN_INSTANCE));
    assert.match(r.details.error, /heartbeat 1\.\ds ago/);
    assert.match(r.details.error, /its pid is not evidence here/);
    assert.equal(r.details.reason, "held-across-namespace");
    assert.equal(r.details.lockFile, lockFile);
    assert.equal(r.details.holder.pid, FOREIGN_PID);
    await sleep(120);
    assert.equal(
      fetchFn.calls.length,
      0,
      "a refused enable must not long-poll",
    );
    assert.equal(
      readPollerLock(lockFile).pid,
      FOREIGN_PID,
      "refused acquirer must not rewrite the holder's lock",
    );
  });
});

test("seat enable takes over a lock whose heartbeat stopped on another boot", async () => {
  const lockFile = tmpLockFile("stale-takeover");
  const env = baseEnv({ [ENV_POLLER_LOCK_FILE]: lockFile });
  writeLock(lockFile, {
    pid: FOREIGN_PID,
    startedAt: Date.now() - 600_000,
    instanceId: FOREIGN_INSTANCE,
    heartbeatAt: Date.now() - POLLER_HEARTBEAT_STALE_MS - 30_000,
    role: "worker",
    startedBy: "some dead worker",
  });
  const fetchFn = emptyUpdatesFetch();
  const pi = makeFakePi();
  await withEnv(env, async () => {
    await telegramExtension(pi, { fetch: fetchFn, pidAlive: () => false });
    const poller = pi.tools.find((t) => t.name === "telegram_poller");
    const r = await poller.execute(
      "id",
      { action: "enable" },
      undefined,
      undefined,
    );
    assert.equal(r.details.ok, true);
    assert.equal(r.details.running, true);
    assert.deepEqual(r.details.lock, {
      tookOver: true,
      reason: "stale-across-namespace",
    });
    await waitFor(
      () => fetchFn.calls.some((c) => c.url.includes("getUpdates")),
      2000,
    );
    assert.equal(
      readPollerLock(lockFile).pid,
      process.pid,
      "the takeover must record the new holder",
    );
    assert.equal(
      readPollerLock(lockFile).instanceId,
      resolveInstanceId(),
      "the new holder stamps its own boot",
    );
    pi.emit("session_shutdown");
    await sleep(50);
  });
});

test("seat enable takes over this instance's lock after the holder stopped heartbeating", async () => {
  const lockFile = tmpLockFile("dead-poller");
  const env = baseEnv({ [ENV_POLLER_LOCK_FILE]: lockFile });
  // The crash-in-process shape: the pid still answers alive (a live sibling
  // process), the heartbeat stopped. Refusing on the pid alone is what turns
  // this into a channel that never comes back.
  writeLock(lockFile, {
    pid: process.ppid,
    startedAt: Date.now() - 600_000,
    instanceId: resolveInstanceId(),
    heartbeatAt: Date.now() - POLLER_HEARTBEAT_STALE_MS - 1_000,
    role: "seat",
  });
  const fetchFn = emptyUpdatesFetch();
  const pi = makeFakePi();
  await withEnv(env, async () => {
    await telegramExtension(pi, { fetch: fetchFn });
    const poller = pi.tools.find((t) => t.name === "telegram_poller");
    const r = await poller.execute(
      "id",
      { action: "enable" },
      undefined,
      undefined,
    );
    assert.equal(r.details.ok, true);
    assert.deepEqual(r.details.lock, {
      tookOver: true,
      reason: "stale-same-instance",
    });
    assert.equal(readPollerLock(lockFile).pid, process.pid);
    pi.emit("session_shutdown");
    await sleep(50);
  });
});

test("seat: disable releases the lock, re-enable keeps working", async () => {
  const lockFile = tmpLockFile("re-enable");
  const env = baseEnv({ [ENV_POLLER_LOCK_FILE]: lockFile });
  const fetchFn = emptyUpdatesFetch();
  const pi = makeFakePi();
  await withEnv(env, async () => {
    await telegramExtension(pi, { fetch: fetchFn });
    const poller = pi.tools.find((t) => t.name === "telegram_poller");
    const r1 = await poller.execute(
      "id",
      { action: "enable" },
      undefined,
      undefined,
    );
    assert.equal(r1.details.ok, true);
    assert.equal(existsSync(lockFile), true, "running poller holds the lock");
    const held = readPollerLock(lockFile);
    assert.equal(held.instanceId, resolveInstanceId());
    assert.ok(
      Number.isFinite(held.heartbeatAt),
      "the running poller stamps a heartbeat another boot can read",
    );
    const r2 = await poller.execute(
      "id",
      { action: "disable" },
      undefined,
      undefined,
    );
    assert.equal(r2.details.wasRunning, true);
    assert.equal(existsSync(lockFile), false, "disable releases the lock");
    const r3 = await poller.execute(
      "id",
      { action: "enable" },
      undefined,
      undefined,
    );
    assert.equal(r3.details.ok, true);
    assert.equal(r3.details.running, true);
    pi.emit("session_shutdown");
    await sleep(50);
  });
});

test("seat: reload re-arm re-acquires its own pid's lock without release", async () => {
  const lockFile = tmpLockFile("rearm");
  const env = baseEnv({ [ENV_POLLER_LOCK_FILE]: lockFile });
  const fetchFn = emptyUpdatesFetch();
  const pi = makeFakePi();
  await withEnv(env, async () => {
    await telegramExtension(pi, { fetch: fetchFn });
    const poller = pi.tools.find((t) => t.name === "telegram_poller");
    await poller.execute("id", { action: "enable" }, undefined, undefined);
    const callsAfterEnable = fetchFn.calls.length;

    // reload(): session_shutdown stops the poller but the lock STAYS (our
    // pid) — then session_start re-arms with fresh bindings.
    pi.emit("session_shutdown");
    await sleep(50);
    assert.equal(readPollerLock(lockFile).pid, process.pid);
    pi.emit("session_start", {}, undefined);
    await waitFor(() => fetchFn.calls.length > callsAfterEnable, 2000);
    assert.equal(readPollerLock(lockFile).pid, process.pid);
    pi.emit("session_shutdown");
    await sleep(50);
  });
});

test("seat /telegram enable refused under another boot's holder names pid and heartbeat", async () => {
  const lockFile = tmpLockFile("seat-cmd");
  const env = baseEnv({ [ENV_POLLER_LOCK_FILE]: lockFile });
  writeLock(lockFile, {
    pid: FOREIGN_PID,
    startedAt: Date.now() - 2_000,
    instanceId: FOREIGN_INSTANCE,
    heartbeatAt: Date.now() - 500,
    role: "seat",
  });
  const pi = makeFakePi();
  const notices = [];
  const ctx = { ui: { notify: (m, t) => notices.push([m, t]) } };
  await withEnv(env, async () => {
    await telegramExtension(pi, {
      fetch: emptyUpdatesFetch(),
      pidAlive: () => false,
    });
    await pi.commands[0].handler("enable", ctx);
    const [msg, type] = notices.at(-1);
    assert.match(msg, /pid 424242/);
    assert.match(msg, /heartbeat 0\.\ds ago/);
    assert.equal(type, "error");
  });
});

test("default lock path resolves beside the braid telegram state (BRAID_HOME-overridable)", () => {
  const saved = process.env.BRAID_HOME;
  try {
    process.env.BRAID_HOME = "/tmp/braid-home-pin";
    assert.equal(
      defaultPollerLockPath(),
      join("/tmp/braid-home-pin", "telegram-poller.lock"),
    );
  } finally {
    if (saved === undefined) delete process.env.BRAID_HOME;
    else process.env.BRAID_HOME = saved;
  }
});

test("runTelegramSend workerRole swap is purely the warn text", async () => {
  const client = {
    sendMessage: async () => ({ ok: true, messageId: 1 }),
    sendVoiceNote: async () => ({ ok: true, messageId: 1 }),
  };
  const deps = {
    client,
    token: BOT_TOKEN,
    chatId: 1,
    pollerRunning: () => false,
  };
  const worker = await runTelegramSend(
    { text: "hi" },
    { ...deps, workerRole: true },
  );
  const seat = await runTelegramSend({ text: "hi" }, deps);
  assert.match(worker.warn, /orchestrator seat owns/);
  assert.doesNotMatch(worker.warn, /enable via/);
  assert.match(seat.warn, /enable via telegram_poller action=enable/);
});

test("exit hook: releases our own lock", () => {
  const path = tmpLockFile("exit-ours");
  acquirePollerLock(path, { pid: process.pid, startedAt: 10 });
  assert.equal(existsSync(path), true);
  releaseHeldLockAtExit();
  assert.equal(existsSync(path), false);
});

test("exit hook: never removes a lock a successor has taken over", () => {
  const path = tmpLockFile("exit-successor");
  acquirePollerLock(path, { pid: process.pid, startedAt: 11 });
  // The handover: another seat acquires the channel while this process lives.
  writeLock(path, { pid: FOREIGN_PID, startedAt: 12 });
  releaseHeldLockAtExit();
  assert.equal(
    existsSync(path),
    true,
    "the successor's lock survives our exit",
  );
  assert.equal(readPollerLock(path).pid, FOREIGN_PID);
});

// ── Heartbeat: the half of the rule that a process table cannot answer ─────

test("heartbeat: refreshes the stamp on the interval and stops when told", async () => {
  const path = tmpLockFile("beat-tick");
  const clock = fixedClock();
  acquirePollerLock(path, { pid: process.pid }, { now: clock.now });
  const beat = startPollerHeartbeat(path, { intervalMs: 15, now: clock.now });
  clock.set(CLOCK + 40_000);
  await waitFor(
    () => readPollerLock(path)?.heartbeatAt === CLOCK + 40_000,
    2000,
  );
  beat.stop();
  clock.set(CLOCK + 90_000);
  await sleep(80);
  assert.equal(
    readPollerLock(path).heartbeatAt,
    CLOCK + 40_000,
    "a stopped heartbeat leaves the last stamp alone",
  );
});

test("heartbeat: a beat never overwrites a successor's record", () => {
  const path = tmpLockFile("beat-successor");
  const clock = fixedClock();
  acquirePollerLock(path, { pid: process.pid }, { now: clock.now });
  const beat = startPollerHeartbeat(path, {
    now: clock.now,
    intervalMs: 60_000,
  });
  writeLock(path, {
    pid: FOREIGN_PID,
    startedAt: CLOCK,
    instanceId: FOREIGN_INSTANCE,
    heartbeatAt: CLOCK,
  });
  clock.set(CLOCK + 5_000);
  assert.equal(beat.beat(), false, "the lock is no longer ours");
  assert.equal(readPollerLock(path).pid, FOREIGN_PID);
  assert.equal(readPollerLock(path).heartbeatAt, CLOCK);
  beat.stop();
});

test("heartbeat: release stops the beat and the lock cannot be re-stamped", () => {
  const path = tmpLockFile("beat-release");
  const clock = fixedClock();
  acquirePollerLock(path, { pid: process.pid }, { now: clock.now });
  const beat = startPollerHeartbeat(path, {
    now: clock.now,
    intervalMs: 60_000,
  });
  assert.equal(releasePollerLock(path), true);
  assert.equal(existsSync(path), false);
  assert.equal(beat.beat(), false, "a released lock cannot be re-stamped");
  assert.equal(
    stopPollerHeartbeat(path),
    false,
    "release already stopped the beat",
  );
});

test("heartbeat: three refreshes fit inside the staleness window", () => {
  assert.equal(POLLER_HEARTBEAT_INTERVAL_MS, 10_000);
  assert.equal(POLLER_HEARTBEAT_STALE_MS, 30_000);
  assert.ok(
    POLLER_HEARTBEAT_INTERVAL_MS * 3 <= POLLER_HEARTBEAT_STALE_MS,
    "one late tick must not cost a live holder the channel",
  );
});

test("heartbeat: an unref'd timer leaves the process free to exit while the lock is held", () => {
  const path = tmpLockFile("beat-exit");
  const moduleUrl = new URL("../dist/lib/poller-lock.js", import.meta.url).href;
  const script = [
    `import { acquirePollerLock, startPollerHeartbeat } from ${JSON.stringify(moduleUrl)};`,
    `const res = acquirePollerLock(${JSON.stringify(path)}, { pid: process.pid });`,
    `if (!res.ok) { console.error("refused: " + res.reason); process.exit(3); }`,
    `startPollerHeartbeat(${JSON.stringify(path)}, { intervalMs: 10 });`,
    `console.log("armed");`,
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(
    child.signal,
    null,
    `the child had to be killed, so the heartbeat held the event loop open: ${child.stderr}`,
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /armed/);
  assert.equal(
    existsSync(path),
    false,
    "the exit hook released the lock on the way out",
  );
});

// ── the legacy arm ────────────────────────────────────────────────────────────
//
// A lock written before identity existed carries a pid and nothing else. The
// rule used to read the missing heartbeat as "cannot judge" and refuse forever,
// so a process that died left the channel down until a human deleted a file. The
// arm below judges the pid, which is the only field such a record has, and it
// refuses only when a live pid could still be the holder.

test("lock acquire: a pre-identity record whose pid is dead is taken over, not refused forever", () => {
  const path = tmpLockFile("legacy-dead-pid");
  const clock = fixedClock();
  // The shape 0.43.21 wrote: pid, startedAt, role, startedBy, and no more.
  writeLock(path, {
    pid: IMPOSSIBLE_PID,
    startedAt: CLOCK - 3_600_000,
    role: "seat",
    startedBy: "telegram_poller tool",
  });
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    { now: clock.now, pidAlive: () => false },
  );
  assert.equal(res.ok, true);
  assert.equal(res.reason, "stale-legacy");
  assert.equal(res.tookOver, true);
  assert.equal(res.previous.pid, IMPOSSIBLE_PID);
  const now = readPollerLock(path);
  assert.equal(now.pid, process.pid);
  assert.equal(
    now.instanceId,
    INSTANCE,
    "the takeover upgrades the record to the identity shape, so the next seat does not meet a legacy file again",
  );
  assert.equal(Number.isFinite(now.heartbeatAt), true);
});

test("lock acquire: a pre-identity record whose pid was recycled by a later process is taken over", () => {
  const path = tmpLockFile("legacy-recycled");
  const clock = fixedClock();
  writeLock(path, {
    pid: process.ppid,
    startedAt: CLOCK - 7_200_000,
    role: "seat",
  });
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    {
      now: clock.now,
      pidAlive: () => true,
      pidStartedAt: () => CLOCK - 60_000,
    },
  );
  assert.equal(res.ok, true);
  assert.equal(res.reason, "stale-legacy-recycled");
  assert.match(
    describeLockReason(res.reason, path),
    /started after that record was written/,
    "the reason has to say why a live pid did not block the takeover",
  );
});

test("lock acquire: a pre-identity record with a dated live holder refuses and names the file", () => {
  const path = tmpLockFile("legacy-live");
  const clock = fixedClock();
  writeLock(path, {
    pid: process.ppid,
    startedAt: CLOCK - 7_200_000,
    role: "seat",
  });
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    {
      now: clock.now,
      pidAlive: () => true,
      pidStartedAt: () => CLOCK - 7_200_000 - 500,
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "held-legacy");
  assert.equal(res.path, path);
  const message = describeLockReason(res.reason, path);
  assert.match(message, /pid is still alive/);
  assert.equal(
    message.includes(path),
    true,
    "the operator is told which file to remove",
  );
  assert.equal(
    readPollerLock(path).pid,
    process.ppid,
    "a refusal writes nothing",
  );
});

test("lock acquire: an undatable live pid on a pre-identity record refuses rather than guess", () => {
  const path = tmpLockFile("legacy-undated");
  const clock = fixedClock();
  writeLock(path, {
    pid: process.ppid,
    startedAt: CLOCK - 7_200_000,
    role: "seat",
  });
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    { now: clock.now, pidAlive: () => true, pidStartedAt: () => undefined },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "held-legacy");
});

test("lock acquire: control — a cross-boot record that DOES carry identity but no heartbeat still refuses stale-unknown", () => {
  const path = tmpLockFile("legacy-control-cross-boot");
  const clock = fixedClock();
  writeLock(path, {
    pid: process.ppid,
    startedAt: CLOCK - 1_000,
    instanceId: "otherhost:other-boot",
    role: "seat",
  });
  const res = acquirePollerLock(
    path,
    { pid: process.pid, instanceId: INSTANCE },
    { now: clock.now, pidAlive: () => true, pidStartedAt: () => CLOCK - 1_000 },
  );
  assert.equal(
    res.ok,
    false,
    "the legacy arm must not swallow the case it was never about",
  );
  assert.equal(res.reason, "stale-unknown");
});
