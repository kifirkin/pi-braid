/**
 * outbound-gate.test.mjs — the formatter refuses before the network.
 *
 * Rules pinned here:
 *   - a body over 280 chars with NO parse mode and NO rich is refused, and the
 *     error names the rule, the length and the cap;
 *   - an unsupported tag is refused, and the error names the tag;
 *   - an unclosed tag is refused, and the error names the tag and its offset;
 *   - a sender-facing body over the cap with NO structure is refused even when
 *     it asks for `rich` or a `parse_mode` — the request picks the transport,
 *     it does not format the prose — with the length, the rule and the remedy;
 *   - NOTHING reaches the client on a refusal (the stub records zero calls);
 *   - a well-formed body gets converted ONCE and the conversion is what ships;
 *   - every delivered body opens with this process's identity line;
 *   - the tool path returns the same refusal to the agent (ok:false, rule,
 *     offset) instead of an API error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasOutboundStructure,
  planOutbound,
  createOutboundSender,
  outboundMetricsSnapshot,
  resetOutboundMetrics,
  OUTBOUND_PLAIN_MAX_CHARS,
} from "../dist/lib/notify/outbound.js";
import {
  currentIdentityLine,
  isIdentityLine,
  resetIdentityCache,
} from "../dist/lib/identity.js";
import { runTelegramSend } from "../dist/lib/tool-logic.js";
import { checkTelegramHtml } from "../dist/lib/html-check.js";
import { BOT_TOKEN, OWNER_CHAT_ID, wire } from "./fixtures.mjs";

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
  assert.equal(stub.calls[0].text, wire(atCap), "the body ships unchanged");
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

test("past the cap a request picks the transport; the BODY must carry structure", async () => {
  resetOutboundMetrics();
  const stub = capturingClient();
  const wall = "w".repeat(900);

  // rich is not a formatter: a wall of prose asked for as `rich` is refused.
  const richWall = await sender(stub).send({
    text: wall,
    rich: true,
    source: "tool",
  });
  assert.equal(richWall.ok, false, "rich alone does not format the prose");
  assert.equal(richWall.refusal.rule, "unstructured-over-cap");
  assert.equal(richWall.refusal.length, 900, "the refusal names the length");
  assert.equal(stub.calls.length, 0, "NOTHING was sent");

  // The same for an explicit parse_mode with no markup in the body.
  const htmlWall = await sender(stub).send({
    text: wall,
    parseMode: "HTML",
    source: "tool",
  });
  assert.equal(htmlWall.ok, false);
  assert.equal(htmlWall.refusal.rule, "unstructured-over-cap");
  assert.equal(stub.calls.length, 0);

  // rich + structure ships, split to fit.
  const richStructured = await sender(stub).send({
    text: `<b>heads up</b>\n${wall}`,
    rich: true,
    source: "tool",
  });
  assert.equal(richStructured.ok, true, "a structured rich body ships");
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].text, wire(`<b>heads up</b>\n${wall}`, "HTML"));

  // An automatic source keeps its delivery: it has no sender to refuse to.
  const summary = await sender(stub).send({
    text: wall,
    rich: true,
    source: "summary",
  });
  assert.equal(summary.ok, true, "an automatic source is not held to it");
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

  // The same tool call with `rich` delivers — routing is not formatting, so
  // the body itself has to carry structure past the cap.
  const structured = `<b>r</b>\n${body}`;
  const rich = await runTelegramSend(
    { text: structured, rich: true },
    { client: stub.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(rich.ok, true);
  assert.equal(stub.calls.length, 1);

  // A `rich` wall is refused, and the refusal reaches the sender.
  const richWall = await runTelegramSend(
    { text: body, rich: true },
    { client: stub.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(richWall.ok, false);
  assert.equal(richWall.rule, "unstructured-over-cap");
  assert.match(richWall.error, /400 chars/);
  assert.match(richWall.error, /unstructured-over-cap/);
  assert.match(richWall.error, /parse_mode/);
  assert.equal(stub.calls.length, 1, "the wire was not touched again");
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

test("structure is what a reader can SEE — tags, bullets, numbers, labels", () => {
  const filler = "x".repeat(400);
  const structured = [
    `<b>${filler}</b>`,
    `<b>report</b>\n${filler}`,
    `- ${filler}`,
    `1. ${filler}`,
    `## ${filler}`,
    `**${filler}**`,
    `Status: ok\n${filler}`,
  ];
  for (const body of structured) {
    const plan = planOutbound({ text: body, rich: true, source: "tool" });
    assert.equal(
      plan.ok,
      true,
      `structured body refused: ${body.slice(0, 16)}`,
    );
    assert.equal(hasOutboundStructure(body), true);
  }

  // Prose is not structure, however many paragraphs it has: that is the wall.
  const walls = [
    "x".repeat(400),
    "One sentence of prose. ".repeat(40),
    `First paragraph of prose.\n\n${"y".repeat(400)}\n\nThird paragraph.`,
    // A URL is not a label: the colon is followed by a slash, not a space.
    `https://example.invalid/${"z".repeat(400)}`,
  ];
  for (const body of walls) {
    const plan = planOutbound({ text: body, rich: true, source: "tool" });
    assert.equal(plan.ok, false, `wall accepted: ${body.slice(0, 16)}`);
    assert.equal(plan.refusal.rule, "unstructured-over-cap");
    assert.equal(hasOutboundStructure(body), false);
  }
});

test("the structure refusal names the length, the rule and the remedy", async () => {
  resetOutboundMetrics();
  const stub = capturingClient();
  const body = "w".repeat(612);
  const out = await sender(stub).send({
    text: body,
    rich: true,
    source: "tool",
  });
  assert.equal(out.ok, false);
  assert.equal(out.refusal.rule, "unstructured-over-cap");
  assert.equal(out.refusal.length, 612, "the refusal carries the length");
  assert.equal(out.refusal.offset, OUTBOUND_PLAIN_MAX_CHARS, "and the cap");
  assert.match(out.refusal.error, /612 chars/, "the length is in the sentence");
  assert.match(out.refusal.error, /unstructured-over-cap/, "so is the rule");
  assert.match(out.refusal.error, /parse_mode:"HTML"/, "and the remedy");
  assert.match(out.refusal.error, /structure it/i, "structure is the fix");
  assert.match(out.refusal.error, /NOTHING was sent/);
  assert.equal(stub.calls.length, 0, "the owner received nothing");
  assert.equal(
    outboundMetricsSnapshot().refusalsByRule["unstructured-over-cap"],
    1,
    "the refusal is counted by rule",
  );
});

test("every delivered body opens with ONE identity line — the process's own", async () => {
  const stub = capturingClient();
  const first = await sender(stub).send({ text: "hello", source: "tool" });
  assert.equal(first.ok, true);
  const wireBody = stub.calls[0].text;
  const lines = wireBody.split("\n");
  assert.equal(isIdentityLine(lines[0]), true, "line 1 is the label");
  assert.equal(lines[0], currentIdentityLine(), "and it is this process's");
  assert.equal(lines[1], "hello", "the body follows, untouched");
  assert.equal(
    lines.filter((line) => isIdentityLine(line)).length,
    1,
    "exactly one label, never two",
  );

  // The same body sent again carries the same label: one process, one label.
  await sender(stub).send({ text: "hello", source: "tool" });
  assert.equal(stub.calls[1].text, wireBody);
});

test("the label is the PROCESS's, not the caller's: two processes, two lines", async () => {
  const stub = capturingClient();
  const saved = process.env.BRAID_SESSION_ROLE;
  try {
    process.env.BRAID_SESSION_ROLE = "seat";
    resetIdentityCache();
    await sender(stub).send({ text: "from the seat", source: "tool" });

    process.env.BRAID_SESSION_ROLE = "worker";
    resetIdentityCache();
    await sender(stub).send({ text: "from the worker", source: "tool" });
  } finally {
    if (saved === undefined) delete process.env.BRAID_SESSION_ROLE;
    else process.env.BRAID_SESSION_ROLE = saved;
    resetIdentityCache();
  }
  const seatLabel = stub.calls[0].text.split("\n")[0];
  const workerLabel = stub.calls[1].text.split("\n")[0];
  assert.notEqual(seatLabel, workerLabel, "two processes, two headers");
  assert.match(seatLabel, /· seat ·/);
  assert.match(workerLabel, /· worker ·/);
  assert.equal(stub.calls[0].text, `${seatLabel}\nfrom the seat`);
  assert.equal(stub.calls[1].text, `${workerLabel}\nfrom the worker`);
});

test("the structure rule is the gate's, not one caller's: an automatic source keeps its delivery", async () => {
  const stub = capturingClient();
  const wall = "v".repeat(700);
  // A crafted summary has no sender to refuse to: it ships, labelled.
  const summary = createOutboundSender({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
  });
  const out = await summary.send({
    text: wall,
    rich: true,
    source: "summary",
  });
  assert.equal(out.ok, true, "an automatic body is not held to the rule");
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].text, wire(wall));
});
