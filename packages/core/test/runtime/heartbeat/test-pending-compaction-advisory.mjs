/**
 * Heartbeat pending-compaction advisory.
 *
 * A compaction armed by context_compress fires when the run settles (or at
 * the 0.90W backstop). While it sits armed, live usage reads pre-compaction state,
 * so the heartbeat summary must STATE the pending compaction every tick until
 * it lands — a once-per-tier advisory goes quiet exactly while nothing is
 * landing, which is how an armed cleanup stalled invisibly behind a run kept
 * alive by continuous steering.
 *
 * Pinned here through the REAL heartbeat extension:
 *   (a) queue non-empty → the tick buffers the pending line and the
 *       before_agent_start flush delivers it inside the heartbeat summary,
 *       naming the armed kind and the settle landing;
 *   (b) queue empty → no pending line is fabricated;
 *   (c) the in-flight guard holds across ticks: a turn boundary with a tool
 *       still executing does not drain the queue behind the heartbeat's back,
 *       and no turn boundary below the backstop drains it at all.
 *
 * Run: node test/runtime/heartbeat/test-pending-compaction-advisory.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic settings BEFORE dist imports: braid-paths/settings resolve from
// os.homedir() at module eval; the auto-arm percent math needs the pinned
// 200k window.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "pending-advisory-home-"));
process.env.HOME = FAKE_HOME;
process.env.PI_CODING_AGENT_DIR = join(FAKE_HOME, ".pi", "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(
  join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: 200_000 } } }),
);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const D = join(ROOT, "dist");

const heartbeatExtension = (await import(join(D, "extensions/heartbeat/heartbeat-scheduler/index.js")))
  .default;
const compressMod = await import(
  join(D, "extensions/memory/context-manager/handlers/tools/context-compress.js")
);

console.log("=== heartbeat pending-compaction advisory ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ~8k tokens per entry (chars/4): 18 entries = ~72% of the pinned 200k
// window — above the 60% auto-arm threshold.
const ENTRY_TEXT = "x".repeat(31_993);

function makeWorld(sessionId) {
  const branch = [];
  for (let i = 0; i < 18; i++) {
    branch.push({
      id: `e${i}`,
      type: "message",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [{ type: "text", text: `msg ${i} ${ENTRY_TEXT}` }],
      },
    });
  }
  const ctx = {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    compactCalls: [],
    compact(options) {
      this.compactCalls.push(options);
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: e, children: [], label: undefined })),
      getChildren: () => [],
      getLabel: () => undefined,
      appendCustomEntry(type, data) {
        branch.push({ id: `custom-${branch.length}`, type, data });
      },
    },
    model: { contextWindow: 200_000 },
  };
  return { ctx, branch };
}

function makeFakePi() {
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
    sendMessage(msg) {
      sent.push(String(msg?.content?.[0]?.text ?? ""));
      return {};
    },
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      for (const h of handlers.get(name) ?? []) {
        await Promise.resolve(h(event, ...args));
      }
    },
  };
}

/** Drive heartbeat ticks: the scheduler ticks every 5th turn_end. */
async function driveTicks(pi, ctx, turns = 5) {
  for (let i = 1; i <= turns; i++) {
    await pi._emit(
      { type: "turn_end", turnIndex: i, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );
  }
}

await test("pending compaction is delivered in the heartbeat summary until it lands", async () => {
  const pi = makeFakePi();
  compressMod.registerContextCompress(pi);
  heartbeatExtension(pi);
  const world = makeWorld("pending-advisory-armed");
  const ctx = world.ctx;

  // Arm inside a live batch with a sibling whose end never arrives: the queue
  // stays pending across every tick (the in-flight guard holds).
  await pi._emit(
    { type: "tool_execution_start", toolCallId: "cc", toolName: "context_compress" },
    ctx,
  );
  await pi._emit({ type: "tool_execution_start", toolCallId: "stuck", toolName: "slow_tool" }, ctx);
  const first = compressMod.maybeArmAutoCompaction(pi, ctx);
  const second = compressMod.maybeArmAutoCompaction(pi, ctx);
  await sleep(40);
  assert.equal(first.armed, false, "first observation warms the counter");
  assert.equal(second.armed, true, "sustained usage arms the auto slide");
  assert.equal(ctx.compactCalls.length, 0, "in-flight batch keeps the drain parked");

  await driveTicks(pi, ctx);
  await pi._emit({ type: "before_agent_start", prompt: "probe" }, ctx);

  const delivered = pi.sent.join("\n---\n");
  assert.match(delivered, /slide armed/, "the summary must name the armed compaction");
  assert.match(
    delivered,
    /when the run settles/,
    "the summary must state the landing boundary",
  );
  assert.equal(ctx.compactCalls.length, 0, "advisory ticks never drain the queue themselves");
});

await test("empty queue delivers no pending line (no fabricated relief)", async () => {
  const pi = makeFakePi();
  compressMod.registerContextCompress(pi);
  heartbeatExtension(pi);
  const world = makeWorld("pending-advisory-empty");
  const ctx = world.ctx;

  await driveTicks(pi, ctx);
  await pi._emit({ type: "before_agent_start", prompt: "probe" }, ctx);
  const delivered = pi.sent.join("\n---\n");
  assert.doesNotMatch(
    delivered,
    /armed .* when the run settles/,
    "no pending state may be fabricated when the queue is empty",
  );
});

try {
  rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
