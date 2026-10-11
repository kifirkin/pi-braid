/**
 * Session recall indexes custom_message entries alongside ordinary messages.
 *
 * Contract:
 *   (a) a `custom_message` entry with string content is extracted as one
 *       message with role "custom";
 *   (b) an array content is reduced to its text blocks;
 *   (c) an entry with no text block yields no message (not an empty one);
 *   (d) plain `message` entries keep their byte-identical extraction;
 *   (e) a search hit on a custom_message line renders its message.
 *
 * Run: node test/runtime/memory/test-session-recall-custom-message.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { extractLineMessages, extractMessageText } = await import(
  join(ROOT, "dist", "extensions", "memory", "session-recall", "text-utils.js")
);
const { searchLines } = await import(
  join(ROOT, "dist", "extensions", "memory", "session-recall", "search.js")
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

const TOKEN = "custom-message-pin-token-91b4";

const customString = JSON.stringify({
  type: "custom_message",
  id: "c1",
  parentId: "m1",
  timestamp: "2026-10-05T00:00:02.000Z",
  customType: "braid-whisper",
  content: `Injected context ${TOKEN}`,
  display: true,
});
const customBlocks = JSON.stringify({
  type: "custom_message",
  id: "c2",
  parentId: "c1",
  timestamp: "2026-10-05T00:00:03.000Z",
  customType: "braid-whisper",
  content: [
    { type: "text", text: "first block" },
    { type: "image", data: "not-text" },
    { type: "text", text: "second block" },
  ],
  display: false,
});
const plainMessage = JSON.stringify({
  type: "message",
  id: "m1",
  parentId: null,
  timestamp: "2026-10-05T00:00:01.000Z",
  message: { role: "user", content: [{ type: "text", text: "plain entry" }] },
});
const imageOnly = JSON.stringify({
  type: "custom_message",
  id: "c3",
  parentId: "c2",
  timestamp: "2026-10-05T00:00:04.000Z",
  customType: "braid-whisper",
  content: [{ type: "image", data: "not-text" }],
  display: false,
});

console.log("session-recall custom_message test\n");

await test("string content is indexed as one custom message", () => {
  const parsed = extractLineMessages(customString);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].role, "custom");
  assert.match(parsed.messages[0].text, new RegExp(TOKEN));
  assert.equal(parsed.totalMessages, 1);
});

await test("array content is reduced to its text blocks", () => {
  const parsed = extractLineMessages(customBlocks);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].role, "custom");
  assert.equal(parsed.messages[0].text, "first block second block");
});

await test("no text block yields no message", () => {
  const parsed = extractLineMessages(imageOnly);
  assert.equal(parsed.messages.length, 0);
  assert.equal(parsed.totalMessages, 0);
});

await test("plain message entries keep byte-identical extraction", () => {
  const parsed = extractLineMessages(plainMessage);
  assert.equal(parsed.messages.length, 1);
  assert.deepEqual(parsed.messages[0], { role: "user", text: "plain entry" });
  assert.equal(parsed.totalMessages, 1);
  assert.deepEqual(extractMessageText(plainMessage), { role: "user", text: "plain entry" });
});

await test("extractMessageText sees the custom message", () => {
  const msg = extractMessageText(customString);
  assert.ok(msg, "custom_message must not be dropped by the single-line extractor");
  assert.equal(msg.role, "custom");
  assert.match(msg.text, new RegExp(TOKEN));
});

await test("a search hit on a custom_message line renders its message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "custom-message-pin-"));
  try {
    const file = join(dir, "2026-10-05T00-00-00-000Z_pin.jsonl");
    writeFileSync(file, customString + "\n", "utf-8");
    const lines = await searchLines(TOKEN, file, 5);
    assert.equal(lines.length, 1, "the raw line must match the query");
    const messages = extractLineMessages(lines[0]).messages;
    assert.equal(messages.length, 1, "the matched line must render a message");
    assert.match(messages[0].text, new RegExp(TOKEN));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
