/**
 * The usage-driven auto-arm is gated on growth since its last fire.
 *
 * An auto slide keeps the recent HALF of the branch. On a session whose recent
 * half carries the meter by itself, usage reads just under its pre-cut value
 * one tick after the fire, so a gate that compares against the threshold alone
 * fires again, and again: one session fired four slides in 47 minutes, each
 * dropping about half a branch that never fell below the 60% arm threshold.
 *
 * Pinned here:
 *   1. A reading held after a fire does not re-arm, however many ticks it is
 *      observed on: one fire, then refusals.
 *   2. The refusal names both readings, so a heartbeat log line makes the
 *      cooldown countable.
 *   3. The gate opens on growth, not on elapsed ticks: a meter that has not
 *      moved but a branch that has re-accumulated what the cut dropped allows a
 *      second fire, and the arm's reason names that growth.
 *   4. The explicit tool path is not gated: an agent asking for a slide while
 *      the auto-arm cools down gets one.
 *
 * Run: node --test packages/core/test/runtime/memory/test-auto-arm-hysteresis.mjs
 * (built first: npm run build)
 */

import { after, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic settings: the window the percent math resolves against must be
// pinned, and the token-estimate calibration store must be empty, or the
// planted readings below drift with the machine.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "auto-arm-hysteresis-home-"));
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

const compressMod = await import(
  join(D, "extensions/memory/context-manager/handlers/tools/context-compress.js")
);
const { getCmState } = await import(
  join(D, "extensions/memory/context-manager/handlers/shared.js")
);
const { analyzeSession } = await import(
  join(D, "extensions/memory/context-manager/analysis.js")
);
const { estimateMessagesTokens } = await import(join(D, "lib/detection/context-usage.js"));

const { registerContextCompress, readPendingCompactions } = compressMod;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The planted branch ──────────────────────────────────────────────────────

const WINDOW = 200_000;
// 20 cheap entries (~1% of the window) followed by 20 fat ones (65%). An auto
// slide keeps the recent half, so the cut removes the cheap head and nothing
// else: 66.0% before the fire, 65.0% after it.
const CHEAP_ENTRIES = 20;
const CHEAP_TOKENS = 100;
const FAT_ENTRIES = 20;
const FAT_TOKENS = 6_500;

/**
 * The text that makes ONE message entry cost exactly `tokens`. The meter prices
 * a message at ceil(chars / 4), so the length is solvable and the planted
 * reading is exact rather than approximate.
 */
function textCosting(tokens) {
  const cost = (chars) =>
    estimateMessagesTokens([
      { role: "user", content: [{ type: "text", text: "x".repeat(chars) }] },
    ]);
  let lo = 0;
  let hi = Math.max(4, tokens * 8);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cost(mid) < tokens) lo = mid + 1;
    else hi = mid;
  }
  assert.equal(cost(lo), tokens, `the fixture must plant exactly ${tokens} tokens per entry`);
  return "x".repeat(lo);
}

const CHEAP_TEXT = textCosting(CHEAP_TOKENS);
const FAT_TEXT = textCosting(FAT_TOKENS);

let worldSeq = 0;

function messageEntry(id, text, role) {
  return { id, type: "message", message: { role, content: [{ type: "text", text }] } };
}

/** Entries that arrive after a fire: cheap, so the branch grows while the meter holds. */
function appendCheap(branch, count) {
  for (let i = 0; i < count; i++) {
    branch.push(messageEntry(`late-${branch.length}`, CHEAP_TEXT, "user"));
  }
}

function makeFakePi() {
  const handlers = new Map();
  const tools = new Map();
  return {
    handlers,
    tools,
    appended: [],
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    sendMessage() {
      return {};
    },
    appendEntry(type, data) {
      this.appended.push({ type, data });
    },
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      for (const h of handlers.get(name) ?? []) {
        await h(event, ...args);
      }
    },
  };
}

function makeWorld() {
  const branch = [];
  for (let i = 0; i < CHEAP_ENTRIES; i++) {
    branch.push(messageEntry(`cheap-${i}`, CHEAP_TEXT, i % 2 ? "assistant" : "user"));
  }
  for (let i = 0; i < FAT_ENTRIES; i++) {
    branch.push(messageEntry(`fat-${i}`, FAT_TEXT, i % 2 ? "assistant" : "user"));
  }

  const sessionFile = join(FAKE_HOME, `auto-arm-${++worldSeq}.jsonl`);
  const pi = makeFakePi();
  registerContextCompress(pi);

  const ctx = {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    compactCalls: [],
    /**
     * A fired slide, modelled as the SLIDE_MODE branch does it: every entry
     * before the declared cut is gone, the armed state is consumed once.
     */
    compact(options) {
      this.compactCalls.push(options);
      const cmState = getCmState(ctx);
      const slide = cmState.slideMode;
      if (slide?.active && slide.cutEntryId) {
        const cutIndex = branch.findIndex((entry) => entry.id === slide.cutEntryId);
        if (cutIndex > 0) branch.splice(0, cutIndex);
        cmState.slideMode = null;
      }
    },
    sessionManager: {
      getSessionId: () => `auto-arm-hysteresis-${worldSeq}`,
      getSessionFile: () => sessionFile,
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: e, children: [], label: undefined })),
      getChildren: () => [],
      getLabel: () => undefined,
      appendCustomEntry(type, data) {
        // The slide's audit record is a branch entry (type "custom": 0 tokens).
        branch.push({ id: `custom-${branch.length}`, type, data });
      },
    },
    model: { contextWindow: WINDOW },
  };
  // The audit record must be a real branch entry, as it is in pi.
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  const reading = () => analyzeSession(ctx).usage.percent;
  return { pi, ctx, branch, reading };
}

/** Land whatever is armed: agent_settled drains the queue, the slide fires on a macrotask. */
async function settle(pi, ctx) {
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
}

/** Arm once through the auto path: warm tick, confirming tick, landed fire. */
async function fireOnce(world) {
  const { pi, ctx } = world;
  const warm = compressMod.maybeArmAutoCompaction(pi, ctx);
  assert.equal(warm.armed, false, "the first observation above the threshold only warms the counter");
  assert.match(warm.reason, /^warming 1\/2/);
  const armed = compressMod.maybeArmAutoCompaction(pi, ctx);
  assert.equal(armed.armed, true, "the confirming observation arms the slide");
  await settle(pi, ctx);
  assert.equal(ctx.compactCalls.length, 1, "the armed slide fires at the settle boundary");
  return armed;
}

// ── 1. A held reading does not re-arm ───────────────────────────────────────

test("a reading held after the fire arms one slide and then withholds the arm", async () => {
  const world = makeWorld();
  const { pi, ctx, branch, reading } = world;

  assert.equal(reading().toFixed(1), "66.0", "planted reading before the fire: 132,000 of 200,000 tokens");

  await fireOnce(world);
  assert.equal(
    reading().toFixed(1),
    "65.0",
    "the cut removed the cheap head only: the reading is still above the 60% arm threshold",
  );
  assert.equal(
    branch.length,
    21,
    "20 kept entries plus the slide's own audit record (1 above the kept span)",
  );

  for (const tick of [1, 2, 3]) {
    const held = compressMod.maybeArmAutoCompaction(pi, ctx);
    assert.equal(held.armed, false, `tick ${tick} on the same reading must not arm`);
    await sleep(10);
    assert.equal(
      ctx.compactCalls.length,
      1,
      `tick ${tick} must leave the fired slide as the only one that landed`,
    );
  }
});

// ── 2. The refusal is countable ─────────────────────────────────────────────

test("the refusal names the reading now and the reading at the last fire", async () => {
  const world = makeWorld();
  const { pi, ctx } = world;

  await fireOnce(world);
  const held = compressMod.maybeArmAutoCompaction(pi, ctx);

  assert.equal(held.armed, false);
  assert.match(
    held.reason,
    /^cooling-down \(65\.0% now vs 66\.0% at the last fire; needs \+\d+pp or \+20 entries since the cut\)$/,
    `the reason must carry both readings and the bar it is measured against (got: ${held.reason})`,
  );
});

// ── 3. Growth, not elapsed ticks, opens the gate ────────────────────────────

test("regrowing what the cut dropped re-opens the arm and the reason says why", async () => {
  const world = makeWorld();
  const { pi, ctx, branch, reading } = world;

  await fireOnce(world);
  assert.equal(branch.length, 21);

  // The meter barely moves: 24 cheap entries add 1.2pp, well under the margin.
  // Only the branch has regrown what the cut dropped.
  appendCheap(branch, 24);
  assert.equal(
    reading().toFixed(1),
    "66.2",
    "the appended entries move the reading by 1.2pp, under the margin the usage arm needs",
  );

  const repaid = compressMod.maybeArmAutoCompaction(pi, ctx);
  assert.equal(
    repaid.armed,
    false,
    "the repaying reading still needs confirmTicks observations after the gate opens",
  );
  assert.match(repaid.reason, /^warming 1\/2/);

  const second = compressMod.maybeArmAutoCompaction(pi, ctx);
  assert.equal(second.armed, true, "the branch regrew more than the last cut dropped");
  assert.match(
    second.reason,
    /branch grew 25 entries since the last cut dropped 20/,
    `the arm's reason must name the growth that repaid the last fire (got: ${second.reason})`,
  );
});

// ── 4. The explicit tool path is not gated ──────────────────────────────────

test("an explicit slide still arms while the auto-arm is cooling down", async () => {
  const world = makeWorld();
  const { pi, ctx } = world;

  await fireOnce(world);
  const cooling = compressMod.maybeArmAutoCompaction(pi, ctx);
  assert.match(cooling.reason, /^cooling-down/, "the auto-arm is cooling before the explicit call");
  assert.equal(readPendingCompactions(ctx).length, 0, "nothing is queued while it cools");

  const tool = pi.tools.get("context_compress");
  await pi._emit({ type: "tool_execution_start", toolCallId: "cc-slide", toolName: "context_compress" }, ctx);
  const result = await tool.execute("cc-slide", { action: "slide", keep: 5 }, undefined, undefined, ctx);
  await pi._emit({ type: "tool_execution_end", toolCallId: "cc-slide", toolName: "context_compress", result: {} }, ctx);

  assert.equal(result.details?.slideTriggered, true, "the explicit slide arms despite the cooldown");
  assert.equal(readPendingCompactions(ctx).length, 1, "the explicit slide is queued for the settle drain");
  assert.equal(getCmState(ctx).slideMode?.active, true, "the explicit slide's cut is armed");
});

after(() => {
  try {
    rmSync(FAKE_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
