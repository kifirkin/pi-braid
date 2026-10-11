/**
 * inbound-queue.test.mjs — the durable busy-hold store.
 *
 * The hold must survive a process/session boundary, so it is a file. These
 * tests pin the store's contract: a round-trip preserves the accepted message
 * AND the session it was accepted for, a missing or hand-edited file reads as
 * "nothing held" instead of throwing into a lifecycle handler, a read failure
 * other than ENOENT or a file from another version is reported through the
 * caller-supplied reporter, and the write is atomic (a truncated queue would
 * read back as an empty hold — losing exactly the messages the file exists to
 * protect).
 *
 * Run: npm test -w packages/telegram  (from the repo root)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  inboundQueueFileFor,
  loadInboundQueue,
  saveInboundQueue,
} from "../dist/lib/inbound-queue.js";

function entry(updateId, sessionId, text = `msg ${updateId}`) {
  return {
    message: {
      updateId,
      messageId: updateId + 1000,
      fromId: 111222333,
      chatId: 999888777,
      chatType: "private",
      text,
      receivedAt: 1700000000 + updateId,
    },
    sessionId,
    queuedAt: 1700000000000 + updateId,
  };
}

async function tmpQueueFile() {
  const dir = await mkdtemp(join(tmpdir(), "tg-inbound-queue-"));
  return join(dir, "telegram-inbound-queue.json");
}

test("queue file carries the state file's stem, beside it", () => {
  assert.equal(
    inboundQueueFileFor("/tmp/x/.braid/telegram-state.json"),
    "/tmp/x/.braid/telegram-state-inbound-queue.json",
  );
  // Two state files in one directory must not share one hold.
  assert.notEqual(
    inboundQueueFileFor("/tmp/x/.braid/bot-a.json"),
    inboundQueueFileFor("/tmp/x/.braid/bot-b.json"),
  );
});

test("round-trip preserves the message and the accepting session", async () => {
  const file = await tmpQueueFile();
  await saveInboundQueue(file, [entry(1, "session-a"), entry(2, "session-b")]);

  const loaded = await loadInboundQueue(file);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].message.updateId, 1);
  assert.equal(loaded[0].message.text, "msg 1");
  assert.equal(loaded[0].sessionId, "session-a");
  assert.equal(loaded[0].queuedAt, 1700000000001);
  assert.equal(loaded[1].sessionId, "session-b");
});

test("an unknown-session entry round-trips as unknown", async () => {
  const file = await tmpQueueFile();
  await saveInboundQueue(file, [entry(3, undefined)]);
  const loaded = await loadInboundQueue(file);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].sessionId, undefined);
});

test("absent, empty and corrupt files read as nothing held (never throw)", async () => {
  const missing = await tmpQueueFile();
  assert.deepEqual(await loadInboundQueue(missing), []);

  const empty = await tmpQueueFile();
  await writeFile(empty, "", "utf8");
  assert.deepEqual(await loadInboundQueue(empty), []);

  const truncated = await tmpQueueFile();
  await writeFile(truncated, '{"version":1,"entries":[{"message":', "utf8");
  assert.deepEqual(await loadInboundQueue(truncated), []);

  const garbage = await tmpQueueFile();
  await writeFile(garbage, JSON.stringify({ version: 1, entries: "nope" }));
  assert.deepEqual(await loadInboundQueue(garbage), []);
});

test("absent files read as nothing held without a report (ENOENT is silent)", async () => {
  const missing = await tmpQueueFile();
  const reported = [];
  assert.deepEqual(
    await loadInboundQueue(missing, (message) => reported.push(message)),
    [],
  );
  assert.deepEqual(reported, [], "a missing file is not a read failure");
});

test("a non-ENOENT read error reads as nothing held and is reported", async () => {
  const file = await tmpQueueFile();
  await mkdir(file, { recursive: true }); // readFile(directory) → EISDIR
  const reported = [];
  assert.deepEqual(
    await loadInboundQueue(file, (message) => reported.push(message)),
    [],
  );
  assert.equal(reported.length, 1, "the swallowed read error is reported");
  assert.match(reported[0], /EISDIR|illegal operation on a directory/);
});

test("a file from another version reads as nothing held and is reported", async () => {
  const file = await tmpQueueFile();
  await writeFile(
    file,
    JSON.stringify({ version: 99, entries: [entry(11, "session-a")] }),
    "utf8",
  );
  const reported = [];
  assert.deepEqual(
    await loadInboundQueue(file, (message) => reported.push(message)),
    [],
  );
  assert.equal(reported.length, 1, "the version mismatch is reported");
  assert.match(reported[0], /version 99/);
});

test("concurrent saves all complete and the last rename wins", async () => {
  const file = await tmpQueueFile();
  const snapshots = [1, 2, 3, 4, 5, 6].map((updateId) => [
    entry(updateId, "session-a"),
  ]);
  const results = await Promise.allSettled(
    snapshots.map((entries) => saveInboundQueue(file, entries)),
  );
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(rejected.length, 0, "a shared temp file must not reject a save");
  const loaded = await loadInboundQueue(file);
  const updateIds = snapshots.map(([e]) => e.message.updateId);
  assert.equal(
    loaded.length,
    1,
    "the surviving snapshot is whole, never a mixture",
  );
  assert.ok(
    updateIds.includes(loaded[0].message.updateId),
    "the file is one of the written snapshots",
  );
  const leftovers = (await readdir(dirname(file))).filter((name) =>
    name.endsWith(".tmp"),
  );
  assert.deepEqual(leftovers, [], "every temp file is renamed, none is left");
});

test("entries that do not carry an accepted message are filtered out", async () => {
  const file = await tmpQueueFile();
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      entries: [
        entry(7, "session-a"),
        { message: { updateId: 8 }, sessionId: "session-a", queuedAt: 1 },
        { sessionId: "session-a", queuedAt: 1 },
        { message: entry(9, "session-a").message, sessionId: 5, queuedAt: 1 },
      ],
    }),
    "utf8",
  );
  const loaded = await loadInboundQueue(file);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].message.updateId, 7);
});

test("saving an empty hold clears the file without leaving a temp behind", async () => {
  const file = await tmpQueueFile();
  await saveInboundQueue(file, [entry(1, "session-a")]);
  await saveInboundQueue(file, []);

  assert.deepEqual(await loadInboundQueue(file), []);
  const leftovers = (await readdir(dirname(file))).filter((name) =>
    name.endsWith(".tmp"),
  );
  assert.deepEqual(
    leftovers,
    [],
    "the temp file is renamed, never left behind",
  );
  assert.equal(existsSync(file), true);
  assert.match(await readFile(file, "utf8"), /"entries": \[\]/);
});
