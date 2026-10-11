/**
 * The analyze digest sees injected whisper entries.
 *
 * `custom_message` entries carry what braid was told: steers, enforcement
 * nudges, timer wakes. pi folds their content into the model's user context,
 * but the digest must not blur an injected instruction with something the
 * human typed, and it must not dump hundreds of whispers into a compact
 * summary.
 *
 * Contract:
 *   (a) a `custom_message` entry becomes an event of type "whisper" carrying
 *       its customType as whisperSource, never type "message";
 *   (b) string content and text-block content are both extracted;
 *   (c) a custom_message with no text block yields no event;
 *   (d) the compressed digest reports the whisper count and a per-source
 *       breakdown, samples at most one whisper per source, and stays bounded
 *       however many whispers the session holds;
 *   (e) plain user messages keep type "message" (no masquerade in reverse).
 *
 * Run: node test/runtime/memory/test-session-recall-analyze-whispers.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { summarizeSession } = await import(
  join(ROOT, "dist", "extensions", "memory", "session-recall", "analyze.js")
);

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

// A session with two steer-like whispers, one string-content whisper, one
// image-only custom_message, and 30 long volume whispers from one source.
const lines = [];
const push = (entry) => lines.push(JSON.stringify(entry));
push({
  type: "message",
  id: "m1",
  timestamp: "2026-10-05T00:00:01.000Z",
  message: { role: "user", content: [{ type: "text", text: "human-typed request: fix the flaky test" }] },
});
push({
  type: "custom_message",
  id: "c1",
  timestamp: "2026-10-05T00:00:02.000Z",
  customType: "enforcement",
  content: [{ type: "text", text: "[braid-whisper - enforcement] injected steer: run the tests first" }],
  display: true,
});
push({
  type: "custom_message",
  id: "c2",
  timestamp: "2026-10-05T00:00:03.000Z",
  customType: "hygiene",
  content: "string-form whisper from hygiene",
  display: false,
});
push({
  type: "custom_message",
  id: "c3",
  timestamp: "2026-10-05T00:00:04.000Z",
  customType: "timer-fire",
  content: [{ type: "image", data: "not-text" }],
  display: false,
});
push({
  type: "message",
  id: "m2",
  timestamp: "2026-10-05T00:00:05.000Z",
  message: { role: "assistant", content: [{ type: "text", text: "assistant reply text" }] },
});
for (let i = 0; i < 30; i++) {
  push({
    type: "custom_message",
    id: `c-vol-${i}`,
    timestamp: "2026-10-05T00:00:06.000Z",
    customType: "enforcement",
    content: [{ type: "text", text: `[braid-whisper - enforcement] volume whisper ${i} ${"x".repeat(200)}` }],
    display: false,
  });
}

const dir = mkdtempSync(join(tmpdir(), "analyze-whispers-"));
const file = join(dir, "2026-10-05T00-00-00-000Z_pin.jsonl");
writeFileSync(file, lines.join("\n") + "\n", "utf-8");

const summary = await summarizeSession(file, "pin-project", "2026-10-05");
const whispers = summary.events.filter((e) => e.type === "whisper");

console.log("session-recall analyze whisper coverage test\n");

await test("custom_message entries become whisper events with their source", () => {
  assert.ok(whispers.length > 0, "whisper entries must not be dropped from the digest's events");
  const steer = whispers.find((e) => e.summary.includes("injected steer"));
  assert.ok(steer, "the enforcement steer must produce a whisper event");
  assert.equal(steer.type, "whisper");
  assert.equal(steer.whisperSource, "enforcement");
  const hygiene = whispers.find((e) => e.summary.includes("string-form whisper"));
  assert.ok(hygiene, "string content must be extracted");
  assert.equal(hygiene.whisperSource, "hygiene");
});

await test("a text-less custom_message yields no event", () => {
  assert.equal(
    whispers.filter((e) => (e.whisperSource ?? "") === "timer-fire").length,
    0,
    "an image-only custom_message is not a whisper event",
  );
  assert.equal(whispers.length, 32, "31 enforcement whispers + 1 hygiene whisper");
});

await test("the compressed digest counts whispers and breaks them down by source", () => {
  assert.match(summary.compressed, /Injected instructions \(whispers\): 32/);
  assert.match(summary.compressed, /By source: enforcement 31, hygiene 1/);
  assert.ok(summary.compressed.includes("injected steer: run the tests first"));
  assert.ok(summary.compressed.includes("string-form whisper from hygiene"));
});

await test("the digest stays bounded: volume whispers are not dumped", () => {
  assert.equal(
    (summary.compressed.match(/volume whisper/g) || []).length,
    0,
    "unsampled volume whispers must not appear in the digest",
  );
  assert.ok(
    summary.compressed.length < 2500,
    `digest must stay near its ~1-2K token budget, got ${summary.compressed.length} chars`,
  );
});

await test("a human-typed message stays type message, not whisper", () => {
  const human = summary.events.find((e) => e.summary.includes("human-typed request"));
  assert.ok(human, "the user message must keep producing an event");
  assert.equal(human.type, "message");
  const reply = summary.events.find((e) => e.summary.includes("assistant reply text"));
  assert.ok(reply);
  assert.equal(reply.type, "message");
});

rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
