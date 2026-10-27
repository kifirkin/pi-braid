/**
 * Path-miss steer — the failure that says what would have worked.
 *
 * Incident shape: an exploration turn guesses a path, the tool reports a
 * missing file, and nothing at that moment says that listing the directory is
 * the cheaper move. The result is a run of guessed reads. This fixture drives
 * the real extension with the tool-result shapes the tools actually emit
 * (measured from `read`, `edit` and `bash`, not invented) and holds the line
 * to: one steer per turn, the missing path named, the cheaper instruments
 * named, no repeat for a path already steered this session, and nothing at all
 * for a successful call, a permission error, or a tool outside the class.
 *
 * Run: node test/runtime/self/test-path-miss-whisper.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// Pin the persistent tree BEFORE the dist imports: braid-settings bakes its
// settings path from homedir() at module-eval time.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "braid-pathmiss-home-"));
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-pathmiss-braid-"));
process.env.HOME = FAKE_HOME;
process.env.BRAID_HOME = BRAID_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST = join(ROOT, "dist");

const { default: pathMissExtension, _resetForTests } = await import(
  join(DIST, "extensions", "self", "path-miss", "index.js")
);
const { beginTurn } = await import(join(DIST, "lib", "enforcement", "turn-dedup.js"));
const { clearAllBuckets } = await import(join(DIST, "lib", "utils", "injection-tracker.js"));

console.log("=== path-miss steer ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(` [v] ${name}`);
  } catch (e) {
    failed++;
    console.log(` [x] ${name}: ${e.message}`);
  }
}

/** Minimal ExtensionAPI double: captures handlers and every delivered message. */
function fakePi() {
  const handlers = new Map();
  const sent = [];
  return {
    handlers,
    sent,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    getAllTools: () => [],
    getActiveTools: () => [],
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    sendUserMessage() {},
  };
}

function fakeCtx(sessionId) {
  return {
    cwd: "/tmp/proj",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getBranch: () => [],
    },
  };
}

function harness() {
  const pi = fakePi();
  pathMissExtension(pi);
  const handler = pi.handlers.get("tool_result")?.at(-1);
  assert.ok(typeof handler === "function", "the extension registers a tool_result handler");
  const emit = (event, ctx) =>
    handler(
      {
        type: "tool_result",
        toolCallId: `call-${Math.random().toString(36).slice(2)}`,
        input: {},
        isError: true,
        ...event,
      },
      ctx,
    );
  /** One turn boundary, driven through the extension's own `input` handler. */
  const newTurn = () => {
    beginTurn();
    clearAllBuckets();
    for (const onInput of pi.handlers.get("input") ?? []) {
      onInput({ type: "input", text: "go" }, fakeCtx("turn"));
    }
  };
  return { pi, emit, newTurn };
}

const text = (s) => [{ type: "text", text: s }];
const steerBody = (entry) => entry.params.content.map((c) => c.text ?? "").join("\n");

// Measured shapes, verbatim from the tools on this platform.
const READ_MISS =
  "ENOENT: no such file or directory, access '/private/tmp/proj/src/extensions/self/path-miss/index.ts'";
const EDIT_MISS = "Could not edit file: /private/tmp/proj/src/lib/toolz/wat.ts. Error code: ENOENT.";
const BASH_LS_MISS = "ls: /private/tmp/proj/fixtures: No such file or directory";
const BASH_CD_MISS = "/bin/bash: line 0: cd: /private/tmp/proj/nope: No such file or directory";
const EACCES = "EACCES: permission denied, open '/private/tmp/proj/secrets.env'";

// ── the line ───────────────────────────────────────────────────────────────

await test("a read that misses a path produces one steer naming path and instruments", async () => {
  _resetForTests();
  const { pi, emit, newTurn } = harness();
  newTurn();
  await emit(
    {
      toolName: "read",
      input: { path: "/private/tmp/proj/src/extensions/self/path-miss/index.ts" },
      content: text(READ_MISS),
    },
    fakeCtx("s-1"),
  );
  assert.equal(pi.sent.length, 1, `one steer (got ${pi.sent.length})`);
  const body = steerBody(pi.sent[0]);
  assert.ok(
    body.includes("/private/tmp/proj/src/extensions/self/path-miss/index.ts"),
    `names the path that missed: ${body}`,
  );
  for (const instrument of ["ls", "find", "explore_paths"]) {
    assert.ok(body.includes(instrument), `names ${instrument}: ${body}`);
  }
  assert.equal(pi.sent[0].options?.deliverAs, "steer", "delivered as a steer");
  assert.equal(pi.sent[0].params.customType, "path-miss", "customType names the emitter");
});

await test("the bash cd shape is read as a path miss and named", async () => {
  _resetForTests();
  const { pi, emit, newTurn } = harness();
  newTurn();
  await emit(
    { toolName: "bash", input: { command: "cd /private/tmp/proj/nope" }, content: text(BASH_CD_MISS) },
    fakeCtx("s-2"),
  );
  assert.equal(pi.sent.length, 1, `one steer (got ${pi.sent.length})`);
  assert.ok(
    steerBody(pi.sent[0]).includes("/private/tmp/proj/nope"),
    `names the path: ${steerBody(pi.sent[0])}`,
  );
});

await test("the bash ls shape is read as a path miss and named", async () => {
  _resetForTests();
  const { pi, emit, newTurn } = harness();
  newTurn();
  await emit(
    {
      toolName: "bash",
      input: { command: "ls /private/tmp/proj/fixtures" },
      content: text(BASH_LS_MISS),
    },
    fakeCtx("s-3"),
  );
  assert.equal(pi.sent.length, 1, `one steer (got ${pi.sent.length})`);
  assert.ok(
    steerBody(pi.sent[0]).includes("/private/tmp/proj/fixtures"),
    `names the path: ${steerBody(pi.sent[0])}`,
  );
});

await test("the edit shape takes its path from the call, not the text", async () => {
  _resetForTests();
  const { pi, emit, newTurn } = harness();
  newTurn();
  await emit(
    { toolName: "edit", input: { path: "/private/tmp/proj/src/lib/toolz/wat.ts" }, content: text(EDIT_MISS) },
    fakeCtx("s-4"),
  );
  assert.equal(pi.sent.length, 1, `one steer (got ${pi.sent.length})`);
  assert.ok(
    steerBody(pi.sent[0]).includes("/private/tmp/proj/src/lib/toolz/wat.ts"),
    `names the path: ${steerBody(pi.sent[0])}`,
  );
});

// ── once per turn, once per path ───────────────────────────────────────────

await test("two identical misses in one turn produce one line", async () => {
  _resetForTests();
  const { pi, emit, newTurn } = harness();
  newTurn();
  const ctx = fakeCtx("s-5");
  const event = {
    toolName: "read",
    input: { path: "/private/tmp/proj/src/missing.ts" },
    content: text("ENOENT: no such file or directory, access '/private/tmp/proj/src/missing.ts'"),
  };
  await emit(event, ctx);
  // The channel allows one low-priority whisper per turn, which would hide a
  // missing guard here as a pass. Reset the channel's turn budget WITHOUT a
  // user input, so the emitter's own turn rule is the only thing left holding
  // the second line back.
  beginTurn();
  clearAllBuckets();
  await emit(event, ctx);
  assert.equal(pi.sent.length, 1, `one line for two misses (got ${pi.sent.length})`);
});

await test("two different misses in one turn still produce one line", async () => {
  _resetForTests();
  const { pi, emit, newTurn } = harness();
  newTurn();
  const ctx = fakeCtx("s-6");
  await emit(
    {
      toolName: "read",
      input: { path: "/private/tmp/proj/a.ts" },
      content: text("ENOENT: no such file or directory, access '/private/tmp/proj/a.ts'"),
    },
    ctx,
  );
  beginTurn();
  clearAllBuckets();
  await emit(
    {
      toolName: "read",
      input: { path: "/private/tmp/proj/b.ts" },
      content: text("ENOENT: no such file or directory, access '/private/tmp/proj/b.ts'"),
    },
    ctx,
  );
  assert.equal(pi.sent.length, 1, `one line per turn (got ${pi.sent.length})`);
});

await test("a new turn on the same path stays quiet", async () => {
  _resetForTests();
  const { pi, emit, newTurn } = harness();
  newTurn();
  const ctx = fakeCtx("s-7");
  const event = {
    toolName: "read",
    input: { path: "/private/tmp/proj/src/missing.ts" },
    content: text("ENOENT: no such file or directory, access '/private/tmp/proj/src/missing.ts'"),
  };
  await emit(event, ctx);
  assert.equal(pi.sent.length, 1, "first turn steers");
  newTurn();
  await emit(event, ctx);
  assert.equal(pi.sent.length, 1, `second turn on the same path adds nothing (got ${pi.sent.length})`);
});

await test("a new path in a later turn steers again", async () => {
  _resetForTests();
  const { pi, emit, newTurn } = harness();
  newTurn();
  const ctx = fakeCtx("s-8");
  await emit(
    {
      toolName: "read",
      input: { path: "/private/tmp/proj/a.ts" },
      content: text("ENOENT: no such file or directory, access '/private/tmp/proj/a.ts'"),
    },
    ctx,
  );
  newTurn();
  await emit(
    {
      toolName: "read",
      input: { path: "/private/tmp/proj/b.ts" },
      content: text("ENOENT: no such file or directory, access '/private/tmp/proj/b.ts'"),
    },
    ctx,
  );
  assert.equal(pi.sent.length, 2, `each new path steers once (got ${pi.sent.length})`);
});

await test("another session's miss on the same path is not suppressed", async () => {
  _resetForTests();
  const { pi, emit, newTurn } = harness();
  newTurn();
  const event = {
    toolName: "read",
    input: { path: "/private/tmp/proj/src/missing.ts" },
    content: text("ENOENT: no such file or directory, access '/private/tmp/proj/src/missing.ts'"),
  };
  await emit(event, fakeCtx("s-9a"));
  newTurn();
  await emit(event, fakeCtx("s-9b"));
  assert.equal(pi.sent.length, 2, `dedup is per session (got ${pi.sent.length})`);
});

// ── the quiet controls ─────────────────────────────────────────────────────

await test("a successful read produces no line", async () => {
  _resetForTests();
  const { pi, emit, newTurn } = harness();
  newTurn();
  await emit(
    {
      toolName: "read",
      isError: false,
      input: { path: "/private/tmp/proj/ok.ts" },
      content: text("export const x = 1;"),
    },
    fakeCtx("s-10"),
  );
  assert.equal(pi.sent.length, 0, `no line for a success (got ${pi.sent.length})`);
});

await test("a permission error produces no line", async () => {
  _resetForTests();
  const { pi, emit, newTurn } = harness();
  newTurn();
  await emit(
    { toolName: "read", input: { path: "/private/tmp/proj/secrets.env" }, content: text(EACCES) },
    fakeCtx("s-11"),
  );
  assert.equal(pi.sent.length, 0, `EACCES is not a path miss (got ${pi.sent.length})`);
});

await test("a tool outside the class produces no line", async () => {
  _resetForTests();
  const { pi, emit, newTurn } = harness();
  newTurn();
  await emit(
    {
      toolName: "grep",
      input: { path: "/private/tmp/proj/src" },
      content: text("ENOENT: no such file or directory, scandir '/private/tmp/proj/src'"),
    },
    fakeCtx("s-12"),
  );
  assert.equal(pi.sent.length, 0, `grep is not in the class (got ${pi.sent.length})`);
});

await test("a missing path outside a tool result produces no line", async () => {
  _resetForTests();
  const { pi, emit, newTurn } = harness();
  newTurn();
  // The same words, arriving on a tool outside the class: the emitter is keyed
  // on a tool result for a path-bearing tool, not on the text alone.
  await emit({ toolName: "list_skills", content: text(READ_MISS) }, fakeCtx("s-13"));
  assert.equal(pi.sent.length, 0, `not a path-miss result (got ${pi.sent.length})`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
