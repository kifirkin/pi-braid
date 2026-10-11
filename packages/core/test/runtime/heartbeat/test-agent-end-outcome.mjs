/**
 * The heartbeat session-outcome handler classifies the run from the one
 * member `agent_end` carries.
 *
 * pi declares AgentEndEvent as {type: "agent_end", messages} and emits exactly
 * that (agent-session.js `_emitExtensionEvent`). The handler read
 * `event?.outcome`, `event?.task`, and `event?.error` - none of them exist -
 * so the "Session ended" line always printed "Outcome: unknown" and
 * `success = outcome === "success" || !event?.error` was permanently true.
 *
 * pi classifies its own activity outcome from the final assistant message's
 * stopReason (agent-session.js `_dispatchTurnEndBoundary`: aborted, error, or
 * completed). The handler must derive the same from `messages`.
 *
 * Run: node test/runtime/heartbeat/test-agent-end-outcome.mjs
 *      (after npm run build - this test reads dist, not src)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME redirect BEFORE dist imports: settings resolution walks homedir().
process.env.HOME = mkdtempSync(join(tmpdir(), "agent-end-outcome-"));

const { default: heartbeatExtension } = await import(
  "../../../dist/extensions/heartbeat/heartbeat-scheduler/index.js"
);
const logger = await import("../../../dist/lib/core/logger.js");

console.log("=== agent_end outcome derives from the last assistant message ===\n");

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
  const file = `agent-end-outcome-${seq++}-${Date.now()}.jsonl`;
  return {
    cwd: `/tmp/agent-end-outcome-${seq}`,
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => file,
    },
  };
}

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

function assistantMessage(stopReason) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "..." }],
    api: "anthropic",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason,
    timestamp: 2,
  };
}

function outcomeLine(stopReason) {
  return `Outcome: ${
    stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error" : "completed"
  }`;
}

const pi = makePi();
heartbeatExtension(pi);

for (const stopReason of ["error", "aborted", "stop"]) {
  await test(`an assistant message with stopReason=${stopReason} logs the derived outcome`, async () => {
    const ctx = makeCtx();
    logger.clearLogBuffer();

    await pi.emit(
      "agent_end",
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "do the thing", timestamp: 1 },
          assistantMessage(stopReason),
        ],
      },
      ctx,
    );

    const lines = logger.getLogBuffer().map((entry) => entry.message);
    const ended = lines.find((line) => line.includes("Session ended."));
    assert.ok(ended, `the session-end line was logged (got: ${JSON.stringify(lines)})`);
    assert.ok(
      ended.includes(outcomeLine(stopReason)),
      `expected "${outcomeLine(stopReason)}" in "${ended}"`,
    );
    assert.ok(
      !ended.includes("Outcome: unknown"),
      "the phantom event.outcome must not leave the log at unknown",
    );
  });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== agent_end outcome tests passed ===");
