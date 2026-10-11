/**
 * poll-helper.test.mjs — the retry semantics of test/helpers/poll.mjs.
 *
 * Pins the contract that a throwing predicate is "not yet": it is retried,
 * and only an unbroken run of failures times out — naming the last error so a
 * genuinely broken predicate fails informatively instead of as a bare
 * "condition not met".
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { waitFor } from "./helpers/poll.mjs";

test("waitFor: a predicate that throws transiently is retried until it succeeds", async () => {
  let attempts = 0;
  await waitFor(() => {
    attempts += 1;
    // Mirrors reading a state file mid-write: parse throws until the write
    // lands, then the real condition holds.
    if (attempts < 4) throw new Error("transient mid-write");
    return true;
  }, 2000);
  assert.equal(attempts, 4, "predicate kept being polled after it threw");
});

test("waitFor: an always-throwing predicate retries, then times out naming the last error", async () => {
  let attempts = 0;
  await assert.rejects(
    waitFor(
      () => {
        attempts += 1;
        throw new Error("predicate is genuinely broken");
      },
      150,
      10,
    ),
    (error) => {
      assert.match(error.message, /predicate is genuinely broken/);
      assert.match(error.message, /150ms/);
      return true;
    },
  );
  assert.ok(attempts > 1, `expected retries before timeout, saw ${attempts}`);
});
