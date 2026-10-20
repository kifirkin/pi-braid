/**
 * Fixture: blank selectors read as absent for `session_health` and `error`.
 *
 * A client that emits every schema key sends "" for the keys it does not use.
 * Framework validation converts "" to 0 for `Type.Optional(Type.Number())` and
 * leaves blank strings intact, so each handler is the last boundary that can
 * read a blank as absent. Before the fix:
 *   - `session_health` action=recover stored and echoed a blank `reason` as an
 *     audit note the operator never wrote (a whitespace reason is truthy, so
 *     even the echo guard let it through);
 *   - `error` action=list read the converted 0 as a real limit, and
 *     `slice(-0)` is `slice(0)` - a blank limit returned every captured error,
 *     the opposite of the documented 10.
 *
 * After the fix a blank `reason` is absent from the confirmation and a blank
 * `limit` applies the documented cap. Controls keep the fix from becoming a
 * blanket default: a real reason is echoed, a real limit still caps.
 *
 * Run: node test/runtime/self/test-blank-selector-defaults.mjs
 *      (after npm run build - this test reads dist, not src)
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// BRAID_HOME is pinned before the dist imports: session health and the error
// store both resolve their durable paths under it.
process.env.HOME = mkdtempSync(join(tmpdir(), "blank-selector-self-"));
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "blank-selector-self-braid-"));

const { registerSessionHealthTool } = await import(
  "../../../dist/extensions/self/health-maintenance/handlers/session-health-tool.js"
);
const { default: errorCaptureExtension } = await import(
  "../../../dist/extensions/self/error-tracking/index.js"
);
const { errorsFilePath } = await import("../../../dist/lib/config/braid-paths.js");
const { validateToolArguments } = await import("@earendil-works/pi-ai/utils/validation");

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

/** Drive raw arguments through the framework's own conversion, as pi-core does before a handler runs. */
function validated(tool, raw) {
  return validateToolArguments(
    { name: tool.name, parameters: tool.parameters },
    { name: tool.name, arguments: raw },
  );
}

let seq = 0;
function makeCtx() {
  const file = `blank-selector-${seq++}.jsonl`;
  return {
    cwd: process.env.BRAID_HOME,
    mode: "test",
    hasUI: false,
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => file,
      getLabel: () => undefined,
      getBranch: () => [],
      getTree: () => [],
    },
  };
}

function makePi() {
  return {
    tools: [],
    registerTool(tool) {
      this.tools.push(tool);
    },
    on() {},
    sendMessage() {},
  };
}

// ── session_health: a blank reason is no reason ────────────────────────────

console.log("=== session_health: a blank reason is absent ===\n");

function sessionHealthTool() {
  const pi = makePi();
  registerSessionHealthTool(pi);
  const tool = pi.tools.find((t) => t.name === "session_health");
  assert.ok(tool, "session_health registered");
  return tool;
}

await test("blank reason is absent from the confirmation", async () => {
  const tool = sessionHealthTool();
  const args = await validated(tool, { action: "recover", reason: "" });
  assert.equal(args.reason, "", "a blank string reaches the handler unchanged (tested path)");
  const result = await tool.execute("sh1", args, null, null, makeCtx());
  assert.equal(result.details.recovered, true, "the recovery itself still happens");
  assert.doesNotMatch(
    result.content[0].text,
    /Reason:/,
    "a reason the operator never wrote must not be echoed",
  );
});

await test("whitespace-only reason is absent from the confirmation", async () => {
  const tool = sessionHealthTool();
  const result = await tool.execute(
    "sh2",
    { action: "recover", reason: "  \n\t" },
    null,
    null,
    makeCtx(),
  );
  assert.doesNotMatch(result.content[0].text, /Reason:/, "whitespace is not a reason");
});

await test("control: a real reason is still echoed", async () => {
  const tool = sessionHealthTool();
  const args = await validated(tool, { action: "recover", reason: "balance topped up" });
  const result = await tool.execute("sh3", args, null, null, makeCtx());
  assert.match(result.content[0].text, /Reason: balance topped up/);
});

// ── error: a blank limit applies the documented cap ────────────────────────

console.log("\n=== error: a blank limit applies the documented 10 ===\n");

const ERROR_COUNT = 25;
{
  const file = errorsFilePath();
  mkdirSync(dirname(file), { recursive: true });
  const now = Date.now();
  const lines = Array.from({ length: ERROR_COUNT }, (_, i) =>
    JSON.stringify({
      id: `err_${i + 1}`,
      timestamp: now - i * 1000,
      source: "tools",
      message: `captured failure ${i + 1}`,
      handled: false,
    }),
  );
  writeFileSync(file, lines.join("\n") + "\n");
}

function errorTool() {
  const pi = makePi();
  errorCaptureExtension(pi);
  const tool = pi.tools.find((t) => t.name === "error");
  assert.ok(tool, "error tool registered");
  return tool;
}

await test("blank limit returns the documented 10, not every error", async () => {
  const tool = errorTool();
  const args = await validated(tool, { action: "list", limit: "" });
  assert.equal(args.limit, 0, "the framework converts the blank limit to 0 (tested path)");
  const result = await tool.execute("e1", args, null, null, makeCtx());
  assert.equal(result.details.total, ERROR_COUNT, `all ${ERROR_COUNT} entries are in the store`);
  assert.equal(result.details.count, 10, "the documented cap applies to a blank limit");
  assert.equal(result.content[0].text.split("\n").length, 10);
});

await test("control: a real limit still caps the list", async () => {
  const tool = errorTool();
  const args = await validated(tool, { action: "list", limit: 3 });
  assert.equal(args.limit, 3);
  const result = await tool.execute("e2", args, null, null, makeCtx());
  assert.equal(result.details.count, 3);
  assert.equal(result.details.total, ERROR_COUNT);
});

await test("control: an omitted limit keeps the schema default", async () => {
  const tool = errorTool();
  const args = await validated(tool, { action: "list" });
  const result = await tool.execute("e3", args, null, null, makeCtx());
  assert.equal(result.details.count, 10, "the absent limit and the blank limit agree");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== self blank-selector fixture passed ===");
