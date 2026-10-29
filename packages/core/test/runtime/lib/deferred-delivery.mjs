/**
 * deferred-delivery.mjs: wait for a deferred chain on the condition the case
 * asserts, instead of sleeping a guessed number of milliseconds.
 *
 * The chain a fixture like this reads is not the fixture's own work: the
 * session_compact handler defers with setTimeout(0), the whisper runs through
 * sendEnforcementWhisper -> sendTrackedMessage, then another setTimeout(0) for
 * triggerTurn, then gateTriggerTurnOptions, then pi.sendMessage. A fixed sleep
 * is a guess about how long those deferrals take on the box the suite happens
 * to run on; under load the guess loses, the count is read before anything
 * arrives, and the assertion blames the product for the fixture's wait.
 *
 * Two waits, deliberately not one:
 *
 *   waitForDelivery()  the case expects something to arrive. Poll the sink
 *                      until it has grown past its starting count and then
 *                      hold until the count stops moving. The quiet step is
 *                      load-bearing: a duplicate from the same chain lands on
 *                      the next macrotask, so reading the instant the first
 *                      arrives would report a double-send as a single send.
 *
 *   waitOutSilence()   the case expects nothing to arrive. There is no
 *                      arrival to poll for, so the only available evidence is
 *                      a window long enough that the chain would have
 *                      delivered if it were going to. A poll here would
 *                      return immediately and prove nothing.
 *
 * A single `wait(ms)` would be the fixed sleep with a poll bolted on, which is
 * the failure this module exists to remove.
 */
import { strict as assert } from "node:assert";

/** Upper bound on a delivery the case expects. Load changes WHEN the chain
 *  lands, never WHETHER it does, so this is not the measurement. */
export const DELIVERY_DEADLINE_MS = 2000;

/** Once something has arrived, the count must stop moving before it is read. A
 *  duplicate delivery from the same chain lands on the next macrotask, so
 *  reading the instant the first arrives would report a double-send as a
 *  single send - the failure the `exactly one` cases exist to catch. */
export const QUIET_MS = 50;

/** How often the sink is re-read while waiting. */
export const STEP_MS = 5;

/** A case that expects silence has no arrival to wait for, so it waits out a
 *  window instead. This is the one place where a duration is the only
 *  available evidence, and it is sized from the chain's measured arrival
 *  latency: 5ms p50 and 9ms p99 on an idle box, 101ms worst observed under 16x
 *  CPU oversubscription. A window under that tail would make "nothing
 *  arrived" true because the chain had not finished, not because nothing was
 *  sent. */
export const SILENCE_WINDOW_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until `sink` holds at least `atLeast` entries (default: one more than
 * `from`) and the count has held still for QUIET_MS, or until the deadline.
 *
 * `from` is the count read before the case triggered the chain: a sink that
 * already held entries before the trigger must not satisfy the wait by itself.
 * Returns the last count observed.
 */
export async function waitForDelivery(
  sink,
  { from = 0, atLeast = from + 1, deadlineMs = DELIVERY_DEADLINE_MS } = {},
) {
  const deadline = Date.now() + deadlineMs;
  let seen = from;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const count = sink.length;
    if (count !== seen) {
      seen = count;
      stableSince = Date.now();
    } else if (seen >= atLeast && Date.now() - stableSince >= QUIET_MS) {
      break;
    }
    await sleep(STEP_MS);
  }
  return seen;
}

/**
 * Wait out the window a negative case needs to make "nothing arrived" mean
 * something. Reads no sink: the caller asserts on the sink after the window,
 * so the window cannot accidentally become the assertion.
 */
export async function waitOutSilence({ windowMs = SILENCE_WINDOW_MS } = {}) {
  await sleep(windowMs);
}

/**
 * Exactly one entry in `sink`, with a failure that names which way the chain
 * went wrong: nothing arrived (the chain never delivered) or more than one did
 * (it delivered twice).
 */
export function assertExactlyOne(
  sink,
  { what = "message", where = "pi.sendMessage", missingNote = "", deadlineMs = DELIVERY_DEADLINE_MS } = {},
) {
  const count = sink.length;
  const detail = missingNote === "" ? "" : `: ${missingNote}`;
  assert.ok(
    count === 1,
    count === 0
      ? `no ${what} reached ${where} within ${deadlineMs}ms (the deferred chain never delivered)${detail}`
      : `expected exactly one ${what} at ${where}, got ${count} (the ${what} was delivered more than once)`,
  );
}
