/**
 * Fixture test (P1v2): archive feedback is HONEST and the compact is never
 * skipped on a linear-token estimate (the estimate-and-skip bug).
 *
 * (a) LOW real context (<30%): archive skips the follow-up compact because
 * consumption is genuinely low, and reports it honestly — no fabricated
 * "estimated after X%"number.
 * (b) MID context where the OLD linear estimate (percent * count/sessionLength)
 * predicts <30% post: the compact MUST still fire (real usage is >=30%,
 * so skipping on the estimate would drop a needed compaction).
 *
 * Old behavior fails: (a) reported a fake "estimated after X% — skipped"; (b)
 * skipped the real compact while real usage stayed high.
 *
 * Run: node test/runtime/memory/test-compress-estimate-honest.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Hermetic settings isolation (re-baseline) ──────────────────────
// context_compress verifies real usage through the ONE resolver
// (lib/config/braid-settings.ts) reading <homedir()>/.pi/agent/settings.json
// — the live 262k override recomputed the fixture's 200k-window percent and
// broke the "Before: 45.0% used"pins. Redirect HOME to a temp dir BEFORE the
// dist imports (os.homedir() reads $HOME on POSIX — same seam as
// test-context-limit-config.mjs; mock.method(os, "homedir") is not viable
// because braid-settings captures the named import and bakes SETTINGS_PATH at
// module-eval time) and write the EXPLICIT contextLimitTokens this scenario
// pins: 200_000 — the provider window the fixtures were written against (now
// pinned explicitly so the suite passes regardless of live settings.json).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w85b-estimate-honest-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: 200_000 } } }),
);

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

const { registerContextCompress } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/tools/context-compress.js")
);

function makeFakePi() {
  const handlers = new Map();
  const tools = new Map();
  return {
    handlers,
    tools,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    // The documented durable-entry seam; this suite asserts other surfaces.
    appendEntry() {},
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      for (const h of handlers.get(name) ?? []) {
        await Promise.resolve(h(event, ...args)).catch((e) => {
          throw e;
        });
      }
    },
  };
}

let sessionSeq = 0;
function makeFakeCtx({ percent = 45, branchLength = 10 } = {}) {
  const sessionId = `sess-${++sessionSeq}`;
  const branch = [];
  for (let i = 0; i < branchLength; i++) {
    branch.push({
      id: `e${i}`,
      type: "message",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [
          {
            type: "text",
            // Branch content sized so the session-tree measure (the live
            // metric's source) reports the intended percent; the fake
            // accessor below stays in agreement with the branch.
            text: `msg ${i} ${"x".repeat(
              Math.max(0, Math.round(((percent / 100) * 200000 * 4) / branchLength) - 7),
            )}`,
          },
        ],
        timestamp: 1000 + i,
      },
    });
  }
  const ctx = {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    getContextUsage: () => ({
      percent,
      tokens: Math.round((percent / 100) * 200000),
      contextWindow: 200000,
    }),
    compactCalls: [],
    compact(options) {
      this.compactCalls.push(options);
    },
    sessionManager: {
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: { id: e.id, type: e.type } })),
      getChildren: () => [],
      getLabel: () => undefined,
      appendCustomEntry: () => {},
    },
  };
  return ctx;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("=== context_compress honest estimate / no estimate-skip (P1v2) ===\n");

await test("low real context: honest skip with no fabricated post-%", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 20, branchLength: 10 });
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");

  const result = await tool.execute(
    "a-1",
    { action: "archive", startIndex: 0, endIndex: 4, topic: "t", summary: "S" },
    undefined,
    undefined,
    ctx,
  );
  await sleep(30);

  // Genuinely low real usage → no compact scheduled.
  assert.equal(ctx.compactCalls.length, 0, "no compact for genuinely-low context");
  assert.equal(
    result.details.compactionTriggered,
    false,
    "compactionTriggered false for low context",
  );

  const text = result.content[0].text;
  assert.ok(/already low/.test(text), "feedback says honestly that it's already low");
  assert.ok(
    !/estimated after/.test(text),
    "must NOT claim an estimated post-% (fake freed number)",
  );
  assert.ok(!/-> estimated/.test(text), "must NOT present a before->estimated-after line");
});

await test("mid context: compact fires even when the old linear estimate would predict a low post-%", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 45, branchLength: 10 });
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");

  // Old estimate: 45 - 45*(8/10) = 9% → <30 → old code SKIPPED the compact.
  const result = await tool.execute(
    "b-1",
    { action: "archive", startIndex: 0, endIndex: 7, topic: "refactor", summary: "S" },
    undefined,
    undefined,
    ctx,
  );
  await sleep(30);

  // The real usage is 45% → the compact MUST be triggered (not skipped on an estimate).
  assert.equal(
    ctx.compactCalls.length,
    1,
    "compact fires for mid-context archive (no estimate-skip)",
  );
  assert.equal(result.details.compactionTriggered, true, "compactionTriggered true");

  const text = result.content[0].text;
  assert.ok(/Before: 45\.0% used/.test(text), "reports the REAL before-%");
  assert.ok(
    !/estimated after/.test(text),
    "must NOT claim a specific post-% from a linear estimate",
  );
  assert.ok(!/-> estimated/.test(text), "must NOT present a before->estimated-after line");
  assert.ok(
    /context_inspect\(detail='quick'\)/.test(text),
    "points at context_inspect(detail='quick') for real post-compaction usage",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
