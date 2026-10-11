/**
 * Scratchpad flush failure visibility - a turn-end flush whose disk write
 * fails must leave a warn line in the log buffer, not a dropped return value.
 *
 * The failure is forced before any disk I/O: the pad carries a circular
 * reference, so saveScratchpadToDisk throws in its JSON.stringify step.
 *
 * Run: node test/runtime/memory/test-scratchpad-flush-log.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "scratchpad-flush-home-"));

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { mutateAndSave, flushPendingScratchpadWrites } = await import(
  join(ROOT, "dist", "extensions", "memory", "scratchpad", "utils.js")
);
const { getLogBuffer, clearLogBuffer } = await import(
  join(ROOT, "dist", "lib", "core", "logger.js")
);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [fail] ${name}: ${e.message}`);
  }
}

await test("a failed flush leaves a warn in the log buffer", async () => {
  clearLogBuffer();

  const pad = {
    projectSlug: "flush-visibility-test",
    updatedAt: 0,
    plan: [],
    done: [],
    decisions: [],
    hypotheses: [],
    notes: [],
    learnings: [],
    constraints: [],
    tasks: [],
  };
  pad.self = pad; // circular: JSON.stringify in saveScratchpadToDisk throws

  await mutateAndSave(pad);
  await flushPendingScratchpadWrites();

  const entry = getLogBuffer().find(
    (e) => e.level === "warn" && /Disk write failed/.test(e.message),
  );
  assert.ok(
    entry,
    `expected a warn log for the failed flush; buffer: ${JSON.stringify(getLogBuffer().map((e) => [e.level, e.message]))}`,
  );
});

await test("a cleared failure does not resurface on the next flush", async () => {
  clearLogBuffer();
  await flushPendingScratchpadWrites();
  const entry = getLogBuffer().find((e) => /Disk write failed/.test(e.message));
  assert.equal(entry, undefined, "the failure must be consumed once, not re-logged");
});

console.log(`\ntest-scratchpad-flush-log: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
