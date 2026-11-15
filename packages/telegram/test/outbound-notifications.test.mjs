/**
 * outbound-notifications.test.mjs — the automatic messages are held to the same
 * rule as the agent's own sends, and the outbound surface is measurable.
 *
 * The owner's rule was "no raw unstructured text longer than a tweet length,
 * and the automatic messages reviewed the same way". Every machine-generated
 * owner message in this package (the tracked line, the turn summary, the
 * turn-complete notify, the adherence digest, the watchdog canary, the provider
 * outage alert) goes through the same gate, so the rule and the HTML check
 * cannot be forgotten by the next notification someone adds.
 *
 * The gate also owns the four counters: tracked acks, owner-facing messages in
 * the last hour by source, escalations folded into a digest, and refusals by
 * rule. `BRAID_TG_OUTBOUND_METRICS=1` prints them after every send.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createOutboundSender,
  outboundMetricsSnapshot,
  resetOutboundMetrics,
  renderOutboundMetrics,
  noteOwnerMessage,
  noteRefusal,
} from "../dist/lib/notify/outbound.js";
import { checkTelegramHtml } from "../dist/lib/html-check.js";
import { BOT_TOKEN, OWNER_CHAT_ID } from "./fixtures.mjs";

/**
 * The digest bodies core renders, recorded in the shared fixture file rather
 * than retyped here: this package cannot import core (it is a standalone
 * package with no core dependency), so the file is the contract between the
 * producer's fixture and this one. Every body below is pushed through the real
 * gate and Telegram's own parser, which is the part only this package can
 * assert.
 */
const FROZEN_DIGESTS = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "adherence-digest-bodies.json",
    ),
    "utf8",
  ),
).bodies;

function capturingClient() {
  const calls = [];
  return {
    calls,
    client: {
      sendMessage: async (token, chatId, text, options = {}) => {
        calls.push({ chatId, text, options });
        return { ok: true, messageId: 7000 + calls.length };
      },
    },
  };
}

function makeSender(stub, log) {
  return createOutboundSender({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    ...(log ? { log } : {}),
  });
}

const SOURCES = [
  "tool",
  "tracked",
  "summary",
  "turn-notify",
  "adherence-digest",
  "watchdog-signal",
  "outage-notify",
];

test("every machine-generated source ships through the gate and is counted by source", async () => {
  resetOutboundMetrics();
  const stub = capturingClient();
  const gate = makeSender(stub);
  for (const source of SOURCES) {
    const out = await gate.send({ text: `ping from ${source}`, source });
    assert.equal(out.ok, true, `${source} delivers`);
  }
  assert.equal(stub.calls.length, SOURCES.length);
  const snap = outboundMetricsSnapshot();
  for (const source of SOURCES) {
    assert.equal(
      snap.ownerMessagesLastHour[source],
      1,
      `${source} is counted in the hour`,
    );
  }
});

test("an automatic message over the plain cap is refused exactly like a tool send", async () => {
  resetOutboundMetrics();
  const stub = capturingClient();
  const gate = makeSender(stub);
  const body = "adherence detail ".repeat(40);
  for (const source of ["watchdog-signal", "outage-notify", "turn-notify"]) {
    const out = await gate.send({ text: body, source });
    assert.equal(out.ok, false, `${source} refuses an unstructured body`);
    assert.equal(out.refusal.rule, "plain-over-cap");
    assert.equal(out.refusal.length, body.length);
  }
  assert.equal(stub.calls.length, 0, "NOTHING was sent");
  assert.equal(outboundMetricsSnapshot().refusalsByRule["plain-over-cap"], 3);
});

test("the adherence digest bodies ship as HTML, parse, and record the suppressed count", async () => {
  resetOutboundMetrics();
  const stub = capturingClient();
  const gate = makeSender(stub);
  const names = ["one-rule", "four-folded", "escaped"];

  for (const [index, name] of names.entries()) {
    const body = FROZEN_DIGESTS[name].join("\n");
    const plan = gate.plan({
      text: body,
      parseMode: "HTML",
      source: "adherence-digest",
    });
    assert.equal(plan.ok, true, `${name}: the gate accepts the body`);
    assert.equal(
      checkTelegramHtml(body).ok,
      true,
      `${name}: Telegram parses it`,
    );

    const out = await gate.send({
      text: body,
      parseMode: "HTML",
      source: "adherence-digest",
      suppressed: index,
    });
    assert.equal(out.ok, true, `${name}: delivered as HTML`);
    assert.equal(out.parseMode, "HTML");
    assert.equal(stub.calls[index].options.parseMode, "HTML");
  }

  const snap = outboundMetricsSnapshot();
  assert.equal(
    snap.escalationsSuppressed,
    3,
    "suppressed is recorded with each send",
  );
  assert.equal(snap.ownerMessagesLastHour["adherence-digest"], 3);
});

test("the counter page covers all four counters and the hourly window", async () => {
  resetOutboundMetrics();
  const now = 1_700_000_000_000;
  const hour = 60 * 60 * 1000;
  // A fixture day: sends spread across 24h, one refusal, one suppressed batch.
  for (let h = 0; h < 24; h++) {
    noteOwnerMessage("tracked", now - h * hour);
    noteOwnerMessage("summary", now - h * hour - 1);
  }
  noteOwnerMessage("turn-notify", now - 30 * 60 * 1000);
  noteOwnerMessage("adherence-digest", now - 90 * 60 * 1000);
  noteRefusal("plain-over-cap");
  noteRefusal("unsupported-tag");
  const snap = outboundMetricsSnapshot(now);
  assert.equal(
    snap.ownerMessagesTotal.tracked,
    24,
    "total counts the whole day",
  );
  assert.equal(snap.ownerMessagesTotal.summary, 24);
  assert.equal(
    snap.ownerMessagesLastHour.tracked,
    1,
    "the hour view is a window",
  );
  assert.equal(snap.ownerMessagesLastHour["turn-notify"], 1, "within the hour");
  assert.equal(
    snap.ownerMessagesLastHour["adherence-digest"],
    undefined,
    "90 minutes ago is outside the hour",
  );
  assert.equal(snap.refusalsByRule["plain-over-cap"], 1);
  assert.equal(snap.refusalsByRule["unsupported-tag"], 1);

  const page = renderOutboundMetrics(now);
  assert.match(page, /outbound metrics:/);
  assert.match(page, /tracked acks 0/);
  assert.match(
    page,
    /owner messages\/hour tracked 1 · summary 1 · turn-notify 1/,
  );
  assert.match(page, /escalations suppressed 0/);
  assert.match(page, /refusals plain-over-cap 1 · unsupported-tag 1/);
});

test("BRAID_TG_OUTBOUND_METRICS=1 makes the sender log the counters", async () => {
  resetOutboundMetrics();
  const stub = capturingClient();
  const lines = [];
  const log = (level, message) => lines.push(`${level}: ${message}`);
  process.env.BRAID_TG_OUTBOUND_METRICS = "1";
  try {
    const gate = makeSender(stub, log);
    await gate.send({ text: "hello", source: "tracked" });
    await gate.send({ text: "x".repeat(400), source: "tool" });
  } finally {
    delete process.env.BRAID_TG_OUTBOUND_METRICS;
  }
  const metricLines = lines.filter((l) => l.includes("outbound metrics:"));
  assert.equal(metricLines.length, 2, "one line per send/refusal");
  assert.match(metricLines[0], /tracked acks 1/);
  assert.match(metricLines[1], /refusals plain-over-cap 1/);
});

test("the flag is off by default (no counter line on ordinary sends)", async () => {
  resetOutboundMetrics();
  const stub = capturingClient();
  const lines = [];
  const gate = makeSender(stub, (level, message) =>
    lines.push(`${level}: ${message}`),
  );
  await gate.send({ text: "hello", source: "tracked" });
  assert.equal(
    lines.filter((l) => l.includes("outbound metrics:")).length,
    0,
    "silent unless the flag is set",
  );
});
