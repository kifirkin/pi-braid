/**
 * document-inbound.test.mjs — inbound document (file attachment) support:
 * classifyUpdate accepts document messages (with or without text), the shared
 * extraction downloads the file via getFile + the /file/bot<token>/<file_path>
 * route, saves it as <mediaDir>/<update_id>.<safe-ext from file_name>, and
 * delivers the absolute path (caption + name carried). Download failures and
 * over-limit sizes (>20MB) degrade to file_id + explicit error note — never
 * dropped. Hostile filename fixtures are built PROGRAMMATICALLY (segments
 * joined at runtime) — the contiguous traversal literal never appears in this
 * source. NO network, no real timers.
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
  hasDocument,
  materializeDocument,
  safeExtFromFileName,
  MAX_DOCUMENT_BYTES,
} from "../dist/lib/document.js";

import {
  BOT_TOKEN,
  OWNER_ID,
  OWNER_CHAT_ID,
  FOREIGN_ID,
  jsonResponse,
  makeFakeFetch,
} from "./fixtures.mjs";

let stateFile;
let mediaDir;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "tg-document-"));
  stateFile = join(dir, "state.json");
  mediaDir = join(dir, "media");
});

// ── Hostile filename fixtures (built programmatically — never literals) ─────

const TRAVERSAL_CHAIN = ["..", "..", "etc", "passwd"].join("/");
const TRAVERSAL_WITH_EXT = ["..", "..", "etc", "passwd.pdf"].join("/");
const BACKSLASH_CHAIN = ["..", "..", "win", "secret.txt"].join("\\");
const DOTFILE = [".", "bashrc"].join("");
const TRAILING_SPACE_UPPER = ["REPORT", "PDF"].join(".") + " ";
const NO_EXT = "README";
const MULTI_EXT = ["archive", "tar", "gz"].join(".");
const TRAILING_DOT = ["report", ""].join(".");

/** Document update with a standard client-side file name. */
function makeDocumentUpdate(updateId, messageOverrides = {}) {
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
      chat: { id: OWNER_CHAT_ID, type: "private", username: "owner" },
      date: 1700000000,
      document: {
        file_id: "doc_file_id",
        file_unique_id: "du",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        file_size: 1200,
      },
      ...messageOverrides,
    },
  };
}

/** Fake getUpdates+getFile+download server for one document update. */
function makeDocumentServer({
  updates = [],
  getFileResult,
  downloadBytes,
  downloadStatus = 200,
}) {
  return async (url) => {
    if (url.includes("getUpdates"))
      return jsonResponse({ ok: true, result: updates });
    if (url.includes("getFile")) return jsonResponse(getFileResult);
    if (url.includes("/file/bot")) {
      if (downloadStatus !== 200)
        return jsonResponse(
          { ok: false, description: "Not Found" },
          downloadStatus,
        );
      return new Response(downloadBytes, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

function makePoller({ fetchFn, allowedUsers = [] } = {}) {
  const injected = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers,
    stateFile,
    fetchFn,
    mediaDir,
    bootstrap: false,
    onOwnerMessage: async (msg) => {
      injected.push(msg);
    },
    onError: () => {},
  });
  return { injected, poller };
}

// ── hasDocument ─────────────────────────────────────────────────────────────

test("hasDocument: true for message.document, false for photo/voice/text-only/malformed", () => {
  assert.equal(
    hasDocument({ document: { file_id: "d1", file_name: "a.pdf" } }),
    true,
  );
  assert.equal(hasDocument({ document: { file_id: "d1" } }), true);

  assert.equal(hasDocument({ photo: [{ file_id: "p1" }] }), false);
  assert.equal(hasDocument({ voice: { file_id: "v1" } }), false);
  assert.equal(hasDocument({ text: "plain text" }), false);
  assert.equal(hasDocument({}), false);
  assert.equal(hasDocument(null), false);
  assert.equal(hasDocument(undefined), false);
  // Malformed document (no file_id) is not usable.
  assert.equal(hasDocument({ document: { file_name: "x.pdf" } }), false);
});

// ── Gate: document-only messages reach extraction instead of being dropped ──

test("classifyUpdate: document-only message (no text) is accepted; caption/text variants classify by sender", () => {
  assert.equal(
    classifyUpdate(makeDocumentUpdate(1), [OWNER_ID], false),
    "owner",
  );

  const withCaption = makeDocumentUpdate(2, { caption: "specs" });
  assert.equal(classifyUpdate(withCaption, [OWNER_ID], false), "owner");

  // text+document passes the gate too (extraction carries both).
  const withText = makeDocumentUpdate(3, { text: "see attached" });
  assert.equal(classifyUpdate(withText, [OWNER_ID], false), "owner");

  const foreignDoc = makeDocumentUpdate(4, {
    from: { id: FOREIGN_ID, is_bot: false },
  });
  assert.equal(classifyUpdate(foreignDoc, [OWNER_ID], false), "foreign");
});

// ── Poller path: download + save + deliver ──────────────────────────────────

test("pollOnce: owner document is downloaded, saved as <update_id>.<ext>, and delivered with the abs path", async () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const updates = [makeDocumentUpdate(1)];
  const fetchFn = makeFakeFetch(
    makeDocumentServer({
      updates,
      getFileResult: {
        ok: true,
        result: {
          file_id: "doc_file_id",
          file_size: 1200,
          file_path: "documents/file_1.pdf",
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

  // getFile was called with the document's file_id.
  const getFileCall = fetchFn.calls.find((c) => c.url.includes("getFile"));
  assert.ok(getFileCall, "getFile called");
  assert.ok(
    getFileCall.url.includes("file_id=doc_file_id"),
    "document file_id requested",
  );

  const msg = h.injected[0];
  assert.equal(msg.document.downloaded, true);
  assert.equal(msg.document.fileId, "doc_file_id");
  assert.equal(msg.document.path, join(mediaDir, "1.pdf"));
  assert.equal(msg.document.name, "report.pdf");
  assert.equal(msg.document.size, 1200);
  assert.equal(msg.document.mimeType, "application/pdf");
  assert.equal(msg.photo, undefined, "no photo payload for a document");
  assert.equal(msg.voice, undefined, "no voice payload for a document");
  assert.ok(existsSync(msg.document.path), "file saved on disk");
  assert.deepEqual(new Uint8Array(readFileSync(msg.document.path)), bytes);

  // Delivered text carries the absolute path the agent can read.
  assert.ok(msg.text.includes("📄 Document from @owner"));
  assert.ok(msg.text.includes(join(mediaDir, "1.pdf")));
  assert.ok(msg.text.includes("(name: report.pdf)"));
  assert.ok(msg.text.includes("(caption: none)"));
});

test("pollOnce: text+document carries BOTH the owner text and the materialized document payload", async () => {
  const updates = [makeDocumentUpdate(1, { text: "see attached" })];
  const fetchFn = makeFakeFetch(
    makeDocumentServer({
      updates,
      getFileResult: {
        ok: true,
        result: { file_id: "doc_file_id", file_path: "documents/file_1.pdf" },
      },
      downloadBytes: new Uint8Array([1, 2, 3]),
    }),
  );
  const h = makePoller({ fetchFn, allowedUsers: [OWNER_ID] });

  const r = await h.poller.pollOnce();
  assert.equal(r.accepted, 1);
  assert.equal(h.injected.length, 1);

  const msg = h.injected[0];
  assert.ok(msg.text.startsWith("see attached"), "original text preserved");
  assert.ok(
    msg.text.includes("📄 Document from @owner"),
    "document line present",
  );
  assert.ok(msg.text.includes(join(mediaDir, "1.pdf")));
  assert.equal(msg.document.downloaded, true);
  assert.equal(msg.document.path, join(mediaDir, "1.pdf"));
});

test("pollOnce: document caption is carried in the delivered text and payload", async () => {
  const updates = [makeDocumentUpdate(1, { caption: "quarterly numbers" })];
  const fetchFn = makeFakeFetch(
    makeDocumentServer({
      updates,
      getFileResult: {
        ok: true,
        result: { file_id: "doc_file_id", file_path: "documents/file_1.pdf" },
      },
      downloadBytes: new Uint8Array([1, 2, 3]),
    }),
  );
  const h = makePoller({ fetchFn, allowedUsers: [OWNER_ID] });

  const r = await h.poller.pollOnce();
  assert.equal(r.accepted, 1);
  const msg = h.injected[0];
  assert.equal(msg.document.caption, "quarterly numbers");
  assert.ok(msg.text.includes("(caption: quarterly numbers)"));
});

test("pollOnce: download failure degrades to file_id + error note — document is NOT dropped", async () => {
  const updates = [makeDocumentUpdate(1)];
  const fetchFn = makeFakeFetch(
    makeDocumentServer({
      updates,
      getFileResult: {
        ok: true,
        result: { file_id: "doc_file_id", file_path: "documents/file_1.pdf" },
      },
      downloadBytes: null,
      downloadStatus: 404,
    }),
  );
  const h = makePoller({ fetchFn, allowedUsers: [OWNER_ID] });

  const r = await h.poller.pollOnce();
  assert.equal(r.accepted, 1, "degraded document is still accepted");
  const msg = h.injected[0];
  assert.equal(msg.document.downloaded, false);
  assert.equal(msg.document.fileId, "doc_file_id");
  assert.ok(msg.document.error, "error note present");
  assert.equal(msg.document.path, undefined, "no path on failure");
  assert.ok(msg.text.includes("file_id doc_file_id"));
  assert.ok(msg.text.includes("download failed"));
});

test("pollOnce: getFile failure degrades to file_id + error note (never dropped)", async () => {
  const updates = [makeDocumentUpdate(1)];
  const fetchFn = makeFakeFetch(
    makeDocumentServer({
      updates,
      getFileResult: {
        ok: false,
        description: "Bad Request: file not found",
      },
      downloadBytes: null,
    }),
  );
  const h = makePoller({ fetchFn, allowedUsers: [OWNER_ID] });

  const r = await h.poller.pollOnce();
  assert.equal(r.accepted, 1);
  const msg = h.injected[0];
  assert.equal(msg.document.downloaded, false);
  assert.equal(msg.document.fileId, "doc_file_id");
  assert.ok(msg.document.error);
  assert.ok(msg.text.includes("file_id doc_file_id"));
});

// ── materializeDocument (direct) ────────────────────────────────────────────

test("materializeDocument: ok path writes <update_id>.<ext from file_name> with the downloaded bytes", async () => {
  const bytes = new Uint8Array([0x0a, 0x0b, 0x0c]);
  // file_path extension (.bin) differs from file_name (.txt) — file_name wins.
  const fetchFn = makeFakeFetch(
    makeDocumentServer({
      getFileResult: {
        ok: true,
        result: { file_id: "d1", file_path: "documents/file_1.bin" },
      },
      downloadBytes: bytes,
    }),
  );

  const r = await materializeDocument({
    token: BOT_TOKEN,
    updateId: 7,
    document: { file_id: "d1", file_name: "notes.txt" },
    fetchFn,
    mediaDir,
  });

  assert.equal(r.ok, true);
  assert.equal(r.filePath, join(mediaDir, "7.txt"));
  assert.equal(r.filePathOnTelegram, "documents/file_1.bin");
  assert.deepEqual(new Uint8Array(readFileSync(r.filePath)), bytes);
});

test("materializeDocument: getFile failure and download failure both return {ok:false,error} without throwing", async () => {
  const getFileFail = makeFakeFetch(
    makeDocumentServer({
      getFileResult: { ok: false, description: "Bad Request: wrong file_id" },
      downloadBytes: null,
    }),
  );
  const r1 = await materializeDocument({
    token: BOT_TOKEN,
    updateId: 8,
    document: { file_id: "d1", file_name: "a.pdf" },
    fetchFn: getFileFail,
    mediaDir,
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.fileId, "d1");
  assert.ok(r1.error);

  const downloadFail = makeFakeFetch(
    makeDocumentServer({
      getFileResult: {
        ok: true,
        result: { file_id: "d1", file_path: "documents/file_1.pdf" },
      },
      downloadBytes: null,
      downloadStatus: 500,
    }),
  );
  const r2 = await materializeDocument({
    token: BOT_TOKEN,
    updateId: 8,
    document: { file_id: "d1", file_name: "a.pdf" },
    fetchFn: downloadFail,
    mediaDir,
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.fileId, "d1");
  assert.ok(r2.error);
});

test("materializeDocument: >20MB file_size is refused with an explicit reason BEFORE any network call", async () => {
  const fetchFn = makeFakeFetch(
    makeDocumentServer({
      getFileResult: {
        ok: true,
        result: { file_id: "d2", file_path: "documents/big.bin" },
      },
      downloadBytes: new Uint8Array([1]),
    }),
  );

  const refused = await materializeDocument({
    token: BOT_TOKEN,
    updateId: 9,
    document: {
      file_id: "d2",
      file_name: "big.bin",
      file_size: MAX_DOCUMENT_BYTES + 1,
    },
    fetchFn,
    mediaDir,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.fileId, "d2");
  assert.ok(refused.error.includes("file too large"), "explicit reason");
  assert.ok(refused.error.includes(String(MAX_DOCUMENT_BYTES)), "limit stated");
  assert.equal(
    fetchFn.calls.filter((c) => c.url.includes("getFile")).length,
    0,
    "no getFile attempt",
  );
  assert.equal(
    fetchFn.calls.filter((c) => c.url.includes("/file/bot")).length,
    0,
    "no download attempt",
  );

  // Boundary: exactly at the limit is allowed (Telegram refuses ABOVE 20MB).
  const atLimit = await materializeDocument({
    token: BOT_TOKEN,
    updateId: 10,
    document: {
      file_id: "d3",
      file_name: "exact.bin",
      file_size: MAX_DOCUMENT_BYTES,
    },
    fetchFn,
    mediaDir,
  });
  assert.equal(atLimit.ok, true, "size == limit is not refused");
  assert.ok(
    fetchFn.calls.some((c) => c.url.includes("file_id=d3")),
    "getFile attempted at the boundary",
  );
});

// ── Extension sanitization (hostile fixtures, programmatic) ─────────────────

test("safeExtFromFileName: hostile filename fixture table maps to safe outcomes", () => {
  const cases = [
    // Traversal chain without extension → basename has no dot → fallback.
    [TRAVERSAL_CHAIN, "bin"],
    // Traversal chain with an extension → only the extension survives.
    [TRAVERSAL_WITH_EXT, "pdf"],
    // Backslash-separated chain → same discipline.
    [BACKSLASH_CHAIN, "txt"],
    // Dotfile (".bashrc" style) — leading dot is not an extension.
    [DOTFILE, "bin"],
    // Trailing space + uppercase extension → trimmed + lowercased.
    [TRAILING_SPACE_UPPER, "pdf"],
    // No extension at all.
    [NO_EXT, "bin"],
    // Multi-extension name → last segment.
    [MULTI_EXT, "gz"],
    // Trailing dot → no usable extension.
    [TRAILING_DOT, "bin"],
    // Empty / missing names.
    ["", "bin"],
    [undefined, "bin"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(
      safeExtFromFileName(name),
      expected,
      `fixture ${JSON.stringify(name)} → ${expected}`,
    );
  }
});

test("materializeDocument: hostile file_name cannot affect the destination path", async () => {
  const fetchFn = makeFakeFetch(
    makeDocumentServer({
      getFileResult: {
        ok: true,
        result: { file_id: "d4", file_path: "documents/file_1.pdf" },
      },
      downloadBytes: new Uint8Array([1, 2]),
    }),
  );

  const r = await materializeDocument({
    token: BOT_TOKEN,
    updateId: 5,
    document: { file_id: "d1", file_name: TRAVERSAL_CHAIN },
    fetchFn,
    mediaDir,
  });
  assert.equal(r.ok, true);
  assert.equal(r.filePath, join(mediaDir, "5.bin"));
  assert.ok(!r.filePath.includes("etc"), "no traversal segments in dest");
  assert.ok(existsSync(r.filePath));
});

// ── Shared extraction: the agentic inbox path ───────────────────────────────

test("fetchInbox: owner document is downloaded and delivered with the abs path (fromOwner true)", async () => {
  const bytes = new Uint8Array([3, 1, 4]);
  const updates = [makeDocumentUpdate(1)];
  const fetchFn = makeFakeFetch(
    makeDocumentServer({
      updates,
      getFileResult: {
        ok: true,
        result: { file_id: "doc_file_id", file_path: "documents/file_1.pdf" },
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
  assert.equal(msg.document.downloaded, true);
  assert.equal(msg.document.path, join(mediaDir, "1.pdf"));
  assert.ok(existsSync(msg.document.path));
  assert.ok(msg.text.includes(join(mediaDir, "1.pdf")));
});

// ── Direct extraction: no token degrades without any download attempt ───────

test("extractIncomingMessage: without a token the document degrades (no download, no throw)", async () => {
  const msg = await extractIncomingMessage(makeDocumentUpdate(1), {});
  assert.equal(msg.document.downloaded, false);
  assert.equal(msg.document.fileId, "doc_file_id");
  assert.equal(msg.document.name, "report.pdf");
  assert.ok(msg.document.error);
  assert.ok(msg.text.includes("file_id doc_file_id"));
  assert.ok(msg.text.includes("download failed"));
});
