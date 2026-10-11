/**
 * tool_result calibration must read the event's `isError` flag.
 *
 * The handler fed `calibrationPairs`, `addEvidence` and the `tool_error` bus
 * event from `event.error` — a member the `tool_result` event does not carry
 * (agent-session.js builds `{type, toolName, toolCallId, input, content,
 * details, isError, usage}`). Every pair therefore recorded `actual: 1`
 * (success), every evidence line said "succeeded", and the bus event never
 * fired, so `self/error-tracking`'s `tool_error` subscription could never
 * receive one.
 *
 * This pins the supported read: a failing tool result records `actual: 0`,
 * lands a "failed" evidence line, and emits `tool_error` with the failure
 * text taken from the result content.
 *
 * Run: node test/runtime/enforcement/test-tool-result-calibration.mjs
 *      (after npm run build — this test reads dist, not src)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME isolation before the dist imports: braid-paths/braid-settings bake
// their paths at module-eval time, so the evidence pool and settings must
// resolve under a throwaway home.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "tool-result-calibration-"));
process.env.HOME = FAKE_HOME;

const { registerToolResultHandler } = await import(
  "../../../dist/extensions/enforcement/handlers/register-tool-result.js"
);
const { getState } = await import("../../../dist/extensions/enforcement/state.js");
const { eventBus } = await import("../../../dist/lib/events/event-bus.js");
const { getEvidence } = await import("../../../dist/lib/store/evidence-pool.js");

console.log("=== tool_result calibration reads isError ===\n");

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

let seq = 0;

/** Minimal ExtensionContext: session-scoped state + cwd for the evidence pool. */
function makeCtx() {
  const file = `calibration-${seq++}-${Date.now()}.jsonl`;
  return {
    cwd: FAKE_HOME,
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => file,
    },
  };
}

/** Fake pi capturing registered handlers; `emit` awaits them like pi does. */
function makePi() {
  const handlers = new Map();
  return {
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    async emit(event, payload, ctx) {
      for (const fn of handlers.get(event) ?? []) {
        await fn(payload, ctx);
      }
    },
  };
}

function primeState(ctx) {
  const state = getState(ctx);
  state.enforcementActive = true;
  state.lastThinkConfidence = 0.8;
  state.currentTurn = 7;
  return state;
}

await test("failing tool result: actual=0, evidence 'failed', tool_error emitted", async () => {
  const pi = makePi();
  registerToolResultHandler(pi);
  const ctx = makeCtx();
  const state = primeState(ctx);

  const busEvents = [];
  const onToolError = (e) => busEvents.push(e);
  eventBus.on("tool_error", onToolError);

  try {
    await pi.emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "call-1",
        input: { command: "exit 1" },
        content: [{ type: "text", text: "command failed: exit 1" }],
        isError: true,
      },
      ctx,
    );
  } finally {
    eventBus.off("tool_error", onToolError);
  }

  const pair = state.calibrationPairs.at(-1);
  assert.ok(pair, "a calibration pair must be recorded");
  assert.equal(pair.actual, 0, "a failing tool result records actual=0");

  const evidence = getEvidence(ctx, {});
  assert.ok(
    evidence.some((e) => /bash failed/.test(e.claim)),
    `evidence must say the tool failed, got: ${JSON.stringify(evidence.map((e) => e.claim))}`,
  );

  assert.equal(busEvents.length, 1, "one tool_error event for one failing result");
  assert.equal(busEvents[0].toolName, "bash");
  assert.match(
    String(busEvents[0].error),
    /command failed: exit 1/,
    "the bus error text comes from the result content",
  );
});

await test("successful tool result: actual=1 and evidence 'succeeded'", async () => {
  const pi = makePi();
  registerToolResultHandler(pi);
  const ctx = makeCtx();
  const state = primeState(ctx);

  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-2",
      input: { path: "a.ts" },
      content: [{ type: "text", text: "file contents" }],
      isError: false,
    },
    ctx,
  );

  const pair = state.calibrationPairs.at(-1);
  assert.ok(pair, "a calibration pair must be recorded");
  assert.equal(pair.actual, 1, "a successful tool result records actual=1");

  const evidence = getEvidence(ctx, {});
  assert.ok(
    evidence.some((e) => /read succeeded/.test(e.claim)),
    `evidence must say the tool succeeded, got: ${JSON.stringify(evidence.map((e) => e.claim))}`,
  );
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== tool_result calibration tests passed ===");
