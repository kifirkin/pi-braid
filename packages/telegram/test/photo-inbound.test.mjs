/**
 * photo-inbound.test.mjs — inbound photo (image) support: classifyUpdate
 * accepts photo messages, the shared extraction downloads the largest variant
 * via getFile + the /file/bot<token>/<file_path> route, saves it under the
 * media dir, and delivers the absolute path (caption carried). Download
 * failures degrade to file_id + error note — never dropped. Text-only
 * behavior is regression-pinned. NO network, no real timers.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyUpdate,
  createInboundPoller,
  extractIncomingMessage,
} from "../dist/lib/inbound-poller.js";
import { fetchInbox } from "../dist/lib/telegram-inbox.js";
import { pickPhotoVariant } from "../dist/lib/photo.js";

import {
  BOT_TOKEN,
  OWNER_ID,
  FOREIGN_ID,
  jsonResponse,
  makeFakeFetch,
  makeUpdate,
  makeUpdatesServer,
  getUpdatesResult,
} from "./fixtures.mjs";

let stateFile;
let mediaDir;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "tg-photo-"));
  stateFile = join(dir, "state.json");
  mediaDir = join(dir, "media");
});

/** Photo update with two variants; largest is `large_photo_id` (file_size). */
function makePhotoUpdate(updateId, messageOverrides = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1000,
      from: {
        id: OWNER_ID,
        is_bot: false,
        first_name: "Owner",
        username: "owner",
      },
      chat: { id: 999888777, type: "private", username: "owner" },
      date: 1700000000,
      photo: [
        {
          file_id: "small_photo_id",
          file_unique_id: "su",
          width: 320,
          height: 240,
          file_size: 500,
        },
        {
          file_id: "large_photo_id",
          file_unique_id: "lu",
          width: 1280,
          height: 960,
          file_size: 5000,
        },
      ],
      ...messageOverrides,
    },
  };
}

/** Fake getUpdates+getFile+download server for one photo update. */
function makePhotoServer({
  updates,
  getFileResult,
  downloadBytes,
  downloadStatus = 200,
}) {
  return async (url) => {
    if (url.includes("getUpdates"))
      return jsonResponse(getUpdatesResult(updates));
    if (url.includes("getFile")) return jsonResponse(getFileResult);
    if (url.includes("/file/bot")) {
      if (downloadStatus !== 200)
        return jsonResponse(
          { ok: false, description: "Not Found" },
          downloadStatus,
        );
      return new Response(downloadBytes, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

function makePoller({
  fetchFn,
  allowedUsers = [],
  mediaDir: dir = mediaDir,
} = {}) {
  const injected = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers,
    stateFile,
    fetchFn,
    mediaDir: dir,
    bootstrap: false,
    onOwnerMessage: async (msg) => {
      injected.push(msg);
    },
    onError: () => {},
  });
  return { injected, poller };
}

// ── classifyUpdate: photo acceptance ───────────────────────────────────────

test("classifyUpdate: photo messages classify by sender like text (owner/foreign), blank text still non_text", () => {
  const photo = makePhotoUpdate(1);
  assert.equal(classifyUpdate(photo, [OWNER_ID], false), "owner");

  const withCaption = makePhotoUpdate(2, { caption: "check this" });
  assert.equal(classifyUpdate(withCaption, [OWNER_ID], false), "owner");

  const foreignPhoto = makePhotoUpdate(3, {
    from: { id: FOREIGN_ID, is_bot: false },
  });
  assert.equal(classifyUpdate(foreignPhoto, [OWNER_ID], false), "foreign");

  // Regression: no text AND no photo is still non_text.
  const blank = makeUpdate(4, { text: "   " });
  assert.equal(classifyUpdate(blank, [OWNER_ID], false), "non_text");
});

// ── pickPhotoVariant ────────────────────────────────────────────────────────

test("pickPhotoVariant: largest by file_size, else last element, undefined when empty", () => {
  assert.equal(
    pickPhotoVariant([
      { file_id: "a", file_size: 10 },
      { file_id: "b", file_size: 50 },
    ]).file_id,
    "b",
  );
  // No file_size present -> last element (Telegram orders ascending by size).
  assert.equal(
    pickPhotoVariant([{ file_id: "a" }, { file_id: "b" }]).file_id,
    "b",
  );
  // Variants without a file_id are not usable.
  assert.equal(pickPhotoVariant([{ width: 1 }, { width: 2 }]), undefined);
  assert.equal(pickPhotoVariant([]), undefined);
});

// ── Poller path: download + save + deliver ──────────────────────────────────

test("pollOnce: owner photo is downloaded, saved to the media dir, and delivered with the abs path", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const updates = [makePhotoUpdate(1)];
  const fetchFn = makeFakeFetch(
    makePhotoServer({
      updates,
      getFileResult: {
        ok: true,
        result: {
          file_id: "large_photo_id",
          file_unique_id: "lu",
          file_size: 5000,
          file_path: "photos/file_1.jpg",
        },
      },
      downloadBytes: bytes,
    }),
  );
  const h = makePoller({ fetchFn, allowedUsers: [OWNER_ID] });

  const r = await h.poller.pollOnce();

  assert.equal(r.ok, true);
  assert.equal(r.accepted, 1);
  assert.equal(r.rejected, 0);
  assert.equal(h.injected.length, 1);

  // getFile was called with the LARGEST variant's file_id.
  const getFileCall = fetchFn.calls.find((c) => c.url.includes("getFile"));
  assert.ok(getFileCall, "getFile called");
  assert.ok(
    getFileCall.url.includes("file_id=large_photo_id"),
    "largest variant requested",
  );

  const msg = h.injected[0];
  assert.equal(msg.photo.downloaded, true);
  assert.equal(msg.photo.fileId, "large_photo_id");
  assert.equal(msg.photo.filePath, join(mediaDir, "1.jpg"));
  assert.ok(existsSync(msg.photo.filePath), "file saved on disk");
  assert.deepEqual(new Uint8Array(readFileSync(msg.photo.filePath)), bytes);

  // Delivered text carries the absolute path the agent can describe_image/read.
  assert.ok(msg.text.includes("📷 Photo from @owner"));
  assert.ok(msg.text.includes(join(mediaDir, "1.jpg")));
  assert.ok(msg.text.includes("(caption: none)"));
});

test("pollOnce: photo caption is carried in the delivered message and photo metadata", async () => {
  const updates = [makePhotoUpdate(1, { caption: "look at this" })];
  const fetchFn = makeFakeFetch(
    makePhotoServer({
      updates,
      getFileResult: {
        ok: true,
        result: { file_id: "large_photo_id", file_path: "photos/file_1.jpg" },
      },
      downloadBytes: new Uint8Array([1, 2, 3]),
    }),
  );
  const h = makePoller({ fetchFn, allowedUsers: [OWNER_ID] });

  const r = await h.poller.pollOnce();
  assert.equal(r.accepted, 1);
  const msg = h.injected[0];
  assert.equal(msg.photo.caption, "look at this");
  assert.ok(msg.text.includes("(caption: look at this)"));
});

test("pollOnce: download failure degrades to file_id + error note — message is NOT dropped", async () => {
  const updates = [makePhotoUpdate(1)];
  const fetchFn = makeFakeFetch(
    makePhotoServer({
      updates,
      getFileResult: {
        ok: true,
        result: { file_id: "large_photo_id", file_path: "photos/file_1.jpg" },
      },
      downloadBytes: null,
      downloadStatus: 404,
    }),
  );
  const h = makePoller({ fetchFn, allowedUsers: [OWNER_ID] });

  const r = await h.poller.pollOnce();
  assert.equal(r.accepted, 1, "degraded photo is still accepted and delivered");
  assert.equal(h.injected.length, 1);
  const msg = h.injected[0];
  assert.equal(msg.photo.downloaded, false);
  assert.equal(msg.photo.fileId, "large_photo_id");
  assert.ok(msg.photo.error, "error note present");
  assert.ok(msg.text.includes("file_id large_photo_id"));
  assert.ok(msg.text.includes("download failed"));
});

test("pollOnce: getFile failure degrades to file_id + error note (never dropped)", async () => {
  const updates = [makePhotoUpdate(1)];
  const fetchFn = makeFakeFetch(
    makePhotoServer({
      updates,
      getFileResult: { ok: false, description: "Bad Request: file not found" },
      downloadBytes: null,
    }),
  );
  const h = makePoller({ fetchFn, allowedUsers: [OWNER_ID] });

  const r = await h.poller.pollOnce();
  assert.equal(r.accepted, 1);
  const msg = h.injected[0];
  assert.equal(msg.photo.downloaded, false);
  assert.equal(msg.photo.fileId, "large_photo_id");
  assert.ok(msg.photo.error);
  assert.ok(msg.text.includes("file_id large_photo_id"));
});

// ── Regression: text-only behavior unchanged ────────────────────────────────

test("pollOnce: text-only messages still work and write NO media files", async () => {
  const updates = [makeUpdate(1), makeUpdate(2)];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  const h = makePoller({ fetchFn, allowedUsers: [OWNER_ID] });

  const r = await h.poller.pollOnce();
  assert.equal(r.accepted, 2);
  assert.equal(h.injected[0].text, "hello from owner");
  assert.equal(h.injected[1].text, "hello from owner");
  assert.equal(h.injected[0].photo, undefined, "no photo metadata for text");
  assert.equal(
    existsSync(mediaDir),
    false,
    "no media dir created for text-only messages",
  );
});

// ── Shared extraction: the agentic inbox path ───────────────────────────────

test("fetchInbox: owner photo is downloaded and delivered with the abs path (fromOwner true)", async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const updates = [makePhotoUpdate(1)];
  const fetchFn = makeFakeFetch(
    makePhotoServer({
      updates,
      getFileResult: {
        ok: true,
        result: { file_id: "large_photo_id", file_path: "photos/file_1.jpg" },
      },
      downloadBytes: bytes,
    }),
  );

  const res = await fetchInbox({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
    mediaDir,
  });

  assert.equal(res.ok, true);
  assert.equal(res.messages.length, 1);
  const msg = res.messages[0];
  assert.equal(msg.fromOwner, true);
  assert.equal(msg.photo.downloaded, true);
  assert.equal(msg.photo.filePath, join(mediaDir, "1.jpg"));
  assert.ok(existsSync(msg.photo.filePath));
  assert.ok(msg.text.includes(join(mediaDir, "1.jpg")));
});

// ── Direct extraction: no token degrades without any download attempt ───────

test("extractIncomingMessage: without a token the photo degrades (no download, no throw)", async () => {
  const msg = await extractIncomingMessage(makePhotoUpdate(1), {});
  assert.equal(msg.photo.downloaded, false);
  assert.equal(msg.photo.fileId, "large_photo_id");
  assert.ok(msg.photo.error);
  assert.ok(msg.text.includes("file_id large_photo_id"));
  assert.ok(msg.text.includes("download failed"));
});
