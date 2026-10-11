/**
 * Metacognition tool metrics must be fed from the event that carries them.
 *
 * The extension subscribed to `tool_execution_end` and read `event.params` /
 * `event.details`. That event is `{toolCallId, toolName, result, isError}` —
 * no params, and details live at `result.details`. Every counter it drives
 * (depth distribution, tag histogram, confidence total, hypotheses /
 * finalizations / verifications) therefore stayed at zero.
 *
 * The `tool_result` event is the one carrying both halves: `input` (the
 * validated arguments) and `details` (the tool's result details). This test
 * drives the four metacognition tools through that event and pins every
 * counter the extension declares.
 *
 * Run: node test/runtime/cognitive/test-metacognition-metrics.mjs
 *      (after npm run build — this test reads dist, not src)
 */

import { strict as assert } from "node:assert";

const { default: metacognitionExtension } = await import(
  "../../../dist/extensions/cognitive/metacognition/index.js"
);
const { getExtensionState } = await import("../../../dist/lib/state/extension-state.js");

console.log("=== metacognition tool metrics ===\n");

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

function makeCtx() {
  const file = `metacognition-metrics-${seq++}-${Date.now()}.jsonl`;
  return {
    cwd: "/tmp",
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => file,
    },
  };
}

function makePi() {
  const handlers = new Map();
  return {
    tools: [],
    registerTool(tool) {
      this.tools.push(tool);
    },
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

/** Same bucket the extension writes: same session key, same state key. */
function readMetrics(ctx) {
  return getExtensionState(ctx, "metacognition-metrics", () => ({}));
}

function toolResult(toolName, input, details) {
  return {
    type: "tool_result",
    toolName,
    toolCallId: `call-${toolName}`,
    input,
    content: [{ type: "text", text: "ok" }],
    details,
    isError: false,
  };
}

await test("think: depth, tags and confidence accumulate from the input", async () => {
  const pi = makePi();
  metacognitionExtension(pi);
  const ctx = makeCtx();

  await pi.emit(
    "tool_result",
    toolResult(
      "think",
      { depth: "deep", tags: ["alpha", "beta"], confidence: 0.9 },
      { thought_id: "t1", confidence: 0.9 },
    ),
    ctx,
  );
  // No depth argument: the handler's documented default is "quick".
  await pi.emit("tool_result", toolResult("think", { observation: "short" }, { thought_id: "t2" }), ctx);

  const m = readMetrics(ctx);
  assert.equal(m.thinks, 2, "two think calls counted");
  assert.equal(m.depthDistribution.deep, 1, "explicit depth recorded");
  assert.equal(m.depthDistribution.quick, 1, "missing depth defaults to quick");
  assert.equal(m.reasoningTags.alpha, 1, "tag histogram records alpha");
  assert.equal(m.reasoningTags.beta, 1, "tag histogram records beta");
  assert.ok(Math.abs(m.totalConfidence - 0.9) < 1e-9, "confidence accumulates");
});

await test("hypothesize: generated count and verification-plan signal", async () => {
  const pi = makePi();
  metacognitionExtension(pi);
  const ctx = makeCtx();

  await pi.emit(
    "tool_result",
    toolResult(
      "hypothesize",
      { maxHypotheses: 4 },
      {
        problem: "p",
        hypotheses: 4,
        scores: [
          { rank: 1, signals: ["verification-plan"] },
          { rank: 2, signals: ["other"] },
        ],
      },
    ),
    ctx,
  );

  const m = readMetrics(ctx);
  assert.equal(m.hypothesizes, 1, "one hypothesize call counted");
  assert.equal(m.hypothesesGenerated, 4, "requested/generated count accumulates");
  assert.equal(
    m.hypothesesWithVerification,
    1,
    "a result whose scores carry a verification plan is counted",
  );
});

await test("finalize: blocked result increments the blocked counter", async () => {
  const pi = makePi();
  metacognitionExtension(pi);
  const ctx = makeCtx();

  await pi.emit(
    "tool_result",
    toolResult("finalize", { summary: "s" }, { finalized: false, blocked: true }),
    ctx,
  );

  const m = readMetrics(ctx);
  assert.equal(m.finalizes, 1, "one finalize call counted");
  assert.equal(m.finalizationsBlocked, 1, "blocked finalize counted");
});

await test("verify: passed result increments the passed counter", async () => {
  const pi = makePi();
  metacognitionExtension(pi);
  const ctx = makeCtx();

  await pi.emit("tool_result", toolResult("verify", {}, { passed: true }), ctx);

  const m = readMetrics(ctx);
  assert.equal(m.verifies, 1, "one verify call counted");
  assert.equal(m.verificationsPassed, 1, "passed verification counted");
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== metacognition metrics tests passed ===");
