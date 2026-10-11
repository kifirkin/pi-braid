/**
 * Fixture test (option A /): navigation-first adoption.
 *
 * Coverage:
 * (a) context_compress description makes the navigation-first order explicit:
 * tag with context_navigate(action=tag) + archive deliberately with
 * context_compress(action=archive) BEFORE considering compaction, with
 * compaction framed as a bounded safety net. Fails pre-fix: the old
 * description only said "archive first, compact as last resort"without
 * naming the tag/archive pipeline or the bounded safety net.
 * (b) context_inspect detail=quick adds a one-line navigation-first suggestion
 * when usage is high (>70%). Fails pre-fix: no suggestion line existed.
 * (c) the suggestion line is absent at low usage — no noise on healthy sessions.
 *
 * Run: node test/runtime/memory/test-navigation-first-adoption.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Hermetic settings isolation (re-baseline) ──────────────────────
// The context_inspect detail=quick surface reads usage through the ONE
// resolver (lib/config/braid-settings.ts) reading
// <homedir()>/.pi/agent/settings.json — the live 262k override recomputed the
// fixture's 200k-window percent (75% → ~57%) and the high-usage line
// went silent. Redirect HOME to a temp dir BEFORE the dist imports
// (os.homedir() reads $HOME on POSIX — same seam as
// test-context-limit-config.mjs; mock.method(os, "homedir") is not viable
// because braid-settings captures the named import and bakes SETTINGS_PATH at
// module-eval time) and write the EXPLICIT contextLimitTokens this scenario
// pins: 200_000 — the provider window the fixtures were written against (now
// pinned explicitly so the suite passes regardless of live settings.json).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w85b-nav-adoption-"));
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
const { registerContextInspect } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/tools/context-inspect.js")
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
function makeFakeCtx({ percent = 50, branchLength = 10 } = {}) {
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
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    getContextUsage: () => ({
      percent,
      tokens: Math.round((percent / 100) * 200000),
      contextWindow: 200000,
    }),
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
}

console.log("=== navigation-first adoption: wording + high-usage suggestion (option A) ===\n");

await test("(a) context_compress description names the tag/archive-before-compact pipeline", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  assert.ok(tool, "context_compress tool must be registered");
  assert.ok(tool.description, "context_compress must expose a description");
  assert.match(
    tool.description,
    /prefer archive over compact/,
    "description must steer toward archive over compact",
  );
  assert.match(
    tool.description,
    /context_navigate\(action=tag\)/,
    "description must name the context_navigate(action=tag) step",
  );
  assert.match(
    tool.description,
    /context_compress\(action=archive\)/,
    "description must name the context_compress(action=archive) step",
  );
  assert.match(
    tool.description,
    /BEFORE considering compaction/,
    "description must order tag/archive before compaction",
  );
  assert.match(
    tool.description,
    /bounded safety net/,
    "description must frame compaction as a bounded safety net",
  );
});

await test("(b) context_inspect detail=quick adds the navigation-first suggestion at >70% usage", async () => {
  const pi = makeFakePi();
  registerContextInspect(pi);
  const ctx = makeFakeCtx({ percent: 75, branchLength: 12 });
  const tool = pi.tools.get("context_inspect");
  assert.ok(tool, "context_inspect tool must be registered");

  const res = await tool.execute("call-1", { detail: "quick" }, null, null, ctx);
  const text = res.content[0].text;
  assert.match(
    text,
    /\*\*High usage:\*\* tag \+ archive before compact/,
    `detail=quick must include the navigation-first suggestion at high usage, got:\n${text}`,
  );
  assert.match(
    text,
    /context_navigate\(action=tag\)/,
    "suggestion must reference context_navigate(action=tag)",
  );
  assert.match(
    text,
    /context_compress\(action=archive\)/,
    "suggestion must reference context_compress(action=archive)",
  );
});

await test("(c) the suggestion line is absent at low usage", async () => {
  const pi = makeFakePi();
  registerContextInspect(pi);
  const ctx = makeFakeCtx({ percent: 40, branchLength: 12 });
  const tool = pi.tools.get("context_inspect");

  const res = await tool.execute("call-2", { detail: "quick" }, null, null, ctx);
  const text = res.content[0].text;
  assert.doesNotMatch(
    text,
    /\*\*High usage:\*\*/,
    `detail=quick must NOT include the high-usage suggestion at low usage, got:\n${text}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
