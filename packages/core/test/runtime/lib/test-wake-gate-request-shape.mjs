/**
 * Regression test: a context-length refusal is request shape, and the wake
 * gate's fail-safe stops re-opening the door into it.
 *
 * Two contracts, tested together because they meet at one decision:
 *
 * 1. The classifier must never let a context-length refusal fall through to
 *    `unknown` (retryable) just because the provider phrased it as a 400
 *    instead of a 413. Retrying a request that cannot fit is the same request.
 * 2. The fail-safe that opens a stuck run-region gate must keep its original
 *    behaviour for transient failures (otherwise a pre-flight abort wedges the
 *    gate closed forever) and refuse to open while the last turn died of that
 *    refusal class - a fail-open that fires wakes into a permanently failing
 *    request is the amplifier, not the safety.
 *
 * Run: node test/runtime/lib/test-wake-gate-request-shape.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";

const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT = join(__dirname, "..", "..", "..");

const { classifyLlmError, isContextLengthRequestShape } = await import(
  join(ROOT, "dist", "lib", "errors", "llm-error.js")
);
const {
  clearRequestShapeFailure,
  gateTriggerTurnOptions,
  isRunRegionActive,
  noteRequestShapeFailure,
  registerWakeGate,
  requestShapeFailure,
  resetWakeGateForTests,
  _setWakeGateFailSafeMsForTests,
} = await import(join(ROOT, "dist", "lib", "utils", "wake-gate.js"));

const FAIL_SAFE_MS = 20;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}`);
  } finally {
    clearRequestShapeFailure();
    resetWakeGateForTests();
  }
}

console.log("=== request-shape classification and the wake gate ===\n");

// ── 1. The classifier ───────────────────────────────────────────────────────

await test("the incident's 400 body is a request-shape context refusal", () => {
  const body =
    '400: {"param":"","type":"invalid_request_error","code":"invalid_request_error",' +
    '"message":"Upstream request failed: This model\'s maximum context length is 1048576 tokens. ' +
    'However, you requested 1147002 tokens (1147001 in the messages, 1 in the completion). ' +
    'Please reduce the length of the messages or completion. (request_id: 0c607644)"}';
  const c = classifyLlmError(new Error(body));
  assert.equal(c.category, "context_window");
  assert.equal(c.retryable, false, "retrying the same request cannot succeed");
  assert.equal(c.requestShape, "context_length");
  assert.equal(isContextLengthRequestShape(body), true);
});

await test("a 400 with an unremarkable body does not become a context refusal", () => {
  const c = classifyLlmError(new Error('400: {"type":"invalid_request_error","message":"bad tool schema"}'));
  assert.equal(c.category, "unknown", "no context wording, no request-shape claim");
  assert.equal(c.requestShape, undefined);
  assert.equal(isContextLengthRequestShape("400 bad tool schema"), false);
});

await test("a transient failure stays transient (the control)", () => {
  const c = classifyLlmError(new Error("502 Bad Gateway: upstream overloaded"));
  assert.equal(c.category, "transient");
  assert.equal(c.retryable, true);
  assert.equal(c.requestShape, undefined);
  assert.equal(isContextLengthRequestShape("502 Bad Gateway"), false);
});

// ── 2. The wake gate's fail-safe ────────────────────────────────────────────

function registerAndArm() {
  const handlers = new Map();
  registerWakeGate({ on: (event, handler) => handlers.set(event, handler) });
  // `input` arms the run region at prompt entry (no streamingBehavior = a new
  // run follows). The fail-safe is what opens it if no release event lands.
  handlers.get("input")({}, undefined);
  assert.equal(isRunRegionActive(), true, "the region is armed");
}

await test("transient control: the fail-safe still opens a stuck gate", async () => {
  _setWakeGateFailSafeMsForTests(FAIL_SAFE_MS);
  registerAndArm();
  await settle(FAIL_SAFE_MS + 25);
  assert.equal(isRunRegionActive(), false, "the safety net must survive for its own class");
  const options = gateTriggerTurnOptions({ triggerTurn: true });
  assert.equal(options.triggerTurn, true, "an idle wake passes through ungated");
});

await test("after a context-length refusal a due wake does not fire ungated", async () => {
  _setWakeGateFailSafeMsForTests(FAIL_SAFE_MS);
  registerAndArm();
  noteRequestShapeFailure("400 maximum context length is 1048576 tokens; requested 1147002");
  await settle(FAIL_SAFE_MS + 25);

  assert.equal(isRunRegionActive(), true, "the gate stays closed while the request cannot fit");
  const options = gateTriggerTurnOptions({ triggerTurn: true });
  assert.equal(options.triggerTurn, undefined, "the wake is not allowed to start a run");
  assert.equal(options.deliverAs, "steer", "it is delivered as a steer instead");
  assert.match(
    requestShapeFailure() ?? "",
    /maximum context length/,
    "the gate can still say why it refused",
  );

  // The window re-arms rather than opening once: a second window is not a
  // second opinion.
  await settle(FAIL_SAFE_MS + 25);
  assert.equal(isRunRegionActive(), true);
});

await test("clearing the refusal lets the next fail-safe window open the gate", async () => {
  _setWakeGateFailSafeMsForTests(FAIL_SAFE_MS);
  registerAndArm();
  noteRequestShapeFailure("400 maximum context length");
  await settle(FAIL_SAFE_MS + 25);
  assert.equal(isRunRegionActive(), true);

  clearRequestShapeFailure();
  await settle(FAIL_SAFE_MS + 25);
  assert.equal(isRunRegionActive(), false, "nothing holds the gate once the refusal is stale");
  assert.equal(gateTriggerTurnOptions({ triggerTurn: true }).triggerTurn, true);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`FAILED: ${f}`);
  process.exit(1);
}
