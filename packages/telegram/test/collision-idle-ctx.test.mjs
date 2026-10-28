/**
 * collision-idle-ctx.test.mjs — the inbound collision gate asks the context.
 *
 * The collision-aware delivery gate read `pi.isIdle()`, a member the real
 * extension API does not have (`createExtensionAPI` builds none; `isIdle`
 * lives on the context built by `createContext`). `?.() ?? true` made
 * `isPiIdle()` constant true on this phantom-member pi, so the old busy-hold
 * never engaged in production: every owner message took the immediate steer
 * path. The harness keeps mirroring the real API — the fake pi has NO isIdle,
 * and busy-ness is driven through the context captured by a lifecycle handler
 * (`ctx.isIdle()` reads the live session state), even though delivery no
 * longer branches on it.
 *
 * Run: npm test -w packages/telegram  (from the repo root)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  BOT_TOKEN,
  OWNER_ID,
  OWNER_CHAT_ID,
  makeUpdate,
  getUpdatesResult,
  jsonResponse,
  makeFakeFetch,
} from "./fixtures.mjs";
import { sleep, waitFor } from "./helpers/poll.mjs";

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
  const pin = mkdtempSync(join(tmpdir(), "tg-idle-ctx-pin-"));
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
 * Fake pi with the SHIPPED extension API shape: no isIdle member. The context
 * handed to lifecycle handlers carries the idle answer instead.
 */
function makeRealShapePi() {
  const handlers = new Map();
  const messages = [];
  const pi = {
    tools: [],
    handlers,
    messages,
    registerTool: (tool) => pi.tools.push(tool),
    registerCommand: () => {},
    sendUserMessage: (...args) => messages.push(args),
    on: (event, fn) =>
      handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    emit: (event, ...args) => {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
  };
  return pi;
}

/** Context whose idle answer the test controls (the supported surface). */
function makeCtx(idle) {
  return {
    ui: { notify() {} },
    isIdle: () => idle,
  };
}

/**
 * Wait until the background poller has issued its first getUpdates.
 *
 * A refused start is invisible from the delivery waits below: the extension
 * reports it through the notify sink, and nothing binds that sink before the
 * first session_start. Without this wait a refusal reads as a bare "condition
 * not met within 3000ms" — a description of the observer, not of the world.
 */
async function waitForFirstPoll(fetchFn, timeoutMs = 3000) {
  try {
    await waitFor(
      () => fetchFn.calls.some((call) => call.url.includes("getUpdates")),
      timeoutMs,
    );
  } catch (error) {
    throw new Error(
      "the poller never issued getUpdates: its start was refused — a live pid " +
        "holds the machine-wide ownership lock, the session role is worker, or " +
        "no braid root resolves",
      { cause: error },
    );
  }
}

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

function collisionEnv() {
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
    [ENV_STATE_FILE]: tmpStateFile("idle-ctx"),
    TELEGRAM_STATE_FILE: undefined,
    [ENV_POLL_INTERVAL_MS]: "200",
    TELEGRAM_POLL_INTERVAL_MS: undefined,
    [ENV_COALESCE_WINDOW_MS]: "50",
    TELEGRAM_COALESCE_WINDOW_MS: undefined,
  };
}

test("collision gate: busy context still delivers — at window close, as a steer", async () => {
  const pi = makeRealShapePi();
  assert.equal(
    "isIdle" in pi,
    false,
    "the fake must mirror the shipped API shape",
  );
  const fetchFn = makeOwnerFetch([makeUpdate(301, { text: "queued ping" })]);
  await withEnv(collisionEnv(), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
    await waitForFirstPoll(fetchFn);

    try {
      // A lifecycle handler hands the gate a live context while a run is active.
      pi.emit(
        "session_start",
        { type: "session_start", reason: "new" },
        makeCtx(false),
      );

      await waitFor(() => pi.messages.length >= 1, 3000);
      const [content, options] = pi.messages[0];
      assert.equal(
        options?.deliverAs,
        "steer",
        "busy → the owner message steers into the running turn",
      );
      assert.ok(
        content.includes("queued ping"),
        "the owner message, not a stale one",
      );
      await sleep(150); // past the window: no duplicate delivery
      assert.equal(pi.messages.length, 1, "one delivery per window");
    } finally {
      pi.emit("session_shutdown");
      await sleep(50);
    }
  });
});

test("collision gate: idle context delivers (window close, no settle needed)", async () => {
  const pi = makeRealShapePi();
  const fetchFn = makeOwnerFetch([makeUpdate(302, { text: "idle ping" })]);
  await withEnv(collisionEnv(), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
    await waitForFirstPoll(fetchFn);

    try {
      pi.emit(
        "session_start",
        { type: "session_start", reason: "new" },
        makeCtx(true),
      );

      await waitFor(() => pi.messages.length >= 1, 3000);
      assert.equal(
        pi.messages.length,
        1,
        "idle → delivered without waiting for settle",
      );
      assert.ok(pi.messages[0][0].includes("idle ping"));
    } finally {
      pi.emit("session_shutdown");
      await sleep(50);
    }
  });
});
