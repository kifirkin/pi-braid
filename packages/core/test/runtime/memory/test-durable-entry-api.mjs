/**
 * Durable session entries are written through the extension API's documented
 * appendEntry seam, not by reaching into the session manager.
 *
 * Contract:
 *   (a) writeCompactionTrace lands its entry via the appender it is given,
 *       with the custom type and payload intact;
 *   (b) no production source calls sessionManager.appendCustomEntry.
 *
 * Run: node test/runtime/memory/test-durable-entry-api.mjs
 */

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { writeCompactionTrace, COMPACTION_TRACE_ENTRY_TYPE } = await import(
  join(
    ROOT,
    "dist",
    "extensions",
    "memory",
    "context-manager",
    "handlers",
    "compaction-trace.js",
  )
);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [fail] ${name}: ${e.message}`);
  }
}

/** ExtensionAPI double: records every appendEntry call. */
function fakeAppender() {
  const entries = [];
  return {
    entries,
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
  };
}

const ctx = {
  sessionManager: {
    getSessionFile: () => "/tmp/durable-entry-pin.jsonl",
    getSessionId: () => "durable-entry-pin",
    getLeafId: () => "leaf-pin",
  },
};

console.log("durable entry API test\n");

await test("the trace entry lands through appendEntry with its payload", () => {
  const appender = fakeAppender();
  writeCompactionTrace(appender, ctx, {
    event: "failure",
    failureClass: "transient",
    reason: "threshold",
    errorMessage: "stream ended",
    spanMessages: 7,
    retryAttempt: 1,
    willRetry: false,
    cycleId: 3,
  });
  assert.equal(appender.entries.length, 1, "exactly one entry must be appended");
  assert.equal(appender.entries[0].customType, COMPACTION_TRACE_ENTRY_TYPE);
  assert.equal(appender.entries[0].data.event, "failure");
  assert.equal(appender.entries[0].data.spanMessages, 7);
  assert.equal(appender.entries[0].data.cycleId, 3);
});

await test("no production source calls sessionManager.appendCustomEntry", () => {
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        if (readFileSync(full, "utf-8").includes(".appendCustomEntry(")) hits.push(full);
      }
    }
  };
  walk(join(ROOT, "src"));
  assert.deepEqual(hits, [], `direct session-manager writes remain in:\n${hits.join("\n")}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
