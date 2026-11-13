/**
 * outbound-tracked-chat.test.mjs — the "⚙️ Working…" message is keyed by CHAT.
 *
 * The owner got two identical acks for one conversation. The tracker kept its
 * "is a message already pinned?" answer in per-process memory, so two seats on
 * one chat each sent their own. This fixture pins the chat-keyed contract:
 *
 *   - two seats on one chat produce ONE message id (the second reuses it);
 *   - the shared record's refcount decides when the message resolves, so the
 *     seat that finishes first does not delete a message the other still works
 *     behind;
 *   - the visible line carries a count when more than one seat shares it, and a
 *     repeated begin() from the same seat edits nothing;
 *   - a message tracked for another chat is never adopted by this chat;
 *   - a holder that stops touching the record is reaped instead of pinning the
 *     owner's chat forever.
 *
 * No network: the client is a stub, the clock is injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLiveUpdateTracker,
  trackedStartText,
  TRACKED_START_TEXT,
  TRACKED_DONE_TEXT,
} from "../dist/lib/notify/live-update.js";
import { BOT_TOKEN, OWNER_CHAT_ID } from "./fixtures.mjs";

function tmpStateFile(label) {
  const dir = mkdtempSync(join(tmpdir(), `tg-chat-${label}-`));
  return { dir, stateFile: join(dir, "telegram-live-update.json") };
}

function makeStub() {
  const sends = [];
  const edits = [];
  let seq = 1000;
  const client = {
    sendMessage: async (token, chatId, text, options = {}) => {
      sends.push({ token, chatId, text, options });
      return { ok: true, messageId: ++seq };
    },
    editMessageText: async (token, chatId, messageId, text, options = {}) => {
      edits.push({ token, chatId, messageId, text, options });
      return { ok: true, messageId };
    },
  };
  return { sends, edits, client };
}

const seat = (stub, stateFile, extra = {}) =>
  createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
    ...extra,
  });

test("two seats on one chat pin ONE message and the last one resolves it", async () => {
  const { dir, stateFile } = tmpStateFile("two-seats");
  const stubA = makeStub();
  const stubB = makeStub();
  const a = seat(stubA, stateFile, { holderId: "seat-a" });
  const b = seat(stubB, stateFile, { holderId: "seat-b" });

  const firstAck = await a.begin();
  assert.equal(firstAck.started, true);
  assert.equal(firstAck.messageId, 1001);
  assert.equal(stubA.sends.length, 1, "the first seat pins the message");

  const secondAck = await b.begin();
  assert.equal(secondAck.started, true);
  assert.equal(
    secondAck.reused,
    true,
    "the second seat reuses the chat's message",
  );
  assert.equal(secondAck.messageId, 1001);
  assert.equal(stubB.sends.length, 0, "NO second ack message");
  assert.equal(stubB.edits.length, 1, "the shared line is re-pinned once");
  assert.equal(
    stubB.edits[0].text,
    trackedStartText(2),
    "one message, carrying the count of seats behind it",
  );

  // The seat that finishes first must NOT resolve the message.
  const bDone = await b.end("done", { resultText: "seat b report" });
  assert.equal(bDone.ended, false, "another seat is still working");
  assert.equal(stubB.edits.length, 1, "no done-edit while work is in flight");
  assert.equal(stubB.sends.length, 0, "no summary from the early finisher");
  const stillTracked = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(stillTracked.messageId, 1001, "the message is still tracked");
  assert.deepEqual(Object.keys(stillTracked.holders), ["seat-a"]);

  // The last seat resolves it: done-edit + summary, then the record clears.
  const aDone = await a.end("done", { resultText: "seat a report" });
  assert.equal(aDone.ended, true);
  assert.equal(aDone.doneEdited, true);
  assert.equal(aDone.summarySent, true);
  assert.equal(stubA.edits.at(-1).text, TRACKED_DONE_TEXT);
  assert.equal(stubA.sends.length, 2, "pin + summary");
  assert.deepEqual(
    JSON.parse(readFileSync(stateFile, "utf8")),
    { messageId: 0, chatId: 0, startedAt: 0 },
    "the record is cleared once the chat has no work left",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("a repeated begin() from the same seat edits nothing", async () => {
  const { dir, stateFile } = tmpStateFile("repeat-begin");
  const stub = makeStub();
  const a = seat(stub, stateFile, { holderId: "seat-a" });

  await a.begin();
  await a.begin();
  await a.begin();
  assert.equal(stub.sends.length, 1, "one ack message for the chat");
  assert.equal(stub.edits.length, 0, "the line never changes → no edits");
  const record = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(record.holders["seat-a"].count, 3, "the units are counted");
  rmSync(dir, { recursive: true, force: true });
});

test("a tracked message for another chat is never adopted", async () => {
  const { dir, stateFile } = tmpStateFile("foreign-chat");
  const stubA = makeStub();
  const stubB = makeStub();
  const a = seat(stubA, stateFile, { holderId: "seat-a" });
  const other = createLiveUpdateTracker({
    client: stubB.client,
    token: BOT_TOKEN,
    chatId: 777001,
    stateFile,
    holderId: "seat-other",
  });

  await a.begin(); // chat OWNER_CHAT_ID, message 1001
  const out = await other.start();
  assert.equal(out.reused, false, "another chat's message is not reused");
  assert.equal(stubB.sends.length, 1, "the other chat gets its own message");
  assert.equal(stubB.edits.length, 0, "the first chat's message is untouched");
  assert.equal(stubA.edits.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("a holder that stops touching the record is reaped (no permanent Working…)", async () => {
  const { dir, stateFile } = tmpStateFile("stale");
  const stubA = makeStub();
  const stubB = makeStub();
  let clock = 1_700_000_000_000;
  const shared = {
    holderId: "seat-a",
    now: () => clock,
    holderStaleMs: 60_000,
  };
  const a = seat(stubA, stateFile, shared);
  const b = seat(stubB, stateFile, { ...shared, holderId: "seat-b" });

  await a.begin();
  await b.begin();
  // Seat B dies mid-turn: its holder stops being touched.
  clock += 61_000;
  const out = await a.end("done", { resultText: "the answer" });
  assert.equal(out.ended, true, "the stale holder no longer blocks resolution");
  assert.equal(out.doneEdited, true);
  rmSync(dir, { recursive: true, force: true });
});

test("the start line never exceeds the plain cap, with or without a count", async () => {
  assert.equal(trackedStartText(1), TRACKED_START_TEXT);
  assert.ok(trackedStartText(2).length <= 280);
  assert.match(trackedStartText(12), /12 tasks$/);
});
