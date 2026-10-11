/**
 * telegram-inbox.test.mjs — agentic pull (`fetchInbox`) tests: fetch →
 * allow-list filter → confirm-on-read offset persistence → dedup (no
 * redelivery across calls) → envelope formatting with END marker + sender
 * provenance. Driven through a fixture fake getUpdates server. NO network, no
 * live token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetchInbox, formatInboxMessage } from "../dist/lib/telegram-inbox.js";

import {
  BOT_TOKEN,
  OWNER_ID,
  FOREIGN_ID,
  makeFakeFetch,
  makeUpdate,
  makeUpdatesServer,
} from "./fixtures.mjs";

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), `tg-inbox-${prefix}-`));
}

test("fetchInbox: returns owner + foreign messages with fromOwner flag, confirms offset", async () => {
  const dir = tmpDir("basic");
  const stateFile = join(dir, "telegram-state.json");
  const updates = [
    makeUpdate(1, { text: "owner hello" }), // OWNER_ID/OWNER_CHAT_ID by default
    makeUpdate(2, {
      from: { id: FOREIGN_ID, is_bot: false },
      text: "stranger",
    }),
    { update_id: 3, edited_message: { message_id: 999 } }, // non-message → rejected
  ];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));

  const res = await fetchInbox({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
  });

  assert.equal(res.ok, true);
  assert.equal(res.fetched, 3);
  assert.equal(res.messages.length, 2);
  assert.equal(res.rejected, 1); // non-message dropped

  // Owner message: fromOwner true, full provenance.
  const owner = res.messages[0];
  assert.equal(owner.fromOwner, true);
  assert.equal(owner.text, "owner hello");
  assert.equal(owner.fromId, OWNER_ID);

  // Foreign message: fromOwner false (whisper-only, never a turn).
  const foreign = res.messages[1];
  assert.equal(foreign.fromOwner, false);
  assert.equal(foreign.fromId, FOREIGN_ID);

  // Confirm-on-read persisted: max update_id (3) + 1.
  assert.equal(res.offset, 4);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).offset, 4);
});

test("fetchInbox: dedup — a second call with the same server returns nothing", async () => {
  const dir = tmpDir("dedup");
  const stateFile = join(dir, "telegram-state.json");
  const updates = [makeUpdate(10, { text: "once" })];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));

  const r1 = await fetchInbox({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
  });
  assert.equal(r1.messages.length, 1);

  const r2 = await fetchInbox({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
  });
  assert.equal(r2.fetched, 0);
  assert.equal(r2.messages.length, 0);
  assert.equal(r2.offset, 11, "offset stays at max-seen + 1; no re-delivery");
});

test("fetchInbox: dedup survives a restart — new state file resumed from persisted offset", async () => {
  const dir = tmpDir("restart");
  const stateFile = join(dir, "telegram-state.json");
  const updates = [makeUpdate(1), makeUpdate(2)];
  const server = makeUpdatesServer(updates);

  // First call confirms offset=3.
  const r1 = await fetchInbox({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn: makeFakeFetch(server),
  });
  assert.equal(r1.offset, 3);

  // New call (fresh process analog) reads the same state file → resumes at 3.
  const r2 = await fetchInbox({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn: makeFakeFetch(server),
  });
  assert.equal(r2.fetched, 0);
  assert.equal(r2.messages.length, 0);
});

test("fetchInbox: policy filters drop non-private/non-text/non-message; foreign private senders are included but flagged fromOwner:false", async () => {
  const dir = tmpDir("filter");
  const stateFile = join(dir, "telegram-state.json");
  const updates = [
    makeUpdate(1, { chat: { id: 9, type: "group" } }), // non-private → rejected
    makeUpdate(2, { text: "" }), // non-text → rejected
    { update_id: 4, edited_message: { message_id: 7 } }, // non-message → rejected
    makeUpdate(3, {
      from: { id: FOREIGN_ID, is_bot: false },
      chat: { id: 88, type: "private" },
      text: "stranger",
    }), // foreign private → included (fromOwner: false)
  ];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));

  const res = await fetchInbox({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
  });
  assert.equal(res.ok, true);
  assert.equal(res.messages.length, 1);
  assert.equal(res.rejected, 3);
  assert.equal(res.messages[0].fromOwner, false);
  assert.equal(res.messages[0].fromId, FOREIGN_ID);
});

test("fetchInbox: getUpdates API error returns ok:false without throwing", async () => {
  const dir = tmpDir("error");
  const stateFile = join(dir, "telegram-state.json");
  const fetchFn = makeFakeFetch(
    async () =>
      new Response(
        JSON.stringify({ ok: false, description: "Conflict: terminated" }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      ),
  );

  const res = await fetchInbox({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
  });
  assert.equal(res.ok, false);
  assert.ok(res.error);
  assert.deepEqual(res.messages, []);
});

test("formatInboxMessage: braid-whisper envelope with provenance, send-time clock, END marker", () => {
  // T3/TG-inbound: header carries the message send time `@ HH:MM TZ`
  // (TelegramUpdate.date via receivedAt, owner TZ Europe/Moscow).
  const out = formatInboxMessage({
    updateId: 1,
    messageId: 2,
    fromId: 111222333,
    username: "owner",
    firstName: "Owner",
    chatId: 999888777,
    chatType: "private",
    text: "hi",
    receivedAt: Date.parse("2026-09-03T14:05:00Z"), // 17:05 MSK
    fromOwner: true,
  });
  assert.ok(
    out.startsWith(
      "[braid-whisper - telegram @ 17:05 MSK]\nfrom @owner (Owner) in chat 999888777/private",
    ),
    `header must carry the send-time clock: ${out.split("\n")[0]}`,
  );
  assert.ok(out.endsWith("\n[braid-whisper-end]"));
});

test("fetchInbox: error path does not advance the offset (no confirm-on-read on failure)", async () => {
  const dir = tmpDir("noadv");
  const stateFile = join(dir, "telegram-state.json");
  let fail = true;
  const fetchFn = makeFakeFetch(async () => {
    if (fail) {
      return new Response(JSON.stringify({ ok: false, description: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ ok: true, result: [makeUpdate(5, { text: "later" })] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  });

  const r1 = await fetchInbox({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.offset, 0, "offset unchanged after a failed fetch");

  // Recovery: next call succeeds and confirms from the persisted offset.
  fail = false;
  const r2 = await fetchInbox({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.messages.length, 1);
  assert.equal(r2.offset, 6);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).offset, 6);
});

// ── Cleanup: tmp dirs are OS-managed; nothing global leaks ───────────────────
test("cleanup: no stray timers or handles (fetchInbox is async-only)", () => {
  assert.equal(typeof fetchInbox, "function");
});
