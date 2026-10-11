/**
 * The session-shutdown handler must drop the topic-drift detector's cached
 * extension ctx.
 *
 * The detector reads its cached ctx on every check(); only with nothing
 * cached does it fall back to the local Jaccard heuristic. That fallback is
 * the observable: after the shutdown handler runs, a check() that would have
 * used the injected ctx must produce the heuristic verdict instead. A stale
 * cache would classify through a session that already ended.
 *
 * Runs against the compiled dist (npm test builds first).
 *
 * Run: node test/runtime/enforcement/test-session-shutdown-critic-ctx.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

const { setCriticCtx, TopicDriftDetector } = await import(
  join(ROOT, "dist/lib/detection/topic-drift-detector.js")
);
const { registerSessionShutdownHandler } = await import(
  join(ROOT, "dist/extensions/enforcement/handlers/register-session-shutdown.js")
);
const { SESSION_SHUTDOWN } = await import(join(ROOT, "dist/lib/core/event-names.js"));

console.log("=== session shutdown: the critic ctx is cleared ===\n");

// Fixtures: a capture-only pi surface (the handler only registers), a handler
// ctx the shutdown body can read, and an injected critic ctx that throws on
// any read — the green path must never touch it, a stale cache must.
function makeFakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
}

await test("shutdown clears the detector's cached ctx", async () => {
  const pi = makeFakePi();
  registerSessionShutdownHandler(pi);
  const handlers = pi.handlers.get(SESSION_SHUTDOWN) ?? [];
  assert.ok(handlers.length > 0, "session_shutdown handler registered");

  const handlerCtx = { cwd: "/tmp/pi-braid-critic-ctx-shutdown" };
  const injected = new Proxy(
    {},
    {
      get() {
        throw new Error("stale critic ctx was read after session shutdown");
      },
    },
  );
  setCriticCtx(injected);
  for (const handler of handlers) {
    await handler({}, handlerCtx);
  }

  const detector = new TopicDriftDetector({ minTurns: 1 });
  detector.setTaskContext("alpha beta gamma delta epsilon zeta");
  detector.addTurn("zulu yankee xray whiskey victor uniform");
  const result = await detector.check();
  assert.equal(result.classifierDown, false, "no classifier path may run");
  assert.match(
    result.reason,
    /^semantic_drift \(jaccard=/,
    `expected the local heuristic path, got: ${result.reason}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
