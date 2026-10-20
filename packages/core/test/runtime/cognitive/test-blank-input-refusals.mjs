/**
 * Fixture: a blank required input is refused by name, and a blank optional
 * selector is absent, in the cognitive tools that record state or pass
 * judgement.
 *
 * A client that emits every schema key sends "" for the keys it does not use.
 * Framework validation leaves blank STRINGS intact (only numerics are
 * converted, to 0), so the handler is the only boundary that can read a blank
 * as absent. Before the fix:
 *   - finalize's `summary` was `=== undefined`-checked, so a blank summary was
 *     handed on as the task summary (session memory, the session label, the
 *     deliverables manifest);
 *   - topic_drift measured a blank `output` as an empty response and answered
 *     "No topic drift" - a pass for a check that never ran - and a blank
 *     `newRequest` overwrote the tracked request with "";
 *   - verify_claim kept a blank `claimId` as the tracking id.
 *
 * After the fix the required inputs are refused by name and the optional ones
 * read as absent. Controls keep the fix from becoming a blanket refusal: a
 * real summary finalizes, a real request re-anchors, a real claimId is kept.
 *
 * Run: node test/runtime/cognitive/test-blank-input-refusals.mjs
 *      (after npm run build - this test reads dist, not src)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME and BRAID_HOME are redirected before the dist imports: finalize's
// fire-and-forget writers resolve the memory and evidence stores under them.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "blank-input-cognitive-"));
process.env.HOME = FAKE_HOME;
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "blank-input-cognitive-braid-"));

const { createFinalizeTool } = await import(
  "../../../dist/extensions/cognitive/metacognition/handlers/finalize.js"
);
const { createVerifyClaimTool } = await import(
  "../../../dist/extensions/cognitive/metacognition/handlers/claim-verification.js"
);
const { default: topicDriftExtension } = await import(
  "../../../dist/extensions/cognitive/topic-drift/index.js"
);
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
  const file = `blank-input-${seq++}.jsonl`;
  return {
    cwd: FAKE_HOME,
    mode: "test",
    hasUI: false,
    model: undefined,
    modelRegistry: {},
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => file,
      getLeafId: () => "leaf-1",
      getLabel: () => undefined,
      getBranch: () => [],
      getTree: () => [],
    },
  };
}

function makePi() {
  const messages = [];
  const handlers = new Map();
  return {
    tools: [],
    messages,
    handlers,
    registerTool(tool) {
      this.tools.push(tool);
    },
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    setLabel() {},
    sendMessage(params, options) {
      messages.push({ params, options });
    },
  };
}

// ── finalize: a blank summary names nothing ────────────────────────────────

console.log("=== finalize: blank summary refused by name ===\n");

await test("blank summary is refused by name and records nothing", async () => {
  const calls = [];
  const tool = createFinalizeTool({
    onFinalize: (summary, completed) => calls.push({ summary, completed }),
  });
  const args = await validated(tool, { completed: true, summary: "" });
  assert.equal(args.summary, "", "a blank string reaches the handler unchanged (tested path)");
  const result = await tool.execute("f1", args, null, null, makeCtx());
  assert.equal(result.details.error, "missing_summary", "the refusal names the missing field");
  assert.equal(result.details.finalized, false);
  assert.match(result.content[0].text, /FINALIZE REQUIRES A SUMMARY/);
  assert.equal(calls.length, 0, "nothing was recorded as the task summary");
});

await test("whitespace-only summary is refused too", async () => {
  const calls = [];
  const tool = createFinalizeTool({
    onFinalize: (summary, completed) => calls.push({ summary, completed }),
  });
  const result = await tool.execute(
    "f2",
    { completed: false, summary: "   \n\t " },
    null,
    null,
    makeCtx(),
  );
  assert.equal(result.details.error, "missing_summary");
  assert.equal(calls.length, 0, "whitespace is not a summary");
});

await test("control: a real summary still finalizes", async () => {
  const calls = [];
  const tool = createFinalizeTool({
    onFinalize: (summary, completed) => calls.push({ summary, completed }),
  });
  const args = await validated(tool, { completed: true, summary: "Fixed the offset clamp" });
  const result = await tool.execute("f3", args, null, null, makeCtx());
  assert.equal(result.details.error, undefined, "no refusal");
  assert.equal(calls.length, 1, "the summary reaches the recording path");
  assert.equal(calls[0].summary, "Fixed the offset clamp");
  assert.equal(calls[0].completed, true);
});

// ── topic_drift: blank output refused, blank newRequest absent ─────────────

console.log("\n=== topic_drift: blank output refused, blank newRequest absent ===\n");

const ANCHOR = "Refactor the parser module without changing its observable behavior";

/**
 * Register the extension on a fake pi and seed the anchor through the
 * extension's own input hook - the real seeding path, not a state poke.
 */
async function driftToolAndCtx() {
  const pi = makePi();
  topicDriftExtension(pi);
  const tool = pi.tools.find((t) => t.name === "topic_drift");
  assert.ok(tool, "topic_drift registered");
  const ctx = makeCtx();
  for (const fn of pi.handlers.get("input") ?? []) await fn({ text: ANCHOR }, ctx);
  return { tool, ctx };
}

await test("blank output is refused, not answered as 'no drift'", async () => {
  const { tool, ctx } = await driftToolAndCtx();
  const args = await validated(tool, { action: "check", output: "" });
  assert.equal(args.output, "", "a blank string reaches the handler unchanged (tested path)");
  const result = await tool.execute("td1", args, null, null, ctx);
  assert.equal(result.details.error, "missing_output", "the refusal names the missing field");
  assert.match(result.content[0].text, /requires a non-empty 'output'/);
  assert.doesNotMatch(
    result.content[0].text,
    /No topic drift/,
    "a check that never ran must not report a verdict",
  );
});

await test("blank newRequest keeps the tracked request", async () => {
  const { tool, ctx } = await driftToolAndCtx();
  const blank = await validated(tool, { action: "reset", newRequest: "" });
  assert.equal(blank.newRequest, "", "a blank string reaches the handler unchanged (tested path)");
  const result = await tool.execute("td2", blank, null, null, ctx);
  assert.equal(
    result.details.originalRequest,
    ANCHOR,
    "a blank newRequest is absent, so the tracked request stands",
  );

  const whitespace = await tool.execute(
    "td3",
    { action: "reset", newRequest: "  \n " },
    null,
    null,
    ctx,
  );
  assert.equal(whitespace.details.originalRequest, ANCHOR, "whitespace is not a new request");
});

await test("control: a real newRequest re-anchors", async () => {
  const { tool, ctx } = await driftToolAndCtx();
  const result = await tool.execute(
    "td4",
    { action: "reset", newRequest: "Migrate the parser to the streaming tokenizer" },
    null,
    null,
    ctx,
  );
  assert.equal(result.details.originalRequest, "Migrate the parser to the streaming tokenizer");
});

// ── verify_claim: a blank claimId is no id ─────────────────────────────────

console.log("\n=== verify_claim: a blank claimId generates one ===\n");

await test("blank claimId is replaced by a generated id", async () => {
  const tool = createVerifyClaimTool();
  const args = await validated(tool, {
    action: "claim",
    claim: "The parser clamps the offset",
    context: ["parser.ts clamps the offset before slicing"],
    claimId: "",
  });
  assert.equal(args.claimId, "", "a blank string reaches the handler unchanged (tested path)");
  const result = await tool.execute("vc1", args, null, null, makeCtx());
  assert.equal(typeof result.details.claimId, "string", "the result reports its tracking id");
  assert.match(result.details.claimId, /^claim-\d+$/, "a blank claimId is not the tracking id");
});

await test("whitespace-only claimId is replaced too", async () => {
  const tool = createVerifyClaimTool();
  const result = await tool.execute(
    "vc2",
    { action: "claim", claim: "The guard holds", context: ["the guard holds"], claimId: "   " },
    null,
    null,
    makeCtx(),
  );
  assert.match(result.details.claimId, /^claim-\d+$/);
});

await test("control: a real claimId is kept", async () => {
  const tool = createVerifyClaimTool();
  const args = await validated(tool, {
    action: "claim",
    claim: "The guard holds",
    context: ["the guard holds"],
    claimId: "claim-caller-42",
  });
  const result = await tool.execute("vc3", args, null, null, makeCtx());
  assert.equal(result.details.claimId, "claim-caller-42");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== blank-input refusal fixture passed ===");
