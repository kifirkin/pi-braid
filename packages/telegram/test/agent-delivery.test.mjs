/**
 * agent-delivery.test.mjs — the telegram_send ↔ live-update delivery flag.
 *
 * The flag tells live-update finish() that the agent already delivered an
 * explicit report via telegram_send this turn, so the auto summary is
 * suppressed (owner report: duplicate second message). NO network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  markAgentDeliveredMessage,
  clearAgentDeliveredMessage,
  wasAgentDeliveredMessage,
} from "../dist/lib/notify/agent-delivery.js";

test("flag: starts false", () => {
  clearAgentDeliveredMessage();
  assert.equal(wasAgentDeliveredMessage(), false);
});

test("flag: mark → read true", () => {
  clearAgentDeliveredMessage();
  assert.equal(wasAgentDeliveredMessage(), false);
  markAgentDeliveredMessage();
  assert.equal(wasAgentDeliveredMessage(), true);
});

test("flag: clear is idempotent and resets to false", () => {
  markAgentDeliveredMessage();
  clearAgentDeliveredMessage();
  clearAgentDeliveredMessage(); // double-clear must not throw
  assert.equal(wasAgentDeliveredMessage(), false);
});

test("flag: double mark stays true until cleared", () => {
  clearAgentDeliveredMessage();
  markAgentDeliveredMessage();
  markAgentDeliveredMessage();
  assert.equal(wasAgentDeliveredMessage(), true);
  clearAgentDeliveredMessage();
  assert.equal(wasAgentDeliveredMessage(), false);
});
