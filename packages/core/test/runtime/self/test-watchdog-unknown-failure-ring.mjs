/**
 * test-watchdog-unknown-failure-ring.mjs — unclassified LLM failures retain
 * raw failure detail (text + provider + HTTP code) in the watchdog snapshot.
 *
 * Background: during a provider outage the keyring feed reported
 * dozens of failures that classified as `unknown`; the watchdog logged only
 * a truncated debug line and the snapshot carried nothing, so root-causing
 * (HTTP 403, "Key limit exceeded (total limit)", provider OpenRouter)
 * required a separate forensic pass over logs. The engine now keeps a
 * bounded ring of unclassified-failure records.
 *
 * Fixture-based: fake tick clock, fake scheduler, no pi runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

const { createWatchdogEngine, DEFAULT_WATCHDOG_CONFIG } = await import(
  join(ROOT, "dist", "extensions", "self", "watchdog", "engine.js")
);
const { extractHttpCodeFromText } = await import(join(ROOT, "dist", "lib", "errors", "llm-error.js"));

const CONFIG = {
  ...DEFAULT_WATCHDOG_CONFIG,
  mode: "on",
  baseMs: 1000,
  hotMs: 200,
  stallMult: 5,
  quotaErrors: 3,
  tunnelFailures: 3,
};

function makeEngine(overrides = {}) {
  let t = 1000;
  const warnLines = [];
  const engine = createWatchdogEngine(CONFIG, {
    now: () => t,
    schedule: () => () => {},
    wakeWhisper: () => {},
    quietWhisper: () => {},
    subscribeTunnel: () => () => {},
    getTunnelStatus: () => ({ status: "up", failures: 0 }),
    log: (level, message) => {
      if (level === "warn") warnLines.push(message);
    },
    ...overrides,
  });
  return { engine, warnLines, tick: (ms) => (t += ms) };
}

test("unclassified failure retains raw text, provider, and HTTP code in the snapshot", () => {
  const h = makeEngine();
  h.engine.recordLlmFailure('403 "Key limit exceeded (total limit)"', {
    provider: "openrouter",
    model: "x-ai/grok-4-fast",
  });
  const snap = h.engine.getSnapshot();
  assert.equal(snap.unknownFailures.length, 1);
  const rec = snap.unknownFailures[0];
  assert.equal(rec.provider, "openrouter");
  assert.equal(rec.model, "x-ai/grok-4-fast");
  assert.equal(rec.statusCode, 403);
  assert.equal(rec.text, '403 "Key limit exceeded (total limit)"');
  assert.equal(rec.at, 1000);
});

test("classified failures never enter the unknown ring", () => {
  const h = makeEngine();
  h.engine.recordLlmFailure("429 Too Many Requests", { provider: "agent-zero" });
  h.engine.recordLlmFailure("401 unauthorized", { provider: "agent-zero" });
  h.engine.recordLlmFailure("insufficient_balance", { provider: "agent-zero" });
  const snap = h.engine.getSnapshot();
  assert.equal(snap.unknownFailures.length, 0);
});

test("ring-exhaustion detail is quota-class, not an unknown record", () => {
  const h = makeEngine();
  h.engine.recordLlmFailure("key index 1 exhausted — ALL KEYS EXHAUSTED (0/2 usable)", {
    provider: "agent-zero",
  });
  const snap = h.engine.getSnapshot();
  assert.equal(snap.unknownFailures.length, 0);
  assert.equal(snap.quotaConsecutive, 1);
});

test("ring is bounded to the last 5 records, newest last", () => {
  const h = makeEngine();
  for (let i = 1; i <= 7; i++) {
    h.tick(10);
    h.engine.recordLlmFailure(`weird failure ${i}`, { provider: "p" });
  }
  const snap = h.engine.getSnapshot();
  assert.equal(snap.unknownFailures.length, 5);
  assert.equal(snap.unknownFailures[0].text, "weird failure 3");
  assert.equal(snap.unknownFailures[4].text, "weird failure 7");
  assert.ok(snap.unknownFailures.every((r) => r.at > 1000));
});

test("long detail text is truncated to a bounded record", () => {
  const h = makeEngine();
  const long = "403 " + "x".repeat(400);
  h.engine.recordLlmFailure(long, { provider: "openrouter" });
  const rec = h.engine.getSnapshot().unknownFailures[0];
  assert.ok(rec.text.length <= 200);
  assert.equal(rec.statusCode, 403);
});

test("missing meta and empty detail are tolerated", () => {
  const h = makeEngine();
  h.engine.recordLlmFailure();
  h.engine.recordLlmFailure("no provider given");
  const snap = h.engine.getSnapshot();
  assert.equal(snap.unknownFailures.length, 2);
  assert.equal(snap.unknownFailures[0].provider, undefined);
  assert.equal(snap.unknownFailures[0].statusCode, undefined);
  assert.equal(snap.unknownFailures[1].statusCode, undefined);
});

test("unclassified failure logs at warn with provider and HTTP code", () => {
  const h = makeEngine();
  // The real outage text: 403 + a quota message the classifier has no
  // pattern for (403 maps to no category — exactly the observed unknown).
  h.engine.recordLlmFailure('HTTP 403 "Key limit exceeded (total limit)"', {
    provider: "openrouter",
  });
  const line = h.warnLines.find((l) => l.includes("unknown"));
  assert.ok(line, "expected a warn-level unknown-failure line");
  assert.ok(line.includes("provider openrouter"), line);
  assert.ok(line.includes("HTTP 403"), line);
});

test("extractHttpCodeFromText: standalone 4xx/5xx tokens only", () => {
  assert.equal(extractHttpCodeFromText('403 "Key limit exceeded"'), 403);
  assert.equal(extractHttpCodeFromText("HTTP 503 mystery"), 503);
  assert.equal(extractHttpCodeFromText("code 1429 garbage"), undefined);
  assert.equal(extractHttpCodeFromText("Key limit exceeded (total limit)"), undefined);
  assert.equal(extractHttpCodeFromText("retry 6721 ms"), undefined);
  assert.equal(extractHttpCodeFromText(""), undefined);
});
