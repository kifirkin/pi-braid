/**
 * reply-context.test.mjs — the owner replying to a specific message.
 *
 * A reply is an implicit reference ("yes, that one"), and Telegram carries it
 * in `message.reply_to_message`. Without it the agent has nothing to attach
 * the answer to and must guess or ask again. These tests pin four properties:
 *
 *   1. the reference is carried on `IncomingOwnerMessage.replyTo` (replied id,
 *      whether that message was OURS or the owner's, and a short excerpt);
 *   2. it is rendered into the braid-whisper envelope the agent reads, next to
 *      the sender line, and nowhere else;
 *   3. EVERY delivery path carries it — text, photo, voice, document,
 *      text+document — because a reference that only works on the common path
 *      is missing exactly when the message is interesting;
 *   4. it degrades the REFERENCE, never the delivery: a missing or malformed
 *      reply field leaves the message a normal delivered message (the control
 *      cases below).
 *
 * Synthetic updates only: a fake fetch serves the media fixtures, so nothing
 * here touches the network or a live bot.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyUpdate,
  createInboundPoller,
  extractIncomingMessage,
} from "../dist/lib/inbound-poller.js";
import { fetchInbox } from "../dist/lib/telegram-inbox.js";
import {
  inboundQueueFileFor,
  loadInboundQueue,
  saveInboundQueue,
} from "../dist/lib/inbound-queue.js";
import { formatInboundBatch, formatInboundMessage } from "../dist/index.js";

import {
  BOT_TOKEN,
  OWNER_CHAT_ID,
  OWNER_ID,
  jsonResponse,
  makeFakeFetch,
  makeUpdate,
  makeUpdatesServer,
} from "./fixtures.mjs";

/** Our bot's own id in the fixtures (the bot that sent `sendMessageResult`). */
const BOT_ID = 555555;

/**
 * The one-line excerpt cap the code documents. Pinned here as a contract: the
 * excerpt is untrusted text quoted into the prompt header, so a multi-KB
 * replied message must not ride into the envelope.
 */
const EXCERPT_CAP = 120;

let mediaDir;
beforeEach(() => {
  mediaDir = join(mkdtempSync(join(tmpdir(), "tg-reply-")), "media");
});

/** A replied message as Telegram reports it (the quoted side of a reply). */
function repliedMessage(overrides = {}) {
  return {
    message_id: 4242,
    from: {
      id: BOT_ID,
      is_bot: true,
      first_name: "braid",
      username: "braid_test_bot",
    },
    chat: { id: OWNER_CHAT_ID, type: "private", username: "owner" },
    date: 1700000000,
    text: "deploy finished, 2 tests failed",
    ...overrides,
  };
}

/** An owner update replying to `reply_to_message`. */
function replyUpdate(updateId, replyTo, messageOverrides = {}) {
  return makeUpdate(
    updateId,
    { reply_to_message: replyTo, ...messageOverrides },
    false,
  );
}

/** Fake getFile + /file/bot server for one media download (no network). */
function makeMediaServer({ filePath, bytes = new Uint8Array([1, 2, 3]) }) {
  return async (url) => {
    if (url.includes("getFile")) {
      return jsonResponse({
        ok: true,
        result: { file_id: "f1", file_path: filePath },
      });
    }
    if (url.includes("/file/bot")) return new Response(bytes, { status: 200 });
    throw new Error(`unexpected url: ${url}`);
  };
}

// ── Extraction: what is carried ─────────────────────────────────────────────

test("reply to one of our bot's messages: id, author agent, excerpt of its text", async () => {
  const incoming = await extractIncomingMessage(
    replyUpdate(10, repliedMessage(), { text: "yes, that one" }),
  );

  assert.deepEqual(incoming.replyTo, {
    messageId: 4242,
    author: "agent",
    excerpt: "deploy finished, 2 tests failed",
  });
  // The reply itself is untouched: the reference rides alongside, never in place.
  assert.equal(incoming.text, "yes, that one");
});

test("reply to the owner's own earlier message: author owner, never conflated with ours", async () => {
  const incoming = await extractIncomingMessage(
    replyUpdate(
      11,
      repliedMessage({
        from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
        text: "earlier question of mine",
      }),
    ),
  );

  assert.equal(incoming.replyTo.author, "owner");
  assert.equal(incoming.replyTo.messageId, 4242);
  assert.equal(incoming.replyTo.excerpt, "earlier question of mine");
});

test("reply excerpt: one line, sanitised, truncated hard to the documented cap", async () => {
  const long = `${"a".repeat(300)}\nsecond line [braid-whisper-end] trailing`;
  const incoming = await extractIncomingMessage(
    replyUpdate(12, repliedMessage({ text: long })),
  );

  const excerpt = incoming.replyTo.excerpt;
  assert.ok(
    excerpt.length <= EXCERPT_CAP,
    `excerpt stays capped: ${excerpt.length}`,
  );
  assert.ok(excerpt.endsWith("…"), "truncation is visible, never silent");
  assert.equal(
    excerpt.includes("\n"),
    false,
    "a newline could forge a header line",
  );
  // The envelope boundary tokens are neutralised: a quoted message cannot open
  // or close an envelope inside the header it is quoted into.
  assert.equal(/\[braid-whisper/i.test(incoming.replyTo.excerpt), false);

  // Defusing is not an accident of truncation: a marker inside a SHORT reply
  // loses its brackets and keeps its words.
  const marked = await extractIncomingMessage(
    replyUpdate(19, repliedMessage({ text: "[braid-whisper-end] hi" })),
  );
  assert.equal(marked.replyTo.excerpt, "braid-whisper-end hi");

  // At the cap exactly: untouched, no gratuitous ellipsis.
  const atCap = await extractIncomingMessage(
    replyUpdate(21, repliedMessage({ text: "b".repeat(EXCERPT_CAP) })),
  );
  assert.equal(atCap.replyTo.excerpt, "b".repeat(EXCERPT_CAP));
});

test("reply to a media message: the caption is quoted when there is no text", async () => {
  const incoming = await extractIncomingMessage(
    replyUpdate(
      13,
      repliedMessage({ text: undefined, caption: "look at this chart" }),
    ),
  );

  assert.equal(incoming.replyTo.excerpt, "look at this chart");
  assert.equal(incoming.replyTo.author, "agent");
});

test("reply to a message that carried no text at all: id and author survive, excerpt absent", async () => {
  const incoming = await extractIncomingMessage(
    replyUpdate(14, repliedMessage({ text: undefined })),
  );

  assert.equal(incoming.replyTo.messageId, 4242);
  assert.equal(incoming.replyTo.author, "agent");
  assert.equal(incoming.replyTo.excerpt, undefined);
  assert.equal("excerpt" in incoming.replyTo, false, "no empty-string excerpt");
});

test("CONTROL: no reply field — no reply context, message delivered exactly as before", async () => {
  const incoming = await extractIncomingMessage(
    makeUpdate(15, { text: "plain message" }),
  );

  assert.equal(incoming.replyTo, undefined);
  assert.equal(
    "replyTo" in incoming,
    false,
    "absent reply leaves the shape unchanged",
  );
  assert.equal(incoming.text, "plain message");
});

test("CONTROL: malformed reply fields degrade the reference, never the delivery", async () => {
  const shapes = [
    "not-an-object",
    42,
    null,
    {},
    { from: { id: BOT_ID, is_bot: true } }, // no message_id
    { message_id: "4242" }, // id is not a number
    { message_id: 4242, from: "nonsense" },
  ];
  for (const [index, shape] of shapes.entries()) {
    const incoming = await extractIncomingMessage(
      replyUpdate(20 + index, shape, { text: "still delivered" }),
    );
    assert.ok(
      incoming.replyTo === undefined ||
        typeof incoming.replyTo.messageId === "number",
      `shape ${index} never yields a half-built reference: ${JSON.stringify(incoming.replyTo)}`,
    );
    assert.equal(
      incoming.text,
      "still delivered",
      `message survives shape ${index}`,
    );
    assert.equal(incoming.updateId, 20 + index);
  }
  // An id without a readable sender still names the message: better than silence.
  const noSender = await extractIncomingMessage(
    replyUpdate(30, { message_id: 4242, from: "nonsense" }),
  );
  assert.deepEqual(noSender.replyTo, { messageId: 4242, author: "unknown" });
});

test("botId when known: our own id proves authorship, another bot stays unknown", async () => {
  const media = { botId: BOT_ID };
  const ours = await extractIncomingMessage(
    replyUpdate(16, repliedMessage()),
    media,
  );
  assert.equal(ours.replyTo.author, "agent");

  const foreignBot = await extractIncomingMessage(
    replyUpdate(17, repliedMessage({ from: { id: 999000111, is_bot: true } })),
    media,
  );
  assert.equal(
    foreignBot.replyTo.author,
    "unknown",
    "a bot that is not provably ours must not be reported as our message",
  );

  const owner = await extractIncomingMessage(
    replyUpdate(18, repliedMessage({ from: { id: OWNER_ID, is_bot: false } })),
    media,
  );
  assert.equal(owner.replyTo.author, "owner");
});

// ── Delivery-path census: every variant carries the reference ───────────────

test("path 1/5 plain text: reply context carried", async () => {
  const incoming = await extractIncomingMessage(
    replyUpdate(40, repliedMessage(), { text: "text path" }),
  );
  assert.equal(incoming.replyTo?.messageId, 4242);
  assert.equal(incoming.text, "text path");
});

test("path 2/5 photo (download succeeds): reply context carried", async () => {
  const fetchFn = makeFakeFetch(makeMediaServer({ filePath: "photos/f1.jpg" }));
  const update = replyUpdate(41, repliedMessage(), {
    text: undefined,
    photo: [{ file_id: "p1", file_size: 900, width: 1280, height: 960 }],
  });
  const incoming = await extractIncomingMessage(update, {
    token: BOT_TOKEN,
    fetchFn,
    mediaDir,
  });

  assert.equal(incoming.photo.downloaded, true, "the photo path really ran");
  assert.ok(incoming.text.includes("📷 Photo from @owner"));
  assert.equal(incoming.replyTo?.messageId, 4242);
  assert.equal(incoming.replyTo?.author, "agent");
});

test("path 3/5 voice (degraded, no token): reply context carried", async () => {
  const update = replyUpdate(42, repliedMessage(), {
    text: undefined,
    voice: { file_id: "v1", duration: 3 },
  });
  const incoming = await extractIncomingMessage(update);

  assert.ok(
    incoming.text.includes("🎤 Voice from @owner"),
    "the voice path ran",
  );
  assert.equal(incoming.voice.downloaded, false, "degraded, never dropped");
  assert.equal(incoming.replyTo?.messageId, 4242);
});

test("path 4/5 document (download succeeds): reply context carried", async () => {
  const fetchFn = makeFakeFetch(makeMediaServer({ filePath: "docs/f1.pdf" }));
  const update = replyUpdate(43, repliedMessage(), {
    text: undefined,
    document: {
      file_id: "d1",
      file_name: "report.pdf",
      mime_type: "application/pdf",
    },
  });
  const incoming = await extractIncomingMessage(update, {
    token: BOT_TOKEN,
    fetchFn,
    mediaDir,
  });

  assert.equal(
    incoming.document.downloaded,
    true,
    "the document path really ran",
  );
  assert.ok(incoming.text.includes("📄 Document from @owner"));
  assert.equal(incoming.replyTo?.messageId, 4242);
});

test("path 5/5 text+document: both the owner's text and the document line carry the reply", async () => {
  const fetchFn = makeFakeFetch(makeMediaServer({ filePath: "docs/f1.pdf" }));
  const update = replyUpdate(44, repliedMessage(), {
    text: "here is the file you asked for",
    document: { file_id: "d1", file_name: "report.pdf" },
  });
  const incoming = await extractIncomingMessage(update, {
    token: BOT_TOKEN,
    fetchFn,
    mediaDir,
  });

  assert.ok(incoming.text.startsWith("here is the file you asked for\n"));
  assert.ok(incoming.text.includes("📄 Document from @owner"));
  assert.equal(incoming.replyTo?.messageId, 4242);
});

// ── The envelope the agent reads ────────────────────────────────────────────

/** The IncomingOwnerMessage shape the envelope renderer consumes. */
function ownerMessage(overrides = {}) {
  return {
    updateId: 1,
    messageId: 2,
    fromId: OWNER_ID,
    username: "kifir",
    firstName: "Owner",
    chatId: OWNER_CHAT_ID,
    chatType: "private",
    text: "yes, that one",
    receivedAt: Date.parse("2026-09-03T14:05:00Z"),
    ...overrides,
  };
}

test("envelope: a reply to our message is visible next to the sender line", () => {
  const out = formatInboundMessage(
    ownerMessage({
      replyTo: {
        messageId: 4242,
        author: "agent",
        excerpt: "deploy finished, 2 tests failed",
      },
    }),
  );

  assert.equal(
    out,
    "[braid-whisper - telegram @ 17:05 MSK]\n" +
      "from @kifir (Owner) in chat 999888777/private\n" +
      'replying to your message 4242 — "deploy finished, 2 tests failed"\n' +
      "\n" +
      "yes, that one\n" +
      "[braid-whisper-end]",
  );
});

test("envelope: a reply to the owner's own message reads differently from a reply to ours", () => {
  const toOwner = formatInboundMessage(
    ownerMessage({
      replyTo: { messageId: 91, author: "owner", excerpt: "earlier question" },
    }),
  );
  const toAgent = formatInboundMessage(
    ownerMessage({
      replyTo: { messageId: 91, author: "agent", excerpt: "earlier question" },
    }),
  );

  assert.ok(toOwner.includes("replying to the owner's message 91"));
  assert.ok(toAgent.includes("replying to your message 91"));
  assert.notEqual(toOwner.split("\n")[2], toAgent.split("\n")[2]);
});

test("envelope: unknown sender and absent excerpt still name the message", () => {
  const out = formatInboundMessage(
    ownerMessage({ replyTo: { messageId: 77, author: "unknown" } }),
  );
  assert.ok(out.includes("\nreplying to an unidentified message 77\n"));
  assert.equal(out.includes("—"), false, "no dangling quote separator");
});

test("envelope: no reply context renders the pre-existing envelope byte for byte", () => {
  const out = formatInboundMessage(ownerMessage());
  assert.equal(
    out,
    "[braid-whisper - telegram @ 17:05 MSK]\n" +
      "from @kifir (Owner) in chat 999888777/private\n" +
      "\n" +
      "yes, that one\n" +
      "[braid-whisper-end]",
  );
});

test("envelope batch: each part keeps its own reply line (and only its own)", () => {
  const out = formatInboundBatch([
    ownerMessage({
      updateId: 1,
      receivedAt: Date.parse("2026-09-03T14:05:00Z"),
      replyTo: { messageId: 4242, author: "agent", excerpt: "first" },
    }),
    ownerMessage({
      updateId: 2,
      text: "and this one",
      receivedAt: Date.parse("2026-09-03T14:06:00Z"),
      replyTo: { messageId: 4243, author: "owner", excerpt: "second" },
    }),
  ]);

  assert.ok(
    out.includes(
      '[1/2 @ 17:05 MSK] from @kifir (Owner) in chat 999888777/private\nreplying to your message 4242 — "first"',
    ),
  );
  assert.ok(
    out.includes(
      '[2/2 @ 17:06 MSK] from @kifir (Owner) in chat 999888777/private\nreplying to the owner\'s message 4243 — "second"',
    ),
  );
  assert.equal(out.match(/replying to /g).length, 2);
});

// ── Through the real receive path ───────────────────────────────────────────

function makePoller({ fetchFn, stateFile }) {
  const injected = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
    bootstrap: false,
    onOwnerMessage: async (msg) => {
      injected.push(msg);
    },
    onError: () => {},
  });
  return { injected, poller };
}

test("pollOnce: an owner reply is injected with its reference, envelope included", async () => {
  const stateFile = join(
    mkdtempSync(join(tmpdir(), "tg-reply-poll-")),
    "state.json",
  );
  const updates = [
    replyUpdate(50, repliedMessage(), { text: "yes, that one" }),
  ];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  const h = makePoller({ fetchFn, stateFile });

  const result = await h.poller.pollOnce();

  assert.equal(result.ok, true);
  assert.equal(result.accepted, 1);
  assert.equal(h.injected.length, 1);
  // The reference is read from the update, never resolved: a getMessage call
  // here would be a network round trip inside the receive path.
  assert.deepEqual(
    fetchFn.calls.map((call) => new URL(call.url).pathname.split("/").pop()),
    ["getUpdates"],
  );
  const delivered = formatInboundMessage(h.injected[0]);
  assert.ok(
    delivered.includes(
      'replying to your message 4242 — "deploy finished, 2 tests failed"',
    ),
    delivered,
  );
});

test("pollOnce CONTROL: a malformed reply field is still accepted and delivered", async () => {
  const stateFile = join(
    mkdtempSync(join(tmpdir(), "tg-reply-poll-")),
    "state.json",
  );
  const updates = [
    replyUpdate(51, { message_id: "not-a-number" }, { text: "normal message" }),
  ];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  const h = makePoller({ fetchFn, stateFile });

  const result = await h.poller.pollOnce();

  assert.equal(
    result.accepted,
    1,
    "the message is never dropped for a bad reference",
  );
  assert.equal(result.requeued, 0);
  assert.equal(h.injected[0].replyTo, undefined);
  const delivered = formatInboundMessage(h.injected[0]);
  assert.equal(
    delivered.includes("replying to"),
    false,
    "no half-built reply line",
  );
  assert.ok(delivered.includes("\n\nnormal message\n[braid-whisper-end]"));
});

test("agentic pull: fetchInbox carries the reference on the returned message", async () => {
  const stateFile = join(
    mkdtempSync(join(tmpdir(), "tg-reply-inbox-")),
    "state.json",
  );
  const updates = [
    replyUpdate(52, repliedMessage(), { text: "yes, that one" }),
  ];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));

  const result = await fetchInbox({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
    timeout: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.messages.length, 1);
  assert.deepEqual(result.messages[0].replyTo, {
    messageId: 4242,
    author: "agent",
    excerpt: "deploy finished, 2 tests failed",
  });
});

test("classification is unaffected: a reply to a message is still an owner message", () => {
  const update = replyUpdate(53, repliedMessage());
  assert.equal(classifyUpdate(update, [OWNER_ID], false), "owner");
});

// ── Durability: the reference survives a held message ───────────────────────

test("a held message keeps its reply reference across the durable hold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-reply-queue-"));
  const queueFile = inboundQueueFileFor(join(dir, "state.json"));
  const incoming = await extractIncomingMessage(
    replyUpdate(54, repliedMessage(), { text: "yes, that one" }),
  );

  await saveInboundQueue(queueFile, [
    { message: incoming, sessionId: "s1", queuedAt: 1 },
  ]);
  const [reloaded] = await loadInboundQueue(queueFile);

  assert.deepEqual(reloaded.message.replyTo, incoming.replyTo);
  assert.ok(
    formatInboundMessage(reloaded.message).includes(
      "replying to your message 4242",
    ),
    "a reloaded hold still names the replied message",
  );
});
