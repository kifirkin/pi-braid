/**
 * Regression test: the heartbeat auto-finalize whisper
 * (context critical → finalize now) was delivered as `deliverAs: "nextTurn"`,
 * contradicting the code's own "delivers immediately / time-critical"
 * comment. At ≥ critical context usage there may BE no next turn — the
 * context is full NOW — so the most time-critical hygiene whisper sat
 * undelivered until a user prompt that might never come.
 *
 * Fix: deliver as `steer` (injected into the current run; silent push when
 * idle — no wake, no loop risk).
 *
 * Three axes (all revert-proof: the test fails on pre-fix code):
 * (a) Policy behavior: the context-monitor policy calls the steer callback
 * exactly when the USAGE_WHISPER_CRITICAL threshold is crossed — not
 * below it (a warning-tier whisper goes through the buffered
 * sendWhisper callback instead).
 * (b) Call site: the auto-finalize callback in
 * src/extensions/heartbeat/heartbeat-scheduler/index.ts passes
 * `deliverAs: "steer"`to sendTrackedMessage — never `nextTurn`, no
 * `triggerTurn: true` (the deferral/wake machinery is not what we want
 * here; steer already reaches a streaming agent same-turn).
 * (c) Channel semantics: sendTrackedMessage with `deliverAs: "steer"`
 * dispatches SYNCHRONOUSLY (same tick, no macrotask deferral) — the
 * same-tick delivery the "time-critical"comment promises. Contrast:
 * triggerTurn:true defers through setTimeout(0).
 *
 * Threshold note: the live auto-finalize threshold is USAGE_WHISPER_CRITICAL
 * (lib/detection/context-thresholds.ts). The policy header comment says
 * "90%"but the wired constant is authoritative — the test imports the
 * constant instead of hardcoding either number, so retuning the threshold
 * cannot silently break this suite.
 *
 * Run: node test/runtime/heartbeat/test-auto-finalize-steer.mjs
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// HOME redirect BEFORE dist imports: braid-paths / braid-settings resolve
// from os.homedir() at module eval — keep the test off real user state and
// off a real settings.json (nudges must be enabled for the channel test).
const tmpBase = mkdtempSync(join(tmpdir(), "auto-finalize-steer-"));
process.env.HOME = tmpBase;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const { createDefaultPolicies } = await import(
  join(ROOT, "dist/extensions/heartbeat/heartbeat-scheduler/policies.js")
);
const { sendTrackedMessage } = await import(join(ROOT, "dist/lib/utils/injection-tracker.js"));
const { USAGE_WHISPER_CRITICAL, USAGE_WHISPER_SOFT } = await import(
  join(ROOT, "dist/lib/detection/context-thresholds.js")
);

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

console.log("=== heartbeat auto-finalize whisper delivers as steer ===\n");

// ── Fixtures ────────────────────────────────────────────────────────────────

function makePolicyContext(percent) {
  return {
    sessionId: "auto-finalize-test",
    turnNumber: 1,
    toolStats: new Map(),
    cwd: "/tmp/auto-finalize",
    getContextUsage: () => ({ percent, tokens: 1_000, contextWindow: 200_000 }),
  };
}

function makeFakePi() {
  const sent = [];
  return {
    sent,
    on() {},
    sendMessage(params, options) {
      sent.push({ params, options });
    },
  };
}

// ── Axis (a): policy fires the steer callback at the critical threshold ─────

await test("context-monitor fires the steer callback ONLY at the USAGE_WHISPER_CRITICAL crossing", async () => {
  const whispers = [];
  const steers = [];
  const policies = createDefaultPolicies(
    () => ({ lastVerificationTurn: 0, totalToolsUsed: 0 }),
    () => {},
    (msg) => whispers.push(msg),
    (msg) => steers.push(msg),
  );
  const monitor = policies.find((p) => p.id === "context-monitor");
  assert.ok(monitor, "context-monitor policy exists");

  // The ladder climbs lowest-unfired-first (tiers reversed → soft, advisory,
  // warning, critical): each action invocation fires the next threshold the
  // current usage has crossed. Walk it to the critical rung.
  // 1. Below the LOWEST tier (soft = 30): clears the fired ladder, nothing
  // fires. (USAGE_FIRED_RESET_BELOW = 50, so the clear also applies.)
  await monitor.action(makePolicyContext(USAGE_WHISPER_SOFT - 10));
  assert.equal(whispers.length, 0, "no whisper below the lowest threshold");
  assert.equal(steers.length, 0, "no steer below the lowest threshold");

  // 2. Climb to the warning rung: buffered whispers only, no steer (not
  // time-critical yet).
  await monitor.action(makePolicyContext(USAGE_WHISPER_CRITICAL - 5)); // 70 → soft
  await monitor.action(makePolicyContext(USAGE_WHISPER_CRITICAL - 5)); // 70 → advisory
  await monitor.action(makePolicyContext(USAGE_WHISPER_CRITICAL - 5)); // 70 → warning
  assert.equal(whispers.length, 3, "soft/advisory/warning whispers buffered");
  assert.equal(steers.length, 0, "no steer below the critical threshold");

  // 3. Cross the critical threshold: steer fires — exactly once, same call.
  await monitor.action(makePolicyContext(USAGE_WHISPER_CRITICAL + 1));
  assert.equal(steers.length, 1, "auto-finalize steer fired at the critical crossing");
  assert.ok(
    steers[0].includes("critical arm"),
    `steer text names the crossed arm - got: ${steers[0]}`,
  );
  assert.doesNotMatch(
    steers[0],
    /\d+(\.\d+)?%/,
    `steer text prints no threshold as a reading - got: ${steers[0]}`,
  );
  assert.ok(steers[0].includes("context_navigate"), "steer text carries the tag-first pipeline");
});

// ── Axis (b): the call site passes deliverAs:"steer" (never nextTurn) ───────

await test("auto-finalize call site: deliverAs steer, no nextTurn, no triggerTurn (src scan)", () => {
  const src = readFileSync(
    join(ROOT, "src", "extensions", "heartbeat", "heartbeat-scheduler", "index.ts"),
    "utf8",
  );
  const marker = src.indexOf('"heartbeat/auto-finalize"');
  assert.ok(marker >= 0, "auto-finalize source marker present");
  // Tight window around the marker: the deliverAs options object sits
  // within a few lines above the injection-meta source line. Wide enough
  // for formatting drift, narrow enough to exclude prose comments and the
  // other (triggerTurn:false) call sites in the same file.
  const window = src.slice(Math.max(0, marker - 400), marker + 100);
  assert.match(window, /deliverAs:\s*"steer"/, "auto-finalize must deliver as steer");
  assert.doesNotMatch(
    window,
    /deliverAs:\s*"nextTurn"/,
    "auto-finalize must NOT queue for a next turn that may never come",
  );
  assert.doesNotMatch(window, /triggerTurn:\s*true/, "no wake machinery — steer is the channel");
});

// ── Axis (c): steer dispatches synchronously (same tick, no deferral) ───────

await test("sendTrackedMessage steer: same-tick dispatch, nothing deferred; triggerTurn defers (contrast)", () => {
  const realSetTimeout = globalThis.setTimeout;
  const queue = [];
  globalThis.setTimeout = (fn) => {
    queue.push(fn);
    return queue.length;
  };
  const advance = () => {
    const due = queue.splice(0, queue.length);
    for (const fn of due) fn();
  };

  try {
    const pi = makeFakePi();
    const meta = { type: "heartbeat", source: "heartbeat/auto-finalize" };
    const params = (text) => ({
      customType: "heartbeat",
      content: [{ type: "text", text }],
      display: true,
    });

    // Steer: synchronous dispatch on the SAME tick — the whisper reaches
    // pi.sendMessage before sendTrackedMessage returns.
    sendTrackedMessage(pi, params("finalize-now"), { deliverAs: "steer" }, meta, {
      bypassFloodCap: true,
    });
    assert.equal(pi.sent.length, 1, "steer delivered synchronously (same tick)");
    assert.equal(pi.sent[0].options?.deliverAs, "steer", "options reach pi.sendMessage intact");
    assert.equal(queue.length, 0, "steer must not schedule a deferred dispatch");

    // Contrast: triggerTurn:true defers through setTimeout(0) — the
    // macrotask boundary that prevents agent-loop re-entry.
    sendTrackedMessage(pi, params("wake-later"), { triggerTurn: true, deliverAs: "steer" }, meta, {
      bypassFloodCap: true,
    });
    assert.equal(pi.sent.length, 1, "triggerTurn wake is NOT synchronous");
    advance();
    assert.equal(pi.sent.length, 2, "deferred wake lands after the macrotask boundary");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(tmpBase, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
