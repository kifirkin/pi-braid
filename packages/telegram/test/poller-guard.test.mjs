/**
 * poller-guard.test.mjs — the two ownership nets around the Telegram poller:
 * (1) the session-role gate (BRAID_SESSION_ROLE=worker registers only
 * telegram_send, never starts the poller, and the dead-poller warn does not
 * advise enabling it) and (2) the machine-wide ownership lock (a live
 * foreign pid refuses, a stale lock is taken over, disable releases, and a
 * seat's re-enable / reload re-arm keeps working). Drives the factory with
 * a fake ExtensionAPI and recorded-fixture fetch, like index.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  isPidAlive,
  readPollerLock,
  releasePollerLock,
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

test("lock: fresh acquire writes pid/startedAt/role/startedBy", () => {
  const path = tmpLockFile("fresh");
  const res = acquirePollerLock(path, {
    pid: process.pid,
    startedAt: 1234,
    role: "seat",
    startedBy: "/telegram enable",
  });
  assert.deepEqual(res, { ok: true, tookOver: false });
  assert.deepEqual(readPollerLock(path), {
    pid: process.pid,
    startedAt: 1234,
    role: "seat",
    startedBy: "/telegram enable",
  });
});

test("lock: live foreign holder refuses with holder named, file untouched", () => {
  const path = tmpLockFile("foreign");
  writeLock(path, {
    pid: FOREIGN_PID,
    startedAt: 1700000000000,
    role: "seat",
    startedBy: "orchestrator seat",
  });
  const res = acquirePollerLock(
    path,
    { pid: process.pid, startedAt: 9999, role: "worker" },
    (pid) => pid === FOREIGN_PID,
  );
  assert.equal(res.ok, false);
  assert.equal(res.holder.pid, FOREIGN_PID);
  assert.equal(res.holder.startedBy, "orchestrator seat");
  // The refusal names pid, since, and role/session.
  assert.match(describeLockHolder(res.holder), /pid 424242/);
  assert.match(describeLockHolder(res.holder), /orchestrator seat/);
  // The foreign lock is intact — never rewritten by a refused acquirer.
  assert.equal(readPollerLock(path).pid, FOREIGN_PID);
});

test("lock: stale (dead pid) holder is taken over silently", () => {
  const path = tmpLockFile("stale");
  writeLock(path, { pid: FOREIGN_PID, startedAt: 1, role: "seat" });
  const res = acquirePollerLock(
    path,
    { pid: process.pid, startedAt: 2, role: "seat" },
    () => false,
  );
  assert.deepEqual(res, { ok: true, tookOver: true });
  assert.equal(readPollerLock(path).pid, process.pid);
});

test("lock: corrupt file is taken over; own pid re-acquire refreshes", () => {
  const path = tmpLockFile("corrupt");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{not json");
  assert.equal(readPollerLock(path), undefined);
  assert.deepEqual(
    acquirePollerLock(path, { pid: process.pid, startedAt: 3 }),
    { ok: true, tookOver: false }, // corrupt file reads as "no holder"
  );
  // Own pid: a reload-cycle re-acquire must succeed even though the file
  // names a live pid.
  assert.deepEqual(
    acquirePollerLock(path, { pid: process.pid, startedAt: 4 }),
    { ok: true, tookOver: true },
  );
  assert.equal(readPollerLock(path).startedAt, 4);
});

test("lock: release removes only our own lock", () => {
  const ours = tmpLockFile("release-ours");
  const foreign = tmpLockFile("release-foreign");
  writeLock(ours, { pid: process.pid, startedAt: 1 });
  writeLock(foreign, { pid: FOREIGN_PID, startedAt: 1 });
  assert.equal(releasePollerLock(ours), true);
  assert.equal(existsSync(ours), false);
  assert.equal(releasePollerLock(foreign), false); // foreign lock untouched
  assert.equal(existsSync(foreign), true);
});

test("worker role: only telegram_send registered; poller and inbox absent", async () => {
  const pi = makeFakePi();
  await withEnv(baseEnv({ [ENV_SESSION_ROLE]: "worker" }), async () => {
    await telegramExtension(pi, { fetch: emptyUpdatesFetch() });
  });
  assert.deepEqual(pi.tools.map((t) => t.name).sort(), ["telegram_send"]);
  assert.equal(pi.commands.length, 1);
  assert.equal(pi.commands[0].name, "telegram");
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

test("worker role: dead-poller warn says the seat owns the poller, no enable advice", async () => {
  const env = baseEnv({ [ENV_SESSION_ROLE]: "worker" });
  const fetchFn = makeFakeFetch(async () => jsonResponse(sendMessageResult(7)));
  const pi = makeFakePi();
  await withEnv(env, async () => {
    await telegramExtension(pi, { fetch: fetchFn });
    const send = pi.tools.find((t) => t.name === "telegram_send");
    const r = await send.execute("id", { text: "hello" }, undefined, undefined);
    const outcome = JSON.parse(r.content[0].text);
    assert.equal(outcome.ok, true);
    assert.match(outcome.warn, /inbound poller OFF/);
    assert.match(outcome.warn, /orchestrator seat owns/);
    assert.doesNotMatch(outcome.warn, /telegram_poller/);
  });
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

test("seat enable refused while a live foreign pid holds the lock; lock intact", async () => {
  const lockFile = tmpLockFile("live-holder");
  const env = baseEnv({ [ENV_POLLER_LOCK_FILE]: lockFile });
  writeLock(lockFile, {
    pid: FOREIGN_PID,
    startedAt: 1700000000000,
    role: "seat",
    startedBy: "orchestrator seat",
  });
  const fetchFn = emptyUpdatesFetch();
  const pi = makeFakePi();
  await withEnv(env, async () => {
    await telegramExtension(pi, {
      fetch: fetchFn,
      pidAlive: (pid) => pid === FOREIGN_PID,
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
    assert.match(r.details.error, /pid 424242/);
    assert.match(r.details.error, /orchestrator seat/);
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

test("seat enable takes over a stale lock silently", async () => {
  const lockFile = tmpLockFile("stale-takeover");
  const env = baseEnv({ [ENV_POLLER_LOCK_FILE]: lockFile });
  writeLock(lockFile, {
    pid: FOREIGN_PID,
    startedAt: 1700000000000,
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
    await waitFor(
      () => fetchFn.calls.some((c) => c.url.includes("getUpdates")),
      2000,
    );
    assert.equal(
      readPollerLock(lockFile).pid,
      process.pid,
      "the takeover must record the new holder",
    );
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

test("worker /telegram enable is refused with the seat-ownership message", async () => {
  const lockFile = tmpLockFile("worker-cmd");
  const env = baseEnv({
    [ENV_SESSION_ROLE]: "worker",
    [ENV_POLLER_LOCK_FILE]: lockFile,
  });
  const pi = makeFakePi();
  const notices = [];
  const ctx = { ui: { notify: (m, t) => notices.push([m, t]) } };
  await withEnv(env, async () => {
    await telegramExtension(pi, {
      fetch: emptyUpdatesFetch(),
      pidAlive: () => true,
    });
    await pi.commands[0].handler("enable", ctx);
    const [msg, type] = notices.at(-1);
    assert.match(msg, /orchestrator seat owns/);
    assert.equal(type, "warning");
    assert.equal(existsSync(lockFile), false);
  });
});

test("seat /telegram enable refused under a live foreign holder names the pid", async () => {
  const lockFile = tmpLockFile("seat-cmd");
  const env = baseEnv({ [ENV_POLLER_LOCK_FILE]: lockFile });
  writeLock(lockFile, { pid: FOREIGN_PID, startedAt: 5, role: "seat" });
  const pi = makeFakePi();
  const notices = [];
  const ctx = { ui: { notify: (m, t) => notices.push([m, t]) } };
  await withEnv(env, async () => {
    await telegramExtension(pi, {
      fetch: emptyUpdatesFetch(),
      pidAlive: (pid) => pid === FOREIGN_PID,
    });
    await pi.commands[0].handler("enable", ctx);
    const [msg, type] = notices.at(-1);
    assert.match(msg, /pid 424242/);
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
