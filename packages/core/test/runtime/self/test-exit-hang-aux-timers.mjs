/**
 * Auxiliary timers must not hold the event loop open.
 *
 * `pi -p` prints its answer and then must still be able to exit. Two braid
 * extensions arm periodic timers whose ref'd handles kept Node's loop alive
 * after print-mode dispose. This pin asserts the executable contract at the
 * creation sites:
 *
 *   health-maintenance - the 30 s metrics interval is unref'd at creation,
 *   and stopMetricsPersistence() clears the exact handle it created.
 *   watchdog - the monitor cadence timeout armed through the extension's real
 *   schedule seam is unref'd, and session_shutdown stops the engine even
 *   after polyfill's cleanup wiped the session state bucket
 *   (clearAllExtensionState runs before later shutdown handlers in pi-core's
 *   registration-ordered runner).
 *
 * RED on the pre-fix code: `hasRef()` is true for both handles, and the
 * watchdog engine's timer is never cleared by shutdown. Node's
 * getActiveResourcesInfo() reports only ref'd timers, so the direct handle
 * assertions are the primary pin; every leak is also cleared defensively in
 * `finally` so a RED run reports instead of hanging.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const METRICS_SAVE_INTERVAL_MS = 30000;

// The watchdog config resolves its settings path when its module loads; point
// that at an empty temp dir so this test runs with pure defaults and never
// reads or writes the real settings.json.
const settingsDir = mkdtempSync(join(tmpdir(), "braid-exit-hang-settings-"));
process.env.PI_CODING_AGENT_DIR = settingsDir;

const helpers = await import(
  join(ROOT, "dist", "extensions", "self", "health-maintenance", "helpers.js")
);
const watchdog = await import(join(ROOT, "dist", "extensions", "self", "watchdog", "index.js"));
const { clearAllExtensionState } = await import(
  join(ROOT, "dist", "lib", "state", "extension-state.js")
);
const { SESSION_START, SESSION_SHUTDOWN } = await import(
  join(ROOT, "dist", "lib", "core", "event-names.js")
);

after(() => {
  rmSync(settingsDir, { recursive: true, force: true });
});

test("health-maintenance: metrics interval is unref'd and cleared through its own handle", () => {
  const created = [];
  const cleared = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms, ...rest) => {
    const id = realSetInterval(fn, ms, ...rest);
    created.push({ id, ms });
    return id;
  };
  globalThis.clearInterval = (id, ...rest) => {
    cleared.push(id);
    return realClearInterval(id, ...rest);
  };

  let handle;
  try {
    helpers.startMetricsPersistence();
    const entry = created.find((c) => c.ms === METRICS_SAVE_INTERVAL_MS);
    assert.ok(entry, `startMetricsPersistence armed the ${METRICS_SAVE_INTERVAL_MS}ms interval`);
    handle = entry.id;
    assert.equal(
      handle.hasRef(),
      false,
      "metrics interval must be unref'd at creation (it may not keep an idle process alive)",
    );
    helpers.stopMetricsPersistence();
    assert.ok(
      cleared.includes(handle),
      "stopMetricsPersistence must clear the handle it created (module-default handle, not a ctx bucket)",
    );
  } finally {
    helpers.stopMetricsPersistence?.();
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    if (handle) realClearInterval(handle);
  }
});

test("watchdog: cadence timeout is unref'd and shutdown stops it after a state wipe", async () => {
  const handlers = new Map();
  const api = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    registerCommand() {},
  };
  const emit = async (event, ctx) => {
    for (const fn of handlers.get(event) ?? []) await fn({}, ctx);
  };
  watchdog.default(api);

  const ctx = {
    cwd: "/tmp",
    sessionManager: {
      getSessionFile: () => "/tmp/braid-exit-hang-fixture.jsonl",
      getSessionId: () => "exit-hang-fixture",
    },
    ui: { setStatus() {} },
  };

  const armed = [];
  const cleared = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const id = realSetTimeout(fn, ms, ...rest);
    armed.push({ id, ms });
    return id;
  };
  globalThis.clearTimeout = (id, ...rest) => {
    cleared.push(id);
    return realClearTimeout(id, ...rest);
  };

  let cadence;
  try {
    await emit(SESSION_START, ctx);
    cadence = armed.find((a) => a.ms === 900000) ?? armed.at(-1);
    assert.ok(cadence, "session start armed the watchdog cadence timeout");
    assert.equal(
      cadence.id.hasRef(),
      false,
      "watchdog cadence timeout must be unref'd at creation (it may not keep an idle process alive)",
    );

    // Reproduce the real handler order in pi-core's runner: polyfill's
    // registerSessionCleanup (manifest entry #1) deletes all session state
    // before later extensions' shutdown handlers run.
    clearAllExtensionState(ctx);
    await emit(SESSION_SHUTDOWN, ctx);
    assert.ok(
      cleared.includes(cadence.id),
      "session_shutdown must stop the engine's timer even after the session state bucket was wiped",
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    if (cadence) realClearTimeout(cadence.id);
  }
});
