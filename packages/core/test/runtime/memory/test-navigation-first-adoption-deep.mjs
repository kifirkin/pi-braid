/**
 * Fixture test: proactive early-tagging steer + archive tag hint.
 *
 * Coverage (deeper navigation-first adoption defaults,):
 * (a) context_inspect detail=quick at 60% with zero recorded tags → the
 * medium-band **Steer** line is present. Fails pre-fix: no Steer logic
 * existed (only the >70% high-usage line).
 * (b) context_inspect detail=quick at 60% with tags=1 → NO **Steer** line
 * (an adopter is not nagged). Passes trivially pre-fix: no Steer logic
 * existed at all, so the "NO Steer"assertion holds on old code.
 * (c) context_inspect detail=quick at 50% with zero tags → NO **Steer** line
 * (below the medium band). Passes trivially pre-fix for the same reason.
 * (d) context_inspect detail=quick at 75% with zero tags → the **High
 * usage** line present (regression: high tier untouched) AND NO **Steer**
 * line (the high tier is the existing crisis line). Passes trivially
 * pre-fix: the high-usage line existed before this change.
 * (e) context_compress action=archive success: with zero recorded tags the
 * success text includes the tag Tip; with tags=1 seeded it does not.
 * Fails pre-fix for the untagged sub-case: no Tip was appended.
 *
 * Seeds navigationAdoption via getCmState (the real per-session state bucket)
 * and resets the cmState block before/after so the suite isolates.
 *
 * Run: node test/runtime/memory/test-navigation-first-adoption-deep.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Hermetic settings isolation (re-baseline) ──────────────────────
// The context_inspect detail=deep surface reads usage through the ONE
// resolver (lib/config/braid-settings.ts) reading
// <homedir()>/.pi/agent/settings.json — the live 262k override recomputed the
// fixture's 200k-window percent and broke the threshold pins (Steer line,
// high-usage line). Redirect HOME to a temp dir BEFORE the dist
// imports (os.homedir() reads $HOME on POSIX — same seam as
// test-context-limit-config.mjs; mock.method(os, "homedir") is not viable
// because braid-settings captures the named import and bakes SETTINGS_PATH at
// module-eval time) and write the EXPLICIT contextLimitTokens this scenario
// pins: 200_000 — the provider window the fixtures were written against (now
// pinned explicitly so the suite passes regardless of live settings.json).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w85b-nav-deep-"));
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
const { getCmState } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);
const { clearExtensionState } = await import(join(ROOT, "dist/lib/state/extension-state.js"));

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
function makeFakeCtx({ percent = 50, branchLength = 10 } = {}) {
  const sessionId = `sess-deep-${++sessionSeq}`;
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
    compact: () => {},
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

/** Seed the per-session navigationAdoption counter block with the given tags count. */
function seedTags(ctx, tags = 0) {
  const state = getCmState(ctx);
  state.navigationAdoption = {
    tags,
    checkouts: 0,
    logs: 0,
    archives: 0,
    slides: 0,
    compacts: 0,
    deepCleans: 0,
  };
  return state;
}

/** Reset the cmState block for a ctx (suite isolation, before/after). */
function resetCmState(ctx) {
  clearExtensionState(ctx, "context-manager");
}

console.log("=== navigation-first adoption deep: early-tagging steer + archive tag hint ===\n");

await test("(a) detail=quick at 60% with zero tags shows the Steer line", async () => {
  const pi = makeFakePi();
  registerContextInspect(pi);
  const ctx = makeFakeCtx({ percent: 60, branchLength: 12 });
  resetCmState(ctx);
  try {
    const tool = pi.tools.get("context_inspect");
    assert.ok(tool, "context_inspect tool must be registered");

    const res = await tool.execute("call-a", { detail: "quick" }, null, null, ctx);
    const text = res.content[0].text;
    assert.match(
      text,
      /\*\*Steer:\*\* tag now \(lossless checkpoint\)/,
      `detail=quick at 60% untagged must include the Steer line, got:\n${text}`,
    );
    assert.match(
      text,
      /context_navigate\(action=tag\)/,
      "Steer must reference context_navigate(action=tag)",
    );
  } finally {
    resetCmState(ctx);
  }
});

await test("(b) detail=quick at 60% with tags=1 shows NO Steer line", async () => {
  const pi = makeFakePi();
  registerContextInspect(pi);
  const ctx = makeFakeCtx({ percent: 60, branchLength: 12 });
  resetCmState(ctx);
  try {
    seedTags(ctx, 1);
    const tool = pi.tools.get("context_inspect");

    const res = await tool.execute("call-b", { detail: "quick" }, null, null, ctx);
    const text = res.content[0].text;
    assert.doesNotMatch(
      text,
      /\*\*Steer:\*\*/,
      `detail=quick at 60% with tags=1 must NOT be steered (adopter), got:\n${text}`,
    );
  } finally {
    resetCmState(ctx);
  }
});

await test("(c) detail=quick at 50% with zero tags shows NO Steer line", async () => {
  const pi = makeFakePi();
  registerContextInspect(pi);
  const ctx = makeFakeCtx({ percent: 50, branchLength: 12 });
  resetCmState(ctx);
  try {
    const tool = pi.tools.get("context_inspect");

    const res = await tool.execute("call-c", { detail: "quick" }, null, null, ctx);
    const text = res.content[0].text;
    assert.doesNotMatch(
      text,
      /\*\*Steer:\*\*/,
      `detail=quick at 50% must NOT include the Steer line (below medium band), got:\n${text}`,
    );
  } finally {
    resetCmState(ctx);
  }
});

await test("(d) detail=quick at 75% with zero tags: High usage present, NO Steer line", async () => {
  const pi = makeFakePi();
  registerContextInspect(pi);
  const ctx = makeFakeCtx({ percent: 75, branchLength: 12 });
  resetCmState(ctx);
  try {
    const tool = pi.tools.get("context_inspect");

    const res = await tool.execute("call-d", { detail: "quick" }, null, null, ctx);
    const text = res.content[0].text;
    assert.match(
      text,
      /\*\*High usage:\*\* tag \+ archive before compact/,
      `high-usage line must survive at >70% usage, got:\n${text}`,
    );
    assert.doesNotMatch(
      text,
      /\*\*Steer:\*\*/,
      `detail=quick at 75% must NOT include the medium-band Steer line, got:\n${text}`,
    );
  } finally {
    resetCmState(ctx);
  }
});

await test("(e) archive success untagged includes the tag Tip; seeded tags=1 does not", async () => {
  // Sub-case 1: untagged archive → Tip present.
  {
    const pi = makeFakePi();
    registerContextCompress(pi);
    const ctx = makeFakeCtx({ percent: 20, branchLength: 10 });
    resetCmState(ctx);
    try {
      const tool = pi.tools.get("context_compress");
      assert.ok(tool, "context_compress tool must be registered");

      const res = await tool.execute(
        "call-e1",
        { action: "archive", topic: "t", summary: "sum" },
        null,
        null,
        ctx,
      );
      const text = res.content[0].text;
      assert.match(
        text,
        /Tip: context_navigate\(action=tag\) before archives makes recovery lossless\./,
        `untagged archive success must include the tag Tip, got:\n${text}`,
      );
    } finally {
      resetCmState(ctx);
    }
  }
  // Sub-case 2: seeded tags=1 archive → no Tip.
  {
    const pi = makeFakePi();
    registerContextCompress(pi);
    const ctx = makeFakeCtx({ percent: 20, branchLength: 10 });
    resetCmState(ctx);
    try {
      seedTags(ctx, 1);
      const tool = pi.tools.get("context_compress");

      const res = await tool.execute(
        "call-e2",
        { action: "archive", topic: "t", summary: "sum" },
        null,
        null,
        ctx,
      );
      const text = res.content[0].text;
      assert.doesNotMatch(
        text,
        /Tip: context_navigate\(action=tag\)/,
        `tagged archive success must NOT include the Tip, got:\n${text}`,
      );
    } finally {
      resetCmState(ctx);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
