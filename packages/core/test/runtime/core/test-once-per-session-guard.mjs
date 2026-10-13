/**
 * Once-per-session guard: two overlapping prompt builds deliver the
 * once-per-session hygiene whisper exactly once.
 *
 * The guard (`ps.insightsSent`) in prompt-builder/index.ts was read at the top
 * of the once-per-session block and written after
 * `await Promise.allSettled([...])`. Two builds that overlap in that window
 * both read it unset, so both delivered every once-per-session whisper; the
 * harness measured the identical hygiene line twice in one session start.
 * This fixture drives the REAL handler twice, with the second build starting
 * while the first is suspended inside the block, and asserts exactly one
 * hygiene delivery.
 *
 * RED before the fix (both builds deliver, 2 hygiene messages); GREEN when the
 * claim is synchronous and the second build sees it.
 *
 * The delivery channel's own caps (per-turn whisper cap, cross-call reprime)
 * are reset at the boundary between the two builds (beginTurn +
 * clearAllBuckets, the idiom test-skill-boot-whisper.mjs uses): without that
 * reset a second *delivery* would be capped and a real guard breach would read
 * as a pass. The breach is what lets the second attempt exist at all.
 *
 * Hermetic: HOME and BRAID_HOME are pinned to a private tmpdir BEFORE any dist
 * module loads, so the handler's memory/timer/settings reads never touch the
 * live agent tree. Runs against dist/ (build first).
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "once-per-session-guard-"));
process.env.HOME = FAKE_HOME;
process.env.BRAID_HOME = join(FAKE_HOME, ".pi", "agent", "braid");
const CWD = join(FAKE_HOME, "workspace");
mkdirSync(CWD, { recursive: true });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST = join(ROOT, "dist");

const { default: promptBuilderExtension } = await import(
  join(DIST, "extensions", "core", "prompt-builder", "index.js")
);
const { beginTurn, _resetForTests } = await import(
  join(DIST, "lib", "enforcement", "turn-dedup.js")
);
const { clearAllBuckets } = await import(join(DIST, "lib", "utils", "injection-tracker.js"));

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

console.log("=== once-per-session guard ===\n");

/** Minimal ExtensionAPI double: captures handlers and every delivered message. */
function fakePi() {
  const handlers = new Map();
  const sent = [];
  const onSend = [];
  return {
    handlers,
    sent,
    onSend,
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
      for (const fn of onSend) fn(params, options);
    },
    sendUserMessage() {},
  };
}

/** Minimal ExtensionContext double: one stable session key for both builds. */
function fakeCtx(sessionFile) {
  return {
    cwd: CWD,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "synthetic-session",
      getBranch: () => [],
      getLabel: () => undefined,
    },
    getContextUsage: () => ({ tokens: 1024, contextWindow: 200_000, percent: 0.5 }),
    model: { contextWindow: 200_000 },
  };
}

const isHygiene = (m) => m.params?.customType === "hygiene";
const hygieneSends = (pi) => pi.sent.filter(isHygiene);

await test("two overlapping builds deliver the hygiene whisper exactly once", async () => {
  _resetForTests();
  clearAllBuckets();
  const pi = fakePi();
  promptBuilderExtension(pi);
  const handler = pi.handlers.get("before_agent_start")?.at(-1);
  assert.ok(typeof handler === "function", "before_agent_start handler is registered");

  const ctx = fakeCtx(join(CWD, "session.jsonl"));
  const firstEvent = { systemPromptOptions: {} };
  const secondEvent = { systemPromptOptions: {} };

  // The turn boundary a real input event creates, applied between the two
  // builds' deliveries: fresh per-turn cap + reprime state, so the second
  // delivery is not suppressed by the channel's own caps. Without it a real
  // guard breach would read as a pass (the caps would hide the duplicate).
  let boundaryDone = false;
  pi.onSend.push((params) => {
    if (params.customType !== "hygiene" || boundaryDone) return;
    boundaryDone = true;
    beginTurn();
    clearAllBuckets();
  });

  // Start both builds back-to-back: their awaits interleave, and the second
  // build reaches the once-per-session block while the first is still inside
  // it (pre-fix the guard is not written until the block's deliveries settle,
  // which cannot happen before the second build's microtask chain runs).
  const buildA = handler(firstEvent, ctx);
  const buildB = handler(secondEvent, ctx);
  await Promise.all([buildA, buildB]);

  assert.ok(boundaryDone, "a hygiene whisper was delivered");
  const sends = hygieneSends(pi);
  assert.equal(
    sends.length,
    1,
    `two overlapping builds must deliver the hygiene whisper once, got ${sends.length}`,
  );
  assert.equal(sends[0].params.details?._braidSource, "prompt-builder/hygiene", "source tag");
  assert.equal(sends[0].options?.deliverAs, "steer", "park-class steer delivery");
  assert.equal(sends[0].options?.triggerTurn, false, "no turn start");
  // Both builds ran to completion (each published its prompt), so the count
  // above is about the guard, not about a build that died early.
  assert.ok(firstEvent.systemPromptOptions.customPrompt, "first build published its prompt");
  assert.ok(secondEvent.systemPromptOptions.customPrompt, "second build published its prompt");

  // The guard stays closed for later builds in the same session.
  await handler({ systemPromptOptions: {} }, ctx);
  assert.equal(hygieneSends(pi).length, 1, "no delivery on a later build in the same session");
});

// ── cleanup ─────────────────────────────────────────────────────────────────

try {
  rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
