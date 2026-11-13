/**
 * outbound-gate.test.mjs — the formatter refuses before the network.
 *
 * Rules pinned here:
 *   - a body over 280 chars with NO parse mode and NO rich is refused, and the
 *     error names the rule, the length and the cap;
 *   - an unsupported tag is refused, and the error names the tag;
 *   - an unclosed tag is refused, and the error names the tag and its offset;
 *   - NOTHING reaches the client on a refusal (the stub records zero calls);
 *   - a well-formed body gets converted ONCE and the conversion is what ships;
 *   - the tool path returns the same refusal to the agent (ok:false, rule,
 *     offset) instead of an API error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  planOutbound,
  createOutboundSender,
  outboundMetricsSnapshot,
  resetOutboundMetrics,
  OUTBOUND_PLAIN_MAX_CHARS,
} from "../dist/lib/notify/outbound.js";
import { runTelegramSend } from "../dist/lib/tool-logic.js";
import { checkTelegramHtml } from "../dist/lib/html-check.js";
import { BOT_TOKEN, OWNER_CHAT_ID } from "./fixtures.mjs";

function capturingClient() {
  const calls = [];
  return {
    calls,
    client: {
      sendMessage: async (token, chatId, text, options = {}) => {
        calls.push({ token, chatId, text, options });
        return { ok: true, messageId: 5000 + calls.length };
      },
    },
  };
}

const sender = (stub) =>
  createOutboundSender({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
  });

test("a body over the plain cap with no mode and no rich is refused, naming the rule and the length", async () => {
  resetOutboundMetrics();
  const stub = capturingClient();
  const body = "x".repeat(561);
  const plan = planOutbound({ text: body, source: "tool" });
  assert.equal(plan.ok, false);
  assert.equal(plan.refusal.rule, "plain-over-cap");
  assert.equal(plan.refusal.length, 561, "the refusal carries the length");
  assert.equal(
    plan.refusal.offset,
    OUTBOUND_PLAIN_MAX_CHARS,
    "and the cap offset",
  );
  assert.match(plan.refusal.error, /plain-over-cap/);
  assert.match(plan.refusal.error, /561 chars/);
  assert.match(plan.refusal.error, /the plain cap is 280/);

  const out = await sender(stub).send({ text: body, source: "tool" });
  assert.equal(out.ok, false);
  assert.equal(out.refusal.rule, "plain-over-cap");
  assert.equal(stub.calls.length, 0, "NOTHING was sent");
  assert.equal(outboundMetricsSnapshot().refusalsByRule["plain-over-cap"], 1);
});

test("the cap boundary is exact: 280 plain ships, 281 is refused", async () => {
  const stub = capturingClient();
  const atCap = "y".repeat(OUTBOUND_PLAIN_MAX_CHARS);
  const over = "y".repeat(OUTBOUND_PLAIN_MAX_CHARS + 1);

  const okPlan = planOutbound({ text: atCap, source: "tool" });
  assert.equal(okPlan.ok, true, "280 plain is allowed");
  const overPlan = planOutbound({ text: over, source: "tool" });
  assert.equal(overPlan.ok, false);
  assert.equal(overPlan.refusal.rule, "plain-over-cap");

  const out = await sender(stub).send({ text: atCap, source: "tool" });
  assert.equal(out.ok, true);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].text, atCap, "the body ships unchanged");
});

test("an unsupported tag is refused and the error names the tag", async () => {
  const stub = capturingClient();
  const body = "<ul><li>one</li><li>two</li></ul>";
  const out = await sender(stub).send({
    text: body,
    parseMode: "HTML",
    source: "tool",
  });
  assert.equal(out.ok, false);
  assert.equal(out.refusal.rule, "unsupported-tag");
  assert.equal(out.refusal.tag, "ul");
  assert.match(out.refusal.error, /unsupported-tag/);
  assert.match(out.refusal.error, /<ul>/);
  assert.match(
    out.refusal.error,
    /Telegram only accepts b, i, u, s, a, code, pre, tg-spoiler and blockquote/,
  );
  assert.equal(stub.calls.length, 0, "NOTHING was sent");

  // The body is auto-detected as HTML even without an explicit mode; the
  // refusal must not depend on the caller remembering `parse_mode`.
  const auto = await sender(stub).send({ text: body, source: "tool" });
  assert.equal(auto.ok, false);
  assert.equal(auto.refusal.tag, "ul");
  assert.equal(stub.calls.length, 0);
});

test("an unclosed tag is refused and the error names the tag and its offset", async () => {
  const stub = capturingClient();
  const body = "intro <b>bold text that never closes";
  const out = await sender(stub).send({
    text: body,
    parseMode: "HTML",
    source: "tool",
  });
  assert.equal(out.ok, false);
  assert.equal(out.refusal.rule, "unclosed-tag");
  assert.equal(out.refusal.tag, "b");
  assert.equal(out.refusal.offset, 6, "offset of the tag that was left open");
  assert.match(out.refusal.error, /Can't find end tag/);
  assert.equal(stub.calls.length, 0);

  // A stray end tag is a closure error too.
  const stray = planOutbound({
    text: "text </b> more",
    parseMode: "HTML",
    source: "tool",
  });
  assert.equal(stray.ok, false);
  assert.equal(stray.refusal.rule, "stray-end-tag");
  assert.equal(stray.refusal.tag, "b");
});

test("a valid HTML body ships as HTML, and a well-formed long body converts once", async () => {
  const stub = capturingClient();
  const body = `<b>report</b>\nstatus ok ${"z".repeat(300)}`;
  const out = await sender(stub).send({
    text: body,
    parseMode: "HTML",
    source: "tool",
  });
  assert.equal(out.ok, true, "valid HTML past the plain cap ships");
  assert.equal(out.parseMode, "HTML");
  assert.ok(stub.calls[0].options.parseMode === "HTML");

  const conv = await sender(stub).send({
    text: `**bold** and __underline__ ${"q".repeat(300)}`,
    rich: true,
    source: "tool",
  });
  assert.equal(conv.ok, true);
  assert.equal(conv.parseMode, "HTML", "marker pairs convert to HTML");
  assert.match(stub.calls.at(-1).text, /<b>bold<\/b>/);
  assert.match(stub.calls.at(-1).text, /<u>underline<\/u>/);
  assert.ok(
    conv.converted && conv.converted.bold === 1,
    "the conversion is reported once, not re-run per chunk",
  );
});

test("rich and an explicit mode are the two ways past the plain cap", async () => {
  const stub = capturingClient();
  const long = "w".repeat(900);
  const rich = await sender(stub).send({
    text: long,
    rich: true,
    source: "summary",
  });
  assert.equal(rich.ok, true, "rich bypasses the plain cap");
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].text, long);

  const markdown = await sender(stub).send({
    text: long,
    parseMode: "Markdown",
    source: "tool",
  });
  assert.equal(
    markdown.ok,
    true,
    "an explicit parse mode is a structured body",
  );
  assert.equal(stub.calls.length, 2);
});

test("the Telegram tool returns the same refusal to the agent (rule + offset, nothing sent)", async () => {
  resetOutboundMetrics();
  const stub = capturingClient();
  const body = "r".repeat(400);
  const outcome = await runTelegramSend(
    { text: body },
    { client: stub.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.rule, "plain-over-cap");
  assert.equal(outcome.offset, OUTBOUND_PLAIN_MAX_CHARS);
  assert.match(outcome.error, /plain-over-cap/);
  assert.match(outcome.error, /400 chars/);
  assert.equal(stub.calls.length, 0, "the wire was never touched");

  // The same tool call with `rich` delivers.
  const rich = await runTelegramSend(
    { text: body, rich: true },
    { client: stub.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(rich.ok, true);
  assert.equal(stub.calls.length, 1);
});

test("the local checker agrees with the refusal on every rule (no drift)", () => {
  const cases = ["<ul>x</ul>", "<b>open", "stray </i> close", '<a href="x'];
  for (const body of cases) {
    const verdict = checkTelegramHtml(body);
    const plan = planOutbound({
      text: body,
      parseMode: "HTML",
      source: "tool",
    });
    assert.equal(verdict.ok, false, `${body} must be invalid`);
    assert.equal(plan.ok, false, `${body} must be refused`);
    if (!verdict.ok && !plan.ok) {
      assert.equal(
        plan.refusal.error.includes(verdict.error),
        true,
        "same verdict text",
      );
    }
  }
});
