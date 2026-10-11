/**
 * Fixture tests: the summary-cap slide rule.
 *
 * Background: a summary token-cap abort is the one compaction failure whose
 * own recovery can wedge. The bounded chunked retry is dispatched by a guard
 * (`compactionRetryActive`), and the observed end state was
 * "Retry skipped - already active" with no landed entry: the session stayed
 * over its threshold and could not compact. The
 * stall watchdog answers a hung stream; this rule answers a FAILED one. On a
 * summary-cap abort above the critical usage band it arms one deterministic
 * keep-recent slide (no model call) for the next cycle, logs one named alert
 * line, and emits one owner-visible whisper, at most once per cooldown window.
 *
 * Contracts asserted here:
 *  (1) one abort above the band arms and dispatches one deterministic slide,
 *      with one named alert line and one whisper;
 *  (2) a second abort inside the cooldown window does not slide or whisper
 *      again;
 *  (3) below the usage band nothing slides: the bounded retry ladder owns
 *      recovery there;
 *  (4) the rule is wired into the real summary-cap failure path.
 *
 * Run: node test/runtime/memory/test-summary-cap-watchdog-slide.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FAKE_HOME = mkdtempSync(join(tmpdir(), "sumcap-slide-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), JSON.stringify({}));

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const watchdogMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-watchdog.js")
);
const compactionMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);
const sharedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);
const { getLogBuffer, clearLogBuffer } = await import(join(ROOT, "dist/lib/core/logger.js"));
const { _resetForTests: resetWhisperCaps } = await import(
  join(ROOT, "dist/lib/enforcement/turn-dedup.js")
);

const {
  handleSummaryCapAbort,
  SUMMARY_CAP_SLIDE_COOLDOWN_MS,
  SUMMARY_CAP_SLIDE_USAGE_THRESHOLD,
} = watchdogMod;
const { registerSessionCompactFailedHandler } = compactionMod;
const { getCmState, resetCompactionRetry } = sharedMod;
const logs = () => getLogBuffer().map((l) => l.message ?? String(l)).join("\n");

let sessionSeq = 0;
function makeCtx() {
  const sessionId = `sumcap-slide-${++sessionSeq}`;
  const compactCalls = [];
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    getContextUsage: () => ({ percent: 50, tokens: 100000, contextWindow: 200000 }),
    compact: (options) => compactCalls.push(options ?? {}),
    compactCalls,
    sessionManager: {
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
      getBranch: () => [],
      getTree: () => [],
      getChildren: () => [],
      getLabel: () => undefined,
      appendCustomEntry: () => {},
    },
  };
}

function makeFakePi() {
  const handlers = new Map();
  const sendMessageCalls = [];
  return {
    handlers,
    sendMessageCalls,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(params, options) {
      sendMessageCalls.push({ params, options });
    },
    async _emit(event, ctx) {
      const name = typeof event === "string" ? event : event.type;
      let last;
      for (const h of handlers.get(name) ?? []) {
        const r = await h(event, ctx);
        if (r !== undefined) last = r;
      }
      return last;
    },
  };
}

console.log("=== summary-cap slide watchdog rule ===\n");

// ── (1) one abort above the band arms one slide, one alert, one whisper ──────
await test("(1) one abort above the band arms and dispatches one deterministic slide", async () => {
  clearLogBuffer();
  resetWhisperCaps(); // per-turn flood cap is process-global; isolate this fixture
  const pi = makeFakePi();
  const ctx = makeCtx();
  const outcome = handleSummaryCapAbort(pi, ctx, { usagePercent: 86, spanMessages: 520 });
  assert.equal(outcome.slid, true, "the first abort above the band must arm the slide");
  assert.ok(getCmState(ctx).compactionFailsafeCut, "the deterministic cut must be armed");
  assert.match(
    logs(),
    /Summary-cap abort: class=summary-cap span=520 msgs action=deterministic-slide-armed/,
    "the alert line must name the class and the action taken",
  );
  const whisper = pi.sendMessageCalls.find((c) =>
    (c.params.content?.[0]?.text ?? "").includes("Summary-cap abort"),
  );
  assert.ok(whisper, "one owner-visible whisper must be emitted");
  assert.equal(
    whisper.options?.triggerTurn,
    false,
    "the whisper must not start a turn; the slide is already dispatched",
  );
  await sleep(20); // the fail-safe dispatch is deferred past the handler
  assert.equal(ctx.compactCalls.length, 1, "the armed slide must dispatch one compaction");
});

// ── (2) a second abort inside the cooldown window does nothing ───────────────
await test("(2) a second abort inside the cooldown window does not slide again", async () => {
  clearLogBuffer();
  const pi = makeFakePi();
  const ctx = makeCtx();
  const t0 = 1_000_000;
  assert.equal(
    handleSummaryCapAbort(pi, ctx, { usagePercent: 86, spanMessages: 520, now: t0 }).slid,
    true,
  );
  const whisp = pi.sendMessageCalls.length;
  const outcome = handleSummaryCapAbort(pi, ctx, {
    usagePercent: 86,
    spanMessages: 520,
    now: t0 + 5 * 60 * 1000,
  });
  assert.equal(outcome.slid, false, "a second abort inside the window must not slide");
  assert.equal(outcome.reason, "cooldown");
  assert.equal(
    pi.sendMessageCalls.length,
    whisp,
    "the cooled-down abort must not emit a second whisper",
  );
  assert.match(logs(), /action=deterministic-slide-skipped reason=cooldown/);
  assert.ok(
    SUMMARY_CAP_SLIDE_COOLDOWN_MS >= 15 * 60 * 1000,
    "the cooldown must be at least the owner directive's 15 minutes",
  );
});

// ── (3) below the usage band nothing slides ──────────────────────────────────
await test("(3) a summary-cap abort below the usage band does not slide", async () => {
  clearLogBuffer();
  const pi = makeFakePi();
  const ctx = makeCtx();
  const outcome = handleSummaryCapAbort(pi, ctx, {
    usagePercent: SUMMARY_CAP_SLIDE_USAGE_THRESHOLD - 1,
    spanMessages: 520,
  });
  assert.equal(outcome.slid, false, "the band gate must hold");
  assert.equal(outcome.reason, "below-usage-threshold");
  assert.equal(
    getCmState(ctx).compactionFailsafeCut,
    undefined,
    "no deterministic cut may be armed below the band",
  );
  assert.equal(pi.sendMessageCalls.length, 0, "no whisper below the band");
  assert.match(logs(), /action=deterministic-slide-skipped reason=below-usage-threshold/);
});

// ── (4) the rule is wired into the real failure path ─────────────────────────
await test("(4) a real summary-cap failure above the band arms the slide", async () => {
  clearLogBuffer();
  resetCompactionRetry();
  resetWhisperCaps(); // per-turn flood cap is process-global; isolate this fixture
  const pi = makeFakePi();
  registerSessionCompactFailedHandler(pi);
  const ctx = makeCtx();
  getCmState(ctx).preCompactionUsagePercent = 88; // the value a real cycle records
  await pi._emit(
    {
      type: "session_compact_failed",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      errorMessage:
        "Auto-compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete",
    },
    ctx,
  );
  assert.ok(
    getCmState(ctx).compactionFailsafeCut,
    "the real failure path must arm the deterministic slide above the band",
  );
  assert.ok(
    pi.sendMessageCalls.some((c) =>
      (c.params.content?.[0]?.text ?? "").includes("Summary-cap abort"),
    ),
    "the real failure path must emit the owner-visible whisper",
  );
  resetCompactionRetry();
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
