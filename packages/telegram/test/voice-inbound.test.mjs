/**
 * voice-inbound.test.mjs — inbound voice (voice note) support: classifyUpdate
 * accepts voice messages, the shared extraction downloads the note via getFile
 * + the /file/bot<token>/<file_path> route, saves it under the media dir, and
 * — when an OpenAI-compatible STT endpoint is configured — transcribes it via
 * /v1/audio/transcriptions, delivering the transcript with the saved path.
 * Without STT the note still arrives (path + "unavailable" note); download and
 * STT failures degrade — never dropped. Text-only behavior is regression-pinned.
 * NO network, no real timers.
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
  const dir = mkdtempSync(join(tmpdir(), "tg-voice-"));
  stateFile = join(dir, "state.json");
  mediaDir = join(dir, "media");
});

/** Voice update (single Voice object, NOT an array — unlike photo). */
function makeVoiceUpdate(updateId, messageOverrides = {}) {
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
      voice: {
        file_id: "voice_file_id",
        file_unique_id: "vu",
        duration: 3,
        mime_type: "audio/ogg",
        file_size: 1200,
      },
      ...messageOverrides,
    },
  };
}

/** Fake getUpdates+getFile+download+STT server for one voice update. */
function makeVoiceServer({
  updates,
  getFileResult,
  downloadBytes,
  downloadStatus = 200,
  sttResult = { text: "hello" },
  sttStatus = 200,
}) {
  const sttCalls = [];
  const handler = async (url, init = {}) => {
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
        headers: { "content-type": "audio/ogg" },
      });
    }
    if (url.includes("/audio/transcriptions")) {
      sttCalls.push(init);
      if (sttStatus !== 200)
        return jsonResponse({ error: "invalid api key" }, sttStatus);
      return jsonResponse(sttResult);
    }
    throw new Error(`unexpected url: ${url}`);
  };
  handler.sttCalls = sttCalls;
  return handler;
}

function makePoller({
  fetchFn,
  allowedUsers = [],
  mediaDir: dir = mediaDir,
  stt,
} = {}) {
  const injected = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers,
    stateFile,
    fetchFn,
    mediaDir: dir,
    stt,
    bootstrap: false,
    onOwnerMessage: async (msg) => {
      injected.push(msg);
    },
    onError: () => {},
  });
  return { injected, poller };
}

// ── classifyUpdate: voice acceptance ────────────────────────────────────────

test("classifyUpdate: voice messages classify by sender like text (owner/foreign), sticker still non_text", () => {
  const voice = makeVoiceUpdate(1);
  assert.equal(classifyUpdate(voice, [OWNER_ID], false), "owner");

  const withCaption = makeVoiceUpdate(2, { caption: "listen" });
  assert.equal(classifyUpdate(withCaption, [OWNER_ID], false), "owner");

  const foreignVoice = makeVoiceUpdate(3, {
    from: { id: FOREIGN_ID, is_bot: false },
  });
  assert.equal(classifyUpdate(foreignVoice, [OWNER_ID], false), "foreign");

  // Regression: no text, no photo, no voice (e.g. a sticker) is still non_text.
  const sticker = makeUpdate(4, {
    text: undefined,
    sticker: { file_id: "sticker_id" },
  });
  assert.equal(classifyUpdate(sticker, [OWNER_ID], false), "non_text");

  // Regression: blank text is still non_text.
  const blank = makeUpdate(5, { text: "   " });
  assert.equal(classifyUpdate(blank, [OWNER_ID], false), "non_text");
});

// ── Poller path: download + save + transcribe + deliver ─────────────────────

test("pollOnce: owner voice is downloaded, saved, transcribed, and delivered with the transcript + abs path", async () => {
  const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  const updates = [makeVoiceUpdate(1)];
  const server = makeVoiceServer({
    updates,
    getFileResult: {
      ok: true,
      result: {
        file_id: "voice_file_id",
        file_unique_id: "vu",
        file_size: 1200,
        file_path: "voice/file_1.ogg",
      },
    },
    downloadBytes: bytes,
  });
  const fetchFn = makeFakeFetch(server);
  const h = makePoller({
    fetchFn,
    allowedUsers: [OWNER_ID],
    stt: { apiKey: "sk-test", model: "whisper-1" },
  });

  const r = await h.poller.pollOnce();

  assert.equal(r.ok, true);
  assert.equal(r.accepted, 1);
  assert.equal(h.injected.length, 1);

  // getFile was called with the voice note's file_id.
  const getFileCall = fetchFn.calls.find((c) => c.url.includes("getFile"));
  assert.ok(getFileCall, "getFile called");
  assert.ok(
    getFileCall.url.includes("file_id=voice_file_id"),
    "voice file_id requested",
  );

  // The STT endpoint was called with the file + model in the multipart body.
  assert.equal(server.sttCalls.length, 1, "STT endpoint called once");
  const sttInit = server.sttCalls[0];
  assert.equal(sttInit.method, "POST");
  assert.equal(sttInit.headers.Authorization, "Bearer sk-test");
  const body = sttInit.body;
  assert.ok(body instanceof FormData, "multipart form body");
  assert.equal(body.get("model"), "whisper-1");
  const filePart = body.get("file");
  assert.ok(filePart instanceof File, "file part present");
  assert.equal(filePart.name, "voice.ogg");

  const msg = h.injected[0];
  assert.equal(msg.voice.downloaded, true);
  assert.equal(msg.voice.fileId, "voice_file_id");
  assert.equal(msg.voice.filePath, join(mediaDir, "1.ogg"));
  assert.equal(msg.voice.transcript, "hello");
  assert.ok(existsSync(msg.voice.filePath), "file saved on disk");
  assert.deepEqual(new Uint8Array(readFileSync(msg.voice.filePath)), bytes);

  // Delivered text carries the transcript + the absolute path.
  assert.ok(msg.text.includes("🎤 Voice from @owner"));
  assert.ok(msg.text.includes(join(mediaDir, "1.ogg")));
  assert.ok(msg.text.includes('(transcript: "hello")'));
  assert.ok(msg.text.includes("(caption: none)"));
});

test("pollOnce: voice caption is carried in the delivered message and voice metadata", async () => {
  const updates = [makeVoiceUpdate(1, { caption: "listen to this" })];
  const fetchFn = makeFakeFetch(
    makeVoiceServer({
      updates,
      getFileResult: {
        ok: true,
        result: { file_id: "voice_file_id", file_path: "voice/file_1.ogg" },
      },
      downloadBytes: new Uint8Array([1, 2, 3]),
    }),
  );
  const h = makePoller({
    fetchFn,
    allowedUsers: [OWNER_ID],
    stt: { apiKey: "sk-test" },
  });

  const r = await h.poller.pollOnce();
  assert.equal(r.accepted, 1);
  const msg = h.injected[0];
  assert.equal(msg.voice.caption, "listen to this");
  assert.ok(msg.text.includes("(caption: listen to this)"));
});

test("pollOnce: without an STT key the voice is delivered with the saved path + 'transcript unavailable' note, and NO STT call is made", async () => {
  const updates = [makeVoiceUpdate(1)];
  const server = makeVoiceServer({
    updates,
    getFileResult: {
      ok: true,
      result: { file_id: "voice_file_id", file_path: "voice/file_1.ogg" },
    },
    downloadBytes: new Uint8Array([1, 2, 3]),
  });
  const fetchFn = makeFakeFetch(server);
  const h = makePoller({ fetchFn, allowedUsers: [OWNER_ID] }); // no stt

  const r = await h.poller.pollOnce();
  assert.equal(r.accepted, 1);
  assert.equal(server.sttCalls.length, 0, "no STT call without an api key");
  const msg = h.injected[0];
  assert.equal(msg.voice.downloaded, true);
  assert.equal(msg.voice.filePath, join(mediaDir, "1.ogg"));
  assert.equal(msg.voice.transcript, undefined);
  assert.ok(
    msg.text.includes("(transcript: unavailable — set BRAID_TG_STT_API_KEY)"),
  );
});

test("pollOnce: download failure degrades to file_id + error note — message is NOT dropped", async () => {
  const updates = [makeVoiceUpdate(1)];
  const fetchFn = makeFakeFetch(
    makeVoiceServer({
      updates,
      getFileResult: {
        ok: true,
        result: { file_id: "voice_file_id", file_path: "voice/file_1.ogg" },
      },
      downloadBytes: null,
      downloadStatus: 404,
    }),
  );
  const h = makePoller({ fetchFn, allowedUsers: [OWNER_ID] });

  const r = await h.poller.pollOnce();
  assert.equal(r.accepted, 1, "degraded voice is still accepted and delivered");
  const msg = h.injected[0];
  assert.equal(msg.voice.downloaded, false);
  assert.equal(msg.voice.fileId, "voice_file_id");
  assert.ok(msg.voice.error, "error note present");
  assert.ok(msg.text.includes("file_id voice_file_id"));
  assert.ok(msg.text.includes("download failed"));
});

test("pollOnce: getFile failure degrades to file_id + error note (never dropped)", async () => {
  const updates = [makeVoiceUpdate(1)];
  const fetchFn = makeFakeFetch(
    makeVoiceServer({
      updates,
      getFileResult: { ok: false, description: "Bad Request: file not found" },
      downloadBytes: null,
    }),
  );
  const h = makePoller({ fetchFn, allowedUsers: [OWNER_ID] });

  const r = await h.poller.pollOnce();
  assert.equal(r.accepted, 1);
  const msg = h.injected[0];
  assert.equal(msg.voice.downloaded, false);
  assert.equal(msg.voice.fileId, "voice_file_id");
  assert.ok(msg.voice.error);
  assert.ok(msg.text.includes("file_id voice_file_id"));
});

test("pollOnce: STT failure degrades to path + transcript error note — message is NOT dropped", async () => {
  const updates = [makeVoiceUpdate(1)];
  const fetchFn = makeFakeFetch(
    makeVoiceServer({
      updates,
      getFileResult: {
        ok: true,
        result: { file_id: "voice_file_id", file_path: "voice/file_1.ogg" },
      },
      downloadBytes: new Uint8Array([1, 2, 3]),
      sttStatus: 401,
    }),
  );
  const h = makePoller({
    fetchFn,
    allowedUsers: [OWNER_ID],
    stt: { apiKey: "sk-test" },
  });

  const r = await h.poller.pollOnce();
  assert.equal(
    r.accepted,
    1,
    "STT-failed voice is still accepted and delivered",
  );
  const msg = h.injected[0];
  assert.equal(msg.voice.downloaded, true);
  assert.equal(msg.voice.filePath, join(mediaDir, "1.ogg"));
  assert.ok(msg.voice.error, "transcription failure note present");
  assert.ok(msg.voice.error.includes("transcription failed"));
  assert.ok(msg.text.includes(join(mediaDir, "1.ogg")));
  assert.ok(msg.text.includes("(transcript: failed:"));
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
  assert.equal(h.injected[0].voice, undefined, "no voice metadata for text");
  assert.equal(
    existsSync(mediaDir),
    false,
    "no media dir created for text-only messages",
  );
});

// ── Shared extraction: the agentic inbox path ───────────────────────────────

test("fetchInbox: owner voice is downloaded, transcribed, and delivered with the transcript (fromOwner true)", async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const updates = [makeVoiceUpdate(1)];
  const server = makeVoiceServer({
    updates,
    getFileResult: {
      ok: true,
      result: { file_id: "voice_file_id", file_path: "voice/file_1.ogg" },
    },
    downloadBytes: bytes,
  });
  const fetchFn = makeFakeFetch(server);

  const res = await fetchInbox({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
    mediaDir,
    stt: { apiKey: "sk-test", model: "whisper-1" },
  });

  assert.equal(res.ok, true);
  assert.equal(res.messages.length, 1);
  const msg = res.messages[0];
  assert.equal(msg.fromOwner, true);
  assert.equal(msg.voice.downloaded, true);
  assert.equal(msg.voice.transcript, "hello");
  assert.equal(msg.voice.filePath, join(mediaDir, "1.ogg"));
  assert.ok(existsSync(msg.voice.filePath));
  assert.ok(msg.text.includes(join(mediaDir, "1.ogg")));
  assert.ok(msg.text.includes('(transcript: "hello")'));
});

// ── Direct extraction: no token degrades without any download attempt ───────

test("extractIncomingMessage: without a token the voice degrades (no download, no throw)", async () => {
  const msg = await extractIncomingMessage(makeVoiceUpdate(1), {});
  assert.equal(msg.voice.downloaded, false);
  assert.equal(msg.voice.fileId, "voice_file_id");
  assert.ok(msg.voice.error);
  assert.ok(msg.text.includes("file_id voice_file_id"));
  assert.ok(msg.text.includes("download failed"));
});
