/**
 * inbound-queue-durability.test.mjs — a held owner message is never lost and
 * never crosses into a session it was not accepted for.
 *
 * Owner messages steer by policy, so the hold is the failure half only: an
 * entry stays pending when a handoff is refused or when a factory re-run lands
 * mid-window. The hold outlives the delivery attempt, so it is written through
 * to a file beside the poller state: the poller confirms the update (and
 * persists an offset past it) at the end of the poll cycle, after the delivery
 * callback returns, so from that moment the file is the only copy. Both
 * lifecycle paths re-run the extension factory — a reload and a session
 * replacement (new/resume/fork) alike — so each starts with an empty
 * in-memory hold; the file is the durable half, and the session key on every
 * entry is what keeps a rehydrated hold from being delivered into a session
 * it was not accepted for.
 *
 * "a held message does not cross into a replaced session" simulates a
 * same-closure context swap and is a unit test of the handover invariant; the
 * real replacement path — a fresh factory run opening session B while session
 * A's hold sits on disk — is pinned by "the real replacement path (fresh
 * factory run) must not deliver A's hold into B".
 *
 * Driven through the real poller (BRAID_TG_POLL_ENABLED=1 + fake fetch) with a
 * fake pi exposing the shipped extension-API shape (no isIdle member) and a
 * fake context carrying the session id.
 *
 * Run: npm test -w packages/telegram  (from the repo root)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import telegramExtension, {
  ENV_TOKEN,
  ENV_CHAT_ID,
  ENV_ALLOWED_USERS,
  ENV_POLL_ENABLED,
  ENV_POLL_DISABLED,
  ENV_POLLER_LOCK_FILE,
  ENV_SESSION_ROLE,
  ENV_STATE_FILE,
  ENV_POLL_INTERVAL_MS,
  ENV_COALESCE_WINDOW_MS,
} from "../dist/index.js";
import {
  loadInboundQueue,
  saveInboundQueue,
} from "../dist/lib/inbound-queue.js";
import {
  BOT_TOKEN,
  OWNER_ID,
  OWNER_CHAT_ID,
  makeUpdate,
  getUpdatesResult,
  jsonResponse,
  makeFakeFetch,
} from "./fixtures.mjs";
import { sleep, waitFor, waitForJson } from "./helpers/poll.mjs";

const SESSION_A = "session-a";
const SESSION_B = "session-b";

/**
 * Set process.env for the duration of fn, restoring every prior value after.
 *
 * Every window also pins the machine-wide braid tree the poller resolves — the
 * root (BRAID_HOME), the ownership lock, and the session role — at a fresh dir
 * this case owns. The pins hold for the whole case, not just the factory call,
 * because the reads keep happening: the pause flag on every poll cycle, the
 * lock path again when the poller releases at shutdown, the role on every start
 * attempt (the session_start re-arm or an explicit enable inside the case). A
 * window that ends early hands those reads the live tree, where another pi
 * process's lock refuses the start, a paused owner holds every delivery, and a
 * worker marker refuses the poller outright. The runner pins the same three for
 * the children it spawns (child-env.mjs); a file run on its own inherits them
 * instead. Caller pairs win, so a case may still unset BRAID_HOME to exercise a
 * default path.
 */
function withEnv(pairs, fn) {
  const pin = mkdtempSync(join(tmpdir(), "tg-durability-pin-"));
  const saved = new Map();
  for (const [key, value] of Object.entries({
    BRAID_HOME: pin,
    [ENV_POLLER_LOCK_FILE]: join(pin, "telegram-poller.lock"),
    TELEGRAM_POLLER_LOCK_FILE: undefined,
    [ENV_SESSION_ROLE]: undefined,
    ...pairs,
  })) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // The pin dir holds this case's lock file, so it is a case artifact and
    // must not outlive the case: one dir per case per run accumulates in tmp.
    // Cleanup cannot mask the case's own failure — force skips a missing path
    // and the catch covers the rest.
    try {
      rmSync(pin, { recursive: true, force: true });
    } catch {
      // best effort: a leftover dir in tmp is harmless
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

function tmpStateFile(prefix) {
  return join(
    tmpdir(),
    `tg-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    "telegram-state.json",
  );
}

/**
 * Wait until the poller has served the owner batch.
 *
 * A refused start is invisible from here: the extension reports it through the
 * notify sink, and nothing binds that sink before the first session_start. This
 * wait therefore names the three causes instead of leaving a bare "condition
 * not met within 3000ms". It is also why the wait is written around `served()`
 * rather than as a separate start check: in this file the FIRST getUpdates call
 * already carries the owner batch, so any wait placed before session_start
 * would consume the batch before a session could name itself.
 */
async function waitForServedBatch(fetchFn, timeoutMs = 3000) {
  try {
    await waitFor(() => fetchFn.served(), timeoutMs);
  } catch (error) {
    throw new Error(
      "the poller never served getUpdates: its start was refused — a live pid " +
        "holds the machine-wide ownership lock, the session role is worker, or " +
        "no braid root resolves",
      { cause: error },
    );
  }
}

/** The hold lives beside the poller state file, named after its stem. */
function queueFileFor(stateFile) {
  return join(dirname(stateFile), "telegram-state-inbound-queue.json");
}

/**
 * Fake pi with the SHIPPED extension API shape: no isIdle member (that lives on
 * the context), appendEntry recorded, and a controllable sendUserMessage so a
 * failed handoff can be exercised.
 */
function makeRealShapePi() {
  const handlers = new Map();
  const messages = [];
  const notifications = [];
  const appended = [];
  const pi = {
    tools: [],
    handlers,
    messages,
    notifications,
    appended,
    failNextSend: undefined,
    registerTool: (tool) => pi.tools.push(tool),
    registerCommand: () => {},
    sendUserMessage: (...args) => {
      if (pi.failNextSend !== undefined) {
        const reason = pi.failNextSend;
        pi.failNextSend = undefined;
        throw new Error(reason);
      }
      messages.push(args);
    },
    appendEntry: (customType, data) => appended.push({ customType, data }),
    on: (event, fn) =>
      handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    emit: (event, ...args) => {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
  };
  return pi;
}

/**
 * Context whose idle answer and session identity the test controls — the same
 * supported surface the shipped gate reads (ctx.isIdle, ctx.sessionManager).
 */
function makeCtx(idle, sessionId, notifications = []) {
  return {
    ui: { notify: (message, type) => notifications.push({ message, type }) },
    isIdle: () => idle,
    sessionManager: { getSessionId: () => sessionId },
  };
}

/** Fake fetch serving `updates` on the FIRST getUpdates call, then empty. */
function makeOwnerFetch(updates) {
  let served = false;
  const fetchFn = makeFakeFetch(async (url) => {
    if (url.includes("getUpdates")) {
      if (!served) {
        served = true;
        return jsonResponse(getUpdatesResult(updates));
      }
      return jsonResponse(getUpdatesResult([]));
    }
    return jsonResponse(getUpdatesResult([]));
  });
  fetchFn.served = () => served;
  return fetchFn;
}

function durabilityEnv(stateFile) {
  return {
    [ENV_TOKEN]: BOT_TOKEN,
    TELEGRAM_BOT_TOKEN: undefined,
    [ENV_CHAT_ID]: String(OWNER_CHAT_ID),
    TELEGRAM_CHAT_ID: undefined,
    [ENV_ALLOWED_USERS]: String(OWNER_ID),
    TELEGRAM_ALLOWED_USERS: undefined,
    [ENV_POLL_ENABLED]: "1",
    TELEGRAM_POLL_ENABLED: undefined,
    [ENV_POLL_DISABLED]: undefined,
    TELEGRAM_POLL_DISABLED: undefined,
    [ENV_STATE_FILE]: stateFile,
    TELEGRAM_STATE_FILE: undefined,
    [ENV_POLL_INTERVAL_MS]: "200",
    TELEGRAM_POLL_INTERVAL_MS: undefined,
    [ENV_COALESCE_WINDOW_MS]: "50",
    TELEGRAM_COALESCE_WINDOW_MS: undefined,
  };
}

/** Settle an idle boundary, tolerating a handoff that throws out of the emit. */
function emitSettled(pi, notifications, sessionId) {
  try {
    pi.emit(
      "agent_settled",
      { type: "agent_settled" },
      makeCtx(true, sessionId, notifications),
    );
    return undefined;
  } catch (error) {
    return error;
  }
}

test("hold survives a factory re-run and is delivered to its own session", async () => {
  const stateFile = tmpStateFile("hold");
  const queueFile = queueFileFor(stateFile);

  // ── First process: the owner message arrives mid-run and stays pending in
  //    the window; the file is its durable half ─────────────────────────────
  const pi1 = makeRealShapePi();
  const fetch1 = makeOwnerFetch([makeUpdate(401, { text: "held ping" })]);
  // Long window: the entry must still be pending when the shutdown lands, so
  // the re-run below is what delivers it (the file, not the timer, carries it).
  await withEnv(
    { ...durabilityEnv(stateFile), [ENV_COALESCE_WINDOW_MS]: "5000" },
    async () => {
      await telegramExtension(pi1, { fetch: fetch1 });

      try {
        pi1.emit(
          "session_start",
          { type: "session_start", reason: "startup" },
          makeCtx(false, SESSION_A, pi1.notifications),
        );
        await waitForServedBatch(fetch1);
        // The poller confirms the batch and persists an offset PAST the update at
        // the end of the poll cycle, after the delivery callback returns — from
        // here the file is the only copy of the message.
        await waitForJson(
          stateFile,
          (state) => Number(state.offset) >= 402,
          3000,
        );
        assert.equal(
          pi1.messages.length,
          0,
          "still inside the window → nothing delivered yet",
        );

        const held = await loadInboundQueue(queueFile);
        assert.equal(held.length, 1, "the hold is written through to disk");
        assert.equal(held[0].message.updateId, 401);
        assert.equal(held[0].sessionId, SESSION_A);

        pi1.emit("session_shutdown", {
          type: "session_shutdown",
          reason: "quit",
        });
        await sleep(50);
      } finally {
        pi1.emit("session_shutdown", {
          type: "session_shutdown",
          reason: "quit",
        });
      }
    },
  );

  // ── Second process (factory re-run): the same session starts idle ────────
  const pi2 = makeRealShapePi();
  const fetch2 = makeOwnerFetch([]);
  await withEnv(durabilityEnv(stateFile), async () => {
    await telegramExtension(pi2, { fetch: fetch2 });

    try {
      pi2.emit(
        "session_start",
        { type: "session_start", reason: "startup" },
        makeCtx(true, SESSION_A, pi2.notifications),
      );
      await waitFor(() => pi2.messages.length >= 1, 3000);
      assert.equal(
        pi2.messages.length,
        1,
        "the rehydrated hold is delivered without waiting for a settle",
      );
      assert.ok(
        pi2.messages[0][0].includes("held ping"),
        "the held owner message, not a stale one",
      );
      assert.equal(pi2.messages[0][1]?.deliverAs, "steer");
      await waitFor(
        async () => (await loadInboundQueue(queueFile)).length === 0,
        3000,
      );
    } finally {
      pi2.emit("session_shutdown", {
        type: "session_shutdown",
        reason: "quit",
      });
      await sleep(50);
    }
  });
});

test("a held message does not cross into a replaced session", async () => {
  const stateFile = tmpStateFile("scope");
  const queueFile = queueFileFor(stateFile);

  const pi = makeRealShapePi();
  const fetchFn = makeOwnerFetch([makeUpdate(501, { text: "queued ping" })]);
  // Long window: the entry stays pending until the replacement lands.
  await withEnv(
    { ...durabilityEnv(stateFile), [ENV_COALESCE_WINDOW_MS]: "5000" },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });

      try {
        pi.emit(
          "session_start",
          { type: "session_start", reason: "startup" },
          makeCtx(false, SESSION_A, pi.notifications),
        );
        await waitForServedBatch(fetchFn);
        await sleep(150);
        assert.equal(pi.messages.length, 0, "still pending in the window");

        // ── Session replacement: the hold was accepted for A, B is now current ──
        pi.emit("session_shutdown", {
          type: "session_shutdown",
          reason: "new",
        });
        pi.emit(
          "session_start",
          { type: "session_start", reason: "new" },
          makeCtx(true, SESSION_B, pi.notifications),
        );
        await sleep(150); // the rehydrate is async; the delivery decision must not wait on it
        emitSettled(pi, pi.notifications, SESSION_B);
        await sleep(50);

        assert.equal(
          pi.messages.length,
          0,
          "a hold accepted for A must never be delivered into B",
        );
        await waitFor(
          () =>
            pi.notifications.some((note) => note.message.includes("dropped 1")),
          3000,
        );
        await waitFor(
          async () => (await loadInboundQueue(queueFile)).length === 0,
          3000,
        );
        const report = pi.notifications.find((note) =>
          note.message.includes("dropped 1"),
        );
        assert.equal(
          report.type,
          "warning",
          "the drop is a visible notify line",
        );
        assert.ok(
          report.message.includes(SESSION_A),
          "the report names the session the message was accepted for",
        );
        assert.ok(
          report.message.includes("501"),
          "the report names the dropped update",
        );
        const record = pi.appended.find(
          (entry) => entry.customType === "telegram_inbound_dropped",
        );
        assert.ok(record, "the drop is also recorded durably in the session");
        assert.equal(record.data.count, 1);
        assert.equal(record.data.acceptedFor, SESSION_A);
        assert.equal(record.data.currentSessionId, SESSION_B);
      } finally {
        pi.emit("session_shutdown", {
          type: "session_shutdown",
          reason: "quit",
        });
        await sleep(50);
      }
    },
  );
});

test("the real replacement path (fresh factory run) must not deliver A's hold into B", async () => {
  const stateFile = tmpStateFile("real-replacement");
  const queueFile = queueFileFor(stateFile);

  // ── Factory run 1: session A busy, the owner message stays pending ───────
  const pi1 = makeRealShapePi();
  const fetch1 = makeOwnerFetch([makeUpdate(701, { text: "held for A" })]);
  await withEnv(
    { ...durabilityEnv(stateFile), [ENV_COALESCE_WINDOW_MS]: "5000" },
    async () => {
      await telegramExtension(pi1, { fetch: fetch1 });

      try {
        pi1.emit(
          "session_start",
          { type: "session_start", reason: "startup" },
          makeCtx(false, SESSION_A, pi1.notifications),
        );
        await waitForServedBatch(fetch1);
        await waitForJson(
          stateFile,
          (state) => Number(state.offset) >= 702,
          3000,
        );
        assert.equal(pi1.messages.length, 0, "still pending in the window");

        const held = await loadInboundQueue(queueFile);
        assert.equal(held.length, 1, "the hold is on disk");
        assert.equal(held[0].sessionId, SESSION_A);
      } finally {
        pi1.emit("session_shutdown", {
          type: "session_shutdown",
          reason: "new",
        });
        await sleep(50);
      }
    },
  );

  // ── Session replacement: pi re-runs the factory, session B starts ────────
  const pi2 = makeRealShapePi();
  const fetch2 = makeOwnerFetch([]);
  await withEnv(durabilityEnv(stateFile), async () => {
    await telegramExtension(pi2, { fetch: fetch2 });

    try {
      pi2.emit(
        "session_start",
        { type: "session_start", reason: "new" },
        makeCtx(true, SESSION_B, pi2.notifications),
      );
      await sleep(250);
      assert.equal(
        pi2.messages.length,
        0,
        "a hold from factory run 1 must never be delivered into B",
      );
      await waitFor(
        () =>
          pi2.notifications.some((note) => note.message.includes("dropped 1")),
        3000,
      );
      const report = pi2.notifications.find((note) =>
        note.message.includes("dropped 1"),
      );
      assert.ok(
        report.message.includes(SESSION_A),
        "the report names session A",
      );
      assert.ok(report.message.includes("701"), "the report names the update");
      const record = pi2.appended.find(
        (entry) => entry.customType === "telegram_inbound_dropped",
      );
      assert.ok(record, "the drop is also recorded durably in the session");
      assert.equal(record.data.acceptedFor, SESSION_A);
      assert.equal(record.data.currentSessionId, SESSION_B);

      // A settle inside B must not resurrect the hold either.
      pi2.emit(
        "agent_settled",
        { type: "agent_settled" },
        makeCtx(true, SESSION_B, pi2.notifications),
      );
      await sleep(50);
      assert.equal(pi2.messages.length, 0, "still nothing delivered into B");
      await waitFor(
        async () => (await loadInboundQueue(queueFile)).length === 0,
        3000,
      );
    } finally {
      pi2.emit("session_shutdown", {
        type: "session_shutdown",
        reason: "quit",
      });
      await sleep(50);
    }
  });
});

test("an entry accepted before any session names itself is adopted by the first named session", async () => {
  const stateFile = tmpStateFile("startup-adopt");
  const queueFile = queueFileFor(stateFile);

  const pi = makeRealShapePi();
  const fetchFn = makeOwnerFetch([makeUpdate(801, { text: "startup ping" })]);
  // The window is wide enough that the session_start below lands while the
  // entry is still held: the poller fetched the update before any lifecycle
  // context existed, so the entry was accepted with no session id at all.
  await withEnv(
    { ...durabilityEnv(stateFile), [ENV_COALESCE_WINDOW_MS]: "1200" },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });

      try {
        await waitForServedBatch(fetchFn);
        await waitForJson(
          stateFile,
          (state) => Number(state.offset) >= 802,
          3000,
        );
        await waitFor(
          async () => (await loadInboundQueue(queueFile)).length === 1,
          3000,
        );
        const held = await loadInboundQueue(queueFile);
        assert.equal(
          held[0].sessionId,
          undefined,
          "accepted before any session could name itself",
        );

        // The first session that names itself starts inside the window: the held
        // entry is adopted by it.
        pi.emit(
          "session_start",
          { type: "session_start", reason: "startup" },
          makeCtx(true, SESSION_A, pi.notifications),
        );

        // Settle on whichever outcome the behaviour produces — a delivery or a
        // drop report — then assert the adoption outcome.
        await waitFor(
          () =>
            pi.messages.length >= 1 ||
            pi.appended.some(
              (entry) => entry.customType === "telegram_inbound_dropped",
            ),
          5000,
        );
        assert.equal(
          pi.messages.length,
          1,
          "the adopted entry is delivered exactly once",
        );
        assert.ok(
          pi.messages[0][0].includes("startup ping"),
          "the delivered message is the held one",
        );
        assert.equal(
          pi.appended.filter(
            (entry) => entry.customType === "telegram_inbound_dropped",
          ).length,
          0,
          "an adopted entry is not reported as dropped",
        );
        await sleep(200);
        assert.equal(pi.messages.length, 1, "no duplicate delivery");
        await waitFor(
          async () => (await loadInboundQueue(queueFile)).length === 0,
          3000,
        );
      } finally {
        pi.emit("session_shutdown", {
          type: "session_shutdown",
          reason: "quit",
        });
        await sleep(50);
      }
    },
  );
});

test("a defined foreign session id is still dropped and reported, never adopted", async () => {
  const stateFile = tmpStateFile("foreign-id");
  const queueFile = queueFileFor(stateFile);
  await saveInboundQueue(queueFile, [
    {
      message: {
        updateId: 811,
        messageId: 1811,
        fromId: OWNER_ID,
        username: "owner",
        firstName: "Owner",
        chatId: OWNER_CHAT_ID,
        chatType: "private",
        text: "foreign ping",
        receivedAt: Date.parse("2026-09-03T14:05:00Z"),
      },
      sessionId: SESSION_B,
      queuedAt: Date.now(),
    },
  ]);

  const pi = makeRealShapePi();
  const fetchFn = makeOwnerFetch([]);
  await withEnv(durabilityEnv(stateFile), async () => {
    await telegramExtension(pi, { fetch: fetchFn });

    try {
      pi.emit(
        "session_start",
        { type: "session_start", reason: "startup" },
        makeCtx(true, SESSION_A, pi.notifications),
      );
      await waitFor(
        () =>
          pi.appended.some(
            (entry) => entry.customType === "telegram_inbound_dropped",
          ),
        3000,
      );
      await sleep(150);
      assert.equal(
        pi.messages.length,
        0,
        "an entry accepted for another named session is never delivered",
      );
      const record = pi.appended.find(
        (entry) => entry.customType === "telegram_inbound_dropped",
      );
      assert.equal(record.data.acceptedFor, SESSION_B);
      assert.equal(record.data.currentSessionId, SESSION_A);
      await waitFor(
        async () => (await loadInboundQueue(queueFile)).length === 0,
        3000,
      );
    } finally {
      pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
      await sleep(50);
    }
  });
});

test("a handoff that throws keeps the message queued for the next boundary", async () => {
  const stateFile = tmpStateFile("handoff");
  const queueFile = queueFileFor(stateFile);

  const pi = makeRealShapePi();
  const fetchFn = makeOwnerFetch([makeUpdate(601, { text: "retry ping" })]);
  // A window long enough to set the refusal before the first flush fires.
  await withEnv(
    { ...durabilityEnv(stateFile), [ENV_COALESCE_WINDOW_MS]: "300" },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });

      try {
        pi.emit(
          "session_start",
          { type: "session_start", reason: "startup" },
          makeCtx(false, SESSION_A, pi.notifications),
        );
        pi.failNextSend =
          "Cannot submit a prompt while compaction is in progress";

        // The window closes, but pi refuses the handoff.
        await waitFor(
          () =>
            pi.notifications.some((note) => note.message.includes("handoff")),
          3000,
        );
        assert.equal(pi.messages.length, 0, "nothing was handed over");

        const stillHeld = await loadInboundQueue(queueFile);
        assert.equal(
          stillHeld.length,
          1,
          "a refused handoff keeps the message instead of dropping it",
        );

        // The refusal re-armed the window: the retry hands it over.
        await waitFor(() => pi.messages.length >= 1, 3000);
        assert.ok(pi.messages[0][0].includes("retry ping"));
        await waitFor(
          async () => (await loadInboundQueue(queueFile)).length === 0,
          3000,
        );
      } finally {
        pi.emit("session_shutdown", {
          type: "session_shutdown",
          reason: "quit",
        });
        await sleep(50);
      }
    },
  );
});
