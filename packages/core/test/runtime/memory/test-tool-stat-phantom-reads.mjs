/**
 * Tool reliability records only the members pi's `tool_result` event declares.
 *
 * pi declares ToolResultEvent as {toolName, toolCallId, input, content,
 * details, structuredContent?, isError, usage?} and emits exactly that shape
 * (agent-session.js `_afterToolCall`). It carries no `tool`, no `duration`,
 * and no `error`. The three-memory-stores handler read all three as
 * fallbacks: `event?.tool` masked by `toolName`, `event?.error != null`
 * masked by `isError`, and `event?.duration` feeding the tool-stat duration,
 * which on a real event is always its `?? 0` default.
 *
 * This test drives the extension's tool_result handler with declared-shape
 * events and with events carrying the phantom members. Only the declared
 * members may affect the recorded stats.
 *
 * Run: node test/runtime/memory/test-tool-stat-phantom-reads.mjs
 *      (after npm run build - this test reads dist, not src)
 */

import { strict as assert } from "node:assert";

const { default: threeMemoryStoresExtension, getState } = await import(
  "../../../dist/extensions/memory/three-memory-stores/index.js"
);

console.log("=== tool stats read only the declared tool_result surface ===\n");

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
  const file = `tool-stat-phantom-${seq++}-${Date.now()}.jsonl`;
  return {
    cwd: `/tmp/tool-stat-phantom-${seq}`,
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

await test("declared toolName/isError record the call", async () => {
  const pi = makePi();
  threeMemoryStoresExtension(pi);
  const ctx = makeCtx();

  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call-1",
      input: { command: "true" },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    },
    ctx,
  );

  const state = getState(ctx);
  const stat = state.toolStats.get("bash:command_execution");
  assert.ok(stat, "declared toolName records a bash:command_execution stat");
  assert.equal(stat.attempts, 1, "one attempt recorded");
  assert.equal(stat.successes, 1, "declared isError=false records success");
  assert.equal(stat.avgDuration, 0, "no duration is recorded (pi provides none)");
});

await test("phantom event.tool/duration/error members are ignored", async () => {
  const pi = makePi();
  threeMemoryStoresExtension(pi);
  const ctx = makeCtx();

  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      // Members a real event never carries; a reader must not consume them.
      tool: "phantom-saw",
      duration: 1234,
      error: "phantom-error",
      toolCallId: "call-2",
      input: {},
      content: [],
    },
    ctx,
  );

  const state = getState(ctx);
  assert.equal(
    state.toolStats.has("phantom-saw:general"),
    false,
    "event.tool must not be read",
  );
  const stat = state.toolStats.get("unknown:general");
  assert.ok(stat, "missing toolName falls back to the literal unknown");
  assert.equal(stat.attempts, 1, "one attempt recorded");
  assert.equal(stat.successes, 1, "event.error must not flip the success flag");
  assert.equal(stat.avgDuration, 0, "event.duration must not be read");
});

await test("declared isError=true still records a failure", async () => {
  const pi = makePi();
  threeMemoryStoresExtension(pi);
  const ctx = makeCtx();

  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-3",
      input: { path: "/nope" },
      content: [{ type: "text", text: "ENOENT" }],
      isError: true,
    },
    ctx,
  );

  const state = getState(ctx);
  const stat = state.toolStats.get("read:file_read");
  assert.ok(stat, "declared toolName records a read:file_read stat");
  assert.equal(stat.attempts, 1, "one attempt recorded");
  assert.equal(stat.successes, 0, "declared isError=true records a failure");
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== tool-stat phantom-read tests passed ===");
