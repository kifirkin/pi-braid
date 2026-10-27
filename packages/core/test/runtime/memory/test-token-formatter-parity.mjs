/**
 * One token formatter, one owner for the number.
 *
 * context_inspect renders the count with the ONE formatter (formatTokensK:
 * 1000 tokens = "1K"). The context whisper does not restate it: the bars live
 * in context-thresholds.ts and the meter in context-usage.ts, and a number
 * copied into prose drifts from both. The whisper names the state, the
 * deadline (an armed compaction fires when the run settles) and the action.
 *
 * Old behavior (regression guarded here): context_inspect divided by 1024
 * while every whisper divided by 1000 — the same 160,000-token window
 * rendered "156K" in inspect output and "160K" in whispers (forensics V4:
 * "156K/125K" denominators that never existed).
 *
 * Run: node test/runtime/memory/test-token-formatter-parity.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic settings: pin the window so the inspect percent math never reads
// the live settings.json.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w218-fmt-home-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: 200_000 } } }),
);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const D = join(ROOT, "dist");

const { registerContextInspect } = await import(
  join(D, "extensions/memory/context-manager/handlers/tools/context-inspect.js")
);
const { registerContextCompress } = await import(
  join(D, "extensions/memory/context-manager/handlers/tools/context-compress.js")
);
const { contextUsageTokenMessage, contextUsageTierMessage } = await import(
  join(D, "lib/detection/context-tiers.js")
);
const { formatTokensK } = await import(join(D, "lib/detection/context-usage.js"));

console.log("=== one token formatter across surfaces ===\n");

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

const WINDOW = 200_000;
const TOKENS = 80_000; // 40% — inspect must render "80K/200K" (the /1024 split rendered "78K/195K")

function makeWorld() {
  const branch = [];
  for (let i = 0; i < 40; i++) {
    branch.push({
      id: `e${i}`,
      type: "message",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [{ type: "text", text: `msg ${i} ${"x".repeat(7990)}` }],
      },
    });
  }
  const ctx = {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    sessionManager: {
      getSessionId: () => "w218-fmt",
      getSessionFile: () => "/tmp/w218-fmt.jsonl",
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: e, children: [], label: undefined })),
      getChildren: () => [],
      getLabel: () => undefined,
      appendCustomEntry(type, data) {
        branch.push({ id: `custom-${branch.length}`, type, data });
      },
      appendLabelChange() {},
    },
    model: { contextWindow: WINDOW },
    getContextUsage: () => ({
      tokens: TOKENS,
      contextWindow: WINDOW,
      percent: (TOKENS / WINDOW) * 100,
    }),
  };
  return { ctx, branch };
}

function makePi() {
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
        await Promise.resolve(h(...args)).catch((e) => {
          throw e;
        });
      }
    },
  };
}

await test("context_inspect renders the K-number; the whisper does not restate it", async () => {
  const { ctx } = makeWorld();
  const pi = makePi();
  registerContextInspect(pi);
  const tool = pi.tools.get("context_inspect");

  const result = await tool.execute("ci-1", { detail: "quick" }, undefined, undefined, ctx);
  const text = result.content[0].text;

  const whisper = contextUsageTokenMessage("warning");

  const want = `${Math.round(TOKENS / 1000)}K`;
  assert.ok(
    text.includes(`(${want}/${Math.round(WINDOW / 1000)}K)`),
    `inspect must render ${want}/${Math.round(WINDOW / 1000)}K — the ONE formatter (/1000); got:\n${text}`,
  );
  assert.ok(!text.includes("78K"), "the /1024 artifact (78K) must not appear");
  assert.ok(!text.includes("195K"), "the /1024 window artifact (195K) must not appear");
  assert.ok(
    !/\d+K\b/.test(whisper) && !/%/.test(whisper),
    `the whisper must not restate the meter's number: ${whisper}`,
  );
  assert.match(
    whisper,
    /an armed compaction fires when the run settles/,
    `the whisper names the deadline: ${whisper}`,
  );
  assert.match(
    whisper,
    /context_compress\(action="archive"\)/,
    `the whisper names the action: ${whisper}`,
  );
  assert.equal(
    contextUsageTokenMessage("warning"),
    contextUsageTierMessage("warning"),
    "the token and percent warning rungs share one copy (the rung, not the unit, selects it)",
  );
});

await test("detailed view uses the same formatter", async () => {
  const { ctx } = makeWorld();
  const pi = makePi();
  registerContextInspect(pi);
  const tool = pi.tools.get("context_inspect");
  const result = await tool.execute("ci-2", { detail: "detailed" }, undefined, undefined, ctx);
  const text = result.content[0].text;
  assert.ok(
    text.includes("80K/200K"),
    `detailed usage line must use the /1000 formatter:\n${text}`,
  );
  assert.ok(!text.includes("195K"), "no /1024 window artifact in the detailed view");
});

await test("armed compaction surfaces as pending state in context_inspect", async () => {
  const { ctx } = makeWorld();
  const pi = makePi();
  registerContextInspect(pi);
  registerContextCompress(pi);
  const inspect = pi.tools.get("context_inspect");
  const compress = pi.tools.get("context_compress");

  // No arm: no pending line (never fabricate an expectation of a drop).
  const before = await inspect.execute("ci-3", { detail: "quick" }, undefined, undefined, ctx);
  assert.ok(!before.content[0].text.includes("Pending:"), "no pending line when nothing is armed");

  // Arm a slide inside a live batch; the settle never comes in this test.
  await pi._emit(
    { type: "tool_execution_start", toolCallId: "cc", toolName: "context_compress" },
    ctx,
  );
  await compress.execute("cc", { action: "slide", keep: 20 }, undefined, undefined, ctx);
  await pi._emit(
    { type: "tool_execution_end", toolCallId: "cc", toolName: "context_compress", result: {} },
    ctx,
  );

  const after = await inspect.execute("ci-4", { detail: "quick" }, undefined, undefined, ctx);
  const text = after.content[0].text;
  assert.ok(text.includes("Pending:"), `pending line present after arming:\n${text}`);
  assert.match(text, /slide armed .+ — fires when the run settles \(or at the 0\.90W backstop\)/);
  const details = after.details;
  assert.ok(
    Array.isArray(details.pendingCompactions) && details.pendingCompactions.length === 1,
    "machine-readable pendingCompactions in details",
  );
  assert.equal(details.pendingCompactions[0].kind, "slide");
});

void formatTokensK;
void contextUsageTokenMessage;
void contextUsageTierMessage;

try {
  rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
