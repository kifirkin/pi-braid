/**
 * A failed compaction cycle derives no compaction-entry id from undeclared
 * event members.
 *
 * pi declares SessionCompactFailedEvent as {reason, errorMessage?, aborted,
 * willRetry, fromExtension} - no `result`, no `compactionEntry`. The event
 * reports an outcome that landed no entry, so no entry id can exist for it.
 * The overflow-failure handler once derived one from
 * `event.result?.firstKeptEntryId ?? event.compactionEntry?.id`.
 *
 * The events below carry those members behind counted accessors: a handler
 * read fails the test instead of silently deriving an id. The branches are
 * asserted alongside - a failure with attempts left arms the retry, an
 * exhausted failure resets the ladder.
 *
 * Run: node test/runtime/memory/test-overflow-retry-entry-id.mjs
 *      (after npm run build - this test reads dist, not src)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME redirect BEFORE dist imports: nudges/settings resolution walks homedir().
process.env.HOME = mkdtempSync(join(tmpdir(), "overflow-retry-entry-id-"));

const { handleOverflowFailure } = await import(
  "../../../dist/extensions/memory/context-manager/handlers/compaction-retry.js"
);
const { resetOverflowRetry, overflowRetryState, OVERFLOW_RETRY_MAX_ATTEMPTS } =
  await import("../../../dist/extensions/memory/context-manager/handlers/shared.js");

console.log("=== overflow failure derives no id from undeclared event members ===\n");

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

function makePi() {
  return { sendMessage() {} };
}

function makeCtx() {
  return { cwd: "/tmp/overflow-retry-entry-id" };
}

/** Undeclared event members read since the last resetState(). */
let undeclaredReads = [];

/**
 * A declared-shape failure event. Members passed via `undeclared` are attached
 * behind accessors that record every read, so a handler that consumes them
 * cannot pass silently.
 */
function failureEvent(undeclared = {}) {
  const event = {
    type: "session_compact_failed",
    reason: "overflow",
    aborted: false,
  };
  for (const [key, value] of Object.entries(undeclared)) {
    Object.defineProperty(event, key, {
      get() {
        undeclaredReads.push(key);
        return value;
      },
      enumerable: true,
    });
  }
  return event;
}

function resetState() {
  undeclaredReads = [];
  resetOverflowRetry();
}

await test("retry branch: a failure carrying result.firstKeptEntryId arms the retry, unread", async () => {
  resetState();
  await handleOverflowFailure(
    makePi(),
    failureEvent({ result: { firstKeptEntryId: "entry-from-result" } }),
    makeCtx(),
    "network 529",
  );
  assert.deepEqual(undeclaredReads, [], "event.result must not be read");
  assert.notEqual(overflowRetryState.retryTimeout, null, "the retry must be armed");
  resetState();
});

await test("retry branch: a failure carrying compactionEntry.id arms the retry, unread", async () => {
  resetState();
  await handleOverflowFailure(
    makePi(),
    failureEvent({ compactionEntry: { id: "entry-from-event" } }),
    makeCtx(),
    "network 529",
  );
  assert.deepEqual(undeclaredReads, [], "event.compactionEntry must not be read");
  assert.notEqual(overflowRetryState.retryTimeout, null, "the retry must be armed");
  resetState();
});

await test("exhausted branch: a failure resets the ladder, undeclared members unread", async () => {
  resetState();
  overflowRetryState.attempt = OVERFLOW_RETRY_MAX_ATTEMPTS;
  await handleOverflowFailure(
    makePi(),
    failureEvent({ result: { firstKeptEntryId: "entry-from-result" } }),
    makeCtx(),
    "network 529",
  );
  assert.deepEqual(undeclaredReads, [], "event.result must not be read");
  assert.equal(overflowRetryState.attempt, 0, "the exhausted ladder must reset");
  assert.equal(overflowRetryState.retryTimeout, null, "no retry may remain armed");
  resetState();
});

await test("an honest failure event (declared members only) arms the retry, unread", async () => {
  resetState();
  await handleOverflowFailure(makePi(), failureEvent(), makeCtx(), "network 529");
  assert.deepEqual(undeclaredReads, [], "no undeclared member exists to read");
  assert.notEqual(overflowRetryState.retryTimeout, null, "the retry must be armed");
  resetState();
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== overflow failure undeclared-surface tests passed ===");
