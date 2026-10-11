/**
 * Topic drift must read tool output from the `tool_result` event's content.
 *
 * `extractOutputText` was written against a `tool_execution_end` shape
 * (`event.result`, `event.result.content`, `event.output`, `event.text`).
 * The handler is registered on `tool_result`, whose text lives in
 * `content: (TextContent | ImageContent)[]`; every arm missed, `output`
 * stayed `""`, and the `output.length < 50` early-exit made drift detection
 * on tool results unreachable.
 *
 * This drives the real handler chain: seed the anchor from an `input` event,
 * then deliver a text-bearing tool result. With no model configured the
 * critic reports itself down, and the handler's offline whisper is the
 * observable proof that the output was extracted and the critic was reached.
 *
 * Run: node test/runtime/cognitive/test-topic-drift-tool-output.mjs
 *      (after npm run build — this test reads dist, not src)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME isolation before the dist imports: the critic's model resolution reads
// the settings under HOME, and an empty home keeps this test offline.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "topic-drift-tool-output-"));
process.env.HOME = FAKE_HOME;

const { default: topicDriftExtension } = await import(
  "../../../dist/extensions/cognitive/topic-drift/index.js"
);

console.log("=== topic-drift reads tool_result content ===\n");

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
  const file = `topic-drift-${seq++}-${Date.now()}.jsonl`;
  return {
    cwd: FAKE_HOME,
    model: undefined,
    modelRegistry: {},
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => file,
    },
  };
}

function makePi() {
  const handlers = new Map();
  const messages = [];
  return {
    tools: [],
    messages,
    registerTool(tool) {
      this.tools.push(tool);
    },
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    sendMessage(params, options) {
      messages.push({ params, options });
    },
    async emit(event, payload, ctx) {
      for (const fn of handlers.get(event) ?? []) {
        await fn(payload, ctx);
      }
    },
  };
}

const ANCHOR = "Refactor the parser module without changing its behavior";

await test("text-bearing tool result reaches the drift critic", async () => {
  const pi = makePi();
  topicDriftExtension(pi);
  const ctx = makeCtx();

  await pi.emit("input", { type: "input", text: ANCHOR }, ctx);
  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call-1",
      input: { command: "wc -c src/parser.ts" },
      content: [{ type: "text", text: "x".repeat(80) }],
      isError: false,
    },
    ctx,
  );

  assert.equal(
    pi.messages.length,
    1,
    "the critic ran (offline whisper) instead of the length<50 early-exit",
  );
  const text = pi.messages[0].params.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.match(text, /Topic drift monitor is offline/, "offline whisper body");
});

await test("short tool output still skips detection", async () => {
  const pi = makePi();
  topicDriftExtension(pi);
  const ctx = makeCtx();

  await pi.emit("input", { type: "input", text: ANCHOR }, ctx);
  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call-2",
      input: { command: "true" },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    },
    ctx,
  );

  assert.equal(pi.messages.length, 0, "output under 50 chars must not call the critic");
});

await test("non-text tool result (image only) still skips detection", async () => {
  const pi = makePi();
  topicDriftExtension(pi);
  const ctx = makeCtx();

  await pi.emit("input", { type: "input", text: ANCHOR }, ctx);
  await pi.emit(
    "tool_result",
    {
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-3",
      input: { path: "diagram.png" },
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      isError: false,
    },
    ctx,
  );

  assert.equal(pi.messages.length, 0, "an image-only result has no text to judge");
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== topic-drift tool output tests passed ===");
