/**
 * Session recall reads sessions where pi actually keeps them.
 *
 * Contract:
 *   (a) the resolver returns the session manager's directory when it is a
 *       configured sessionDir (a relocated root);
 *   (b) under pi's default layout (one encoded-cwd directory under the
 *       agent's sessions root) it returns the root, so the cross-project scan
 *       keeps its scope;
 *   (c) with no session manager it falls back to the agent directory
 *       resolved through pi (PI_CODING_AGENT_DIR honored);
 *   (d) the `session` search action reads a relocated session tree through
 *       the ctx it was given;
 *   (e) a blank `limit` (converted to 0 by argument validation) is read as
 *       absent: `batch` and `stats` answer with the documented 10 sessions
 *       instead of switching to the old unbounded/"all" mode; a real limit
 *       still caps both.
 *
 * Run: node test/runtime/memory/test-session-recall-session-dir.mjs
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { getSessionsDir } = await import(
  join(ROOT, "dist", "extensions", "memory", "session-recall", "search.js")
);
const sessionRecallExtension = (
  await import(join(ROOT, "dist", "extensions", "memory", "session-recall", "index.js"))
).default;

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  [ok] ${name}`);
    })
    .catch((e) => {
      failed++;
      console.log(`  [fail] ${name}: ${e.message}`);
    });
}

const TMP = mkdtempSync(join(tmpdir(), "session-dir-pin-"));
// Generated per run: a literal token would already sit in the session corpus
// that the pre-fix resolver scans, which would mask the wiring defect.
const TOKEN = `recall-pin-token-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

/** ExtensionAPI double: captures registered tools. */
function fakePi() {
  const tools = new Map();
  return {
    tools,
    on() {},
    registerTool(def) {
      tools.set(def.name, def);
    },
  };
}

console.log("session-recall session-dir test\n");

await test("configured sessionDir is returned as the search root", () => {
  const relocated = join(TMP, "relocated-sessions");
  const ctx = { sessionManager: { getSessionDir: () => relocated } };
  assert.equal(getSessionsDir(ctx), relocated);
});

await test("default layout returns the sessions root, not the encoded project dir", () => {
  const agentDir = join(TMP, "agent-home");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const projectDir = join(agentDir, "sessions", "--private-tmp-pin--");
    const ctx = { sessionManager: { getSessionDir: () => projectDir } };
    assert.equal(getSessionsDir(ctx), join(agentDir, "sessions"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

await test("no session manager falls back to the agent directory pi resolves", () => {
  const agentDir = join(TMP, "fallback-agent-home");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    assert.equal(getSessionsDir(), join(agentDir, "sessions"));
    assert.equal(getSessionsDir({}), join(agentDir, "sessions"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

await test("the search action reads the relocated session tree", async () => {
  const relocated = join(TMP, "relocated-tree");
  mkdirSync(relocated, { recursive: true });
  writeFileSync(
    join(relocated, "2026-10-05T00-00-00-000Z_pin-session.jsonl"),
    JSON.stringify({
      type: "session",
      version: 3,
      id: "pin-session",
      timestamp: "2026-10-05T00:00:00.000Z",
      cwd: "/private/tmp/pin-workspace",
    }) +
      "\n" +
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-10-05T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: `fixture ${TOKEN}` }] },
      }) +
      "\n",
    "utf-8",
  );

  const pi = fakePi();
  sessionRecallExtension(pi);
  const tool = pi.tools.get("session");
  assert.ok(tool, "session tool must be registered");

  const ctx = {
    cwd: "/private/tmp/pin-workspace",
    sessionManager: { getSessionDir: () => relocated },
  };
  const result = await tool.execute(
    "call-1",
    { action: "search", query: TOKEN },
    undefined,
    undefined,
    ctx,
  );
  const text = result.content.map((c) => c.text ?? "").join("\n");
  // Assert on the session file path, not the query: the no-match message
  // echoes the query, so a query-shaped assertion passes vacuously.
  assert.ok(
    text.includes("2026-10-05T00-00-00-000Z_pin-session.jsonl"),
    `relocated session must be found, got:\n${text}`,
  );
});

// ── blank limit means the documented default, not the old "all" mode ────────
// A client that emits every schema key sends "" for `limit`, and argument
// validation converts it to 0 before the handler runs. 0 was the documented
// "all sessions" mode, so a blank-limit batch listed every matching session
// (flooding context) while a blank-limit stats rendered "Top 0 sessions".

const { validateToolArguments } = await import("@earendil-works/pi-ai/utils/validation");

const LIMIT_TOKEN = `blank-limit-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const limitTree = join(TMP, "limit-tree");
mkdirSync(limitTree, { recursive: true });
const SESSION_FILES = 12;
for (let i = 0; i < SESSION_FILES; i++) {
  const day = String((i % 9) + 1).padStart(2, "0");
  writeFileSync(
    join(limitTree, `2026-10-${day}T00-00-00-000Z_limit-${i}.jsonl`),
    JSON.stringify({
      type: "message",
      id: `m${i}`,
      timestamp: `2026-10-${day}T00:00:01.000Z`,
      message: { role: "user", content: [{ type: "text", text: `fixture ${LIMIT_TOKEN}` }] },
    }) + "\n",
    "utf-8",
  );
}

const limitPi = fakePi();
sessionRecallExtension(limitPi);
const limitTool = limitPi.tools.get("session");
const limitCtx = {
  cwd: "/private/tmp/limit-workspace",
  sessionManager: { getSessionDir: () => limitTree },
};

function validatedSessionArgs(raw) {
  return validateToolArguments(
    { name: "session", parameters: limitTool.parameters },
    { name: "session", arguments: raw },
  );
}

await test("batch with a blank limit lists the documented 10 sessions", async () => {
  const args = validatedSessionArgs({
    action: "batch",
    pattern: LIMIT_TOKEN,
    project: "all",
    limit: "",
  });
  assert.equal(args.limit, 0, "the framework converts the blank limit to 0 (tested path)");
  const result = await limitTool.execute("call-2", args, undefined, undefined, limitCtx);
  assert.equal(result.details.sessionCount, SESSION_FILES);
  assert.equal(result.details.appliedFilters.limit, 10);
  assert.equal(
    result.details.topSessions.length,
    10,
    "a blank limit must not switch to the unbounded mode",
  );
});

await test("batch control: a real limit still caps the listing", async () => {
  const result = await limitTool.execute(
    "call-3",
    validatedSessionArgs({ action: "batch", pattern: LIMIT_TOKEN, project: "all", limit: 2 }),
    undefined,
    undefined,
    limitCtx,
  );
  assert.equal(result.details.appliedFilters.limit, 2);
  assert.equal(result.details.topSessions.length, 2);
});

await test("stats with a blank limit renders the documented 10 sessions", async () => {
  const args = validatedSessionArgs({ action: "stats", project: "all", limit: "" });
  assert.equal(args.limit, 0, "the framework converts the blank limit to 0 (tested path)");
  const result = await limitTool.execute("call-4", args, undefined, undefined, limitCtx);
  assert.equal(result.details.sessionCount, SESSION_FILES);
  assert.equal(result.details.appliedFilters.limit, 10);
  assert.equal(result.details.topSessions.length, 10);
});

await test("stats control: a real limit still caps the top list", async () => {
  const result = await limitTool.execute(
    "call-5",
    validatedSessionArgs({ action: "stats", project: "all", limit: 3 }),
    undefined,
    undefined,
    limitCtx,
  );
  assert.equal(result.details.topSessions.length, 3);
});

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
