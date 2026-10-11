/**
 * Session-recall archive-search fixture.
 *
 * Defect: compacted content is FOUND and
 * then thrown away. A `searchFiles` hit inside <sessions>/archives/*.jsonl
 * renders zero snippets because the archive envelope — `{"originals": "<json
 * string of the pre-compaction message array>"}`, one physical line — is not
 * parsed as messages. The snippet loop takes one `{type:"message"}` entry per
 * line, gets null for the envelope, and `continue`s; the query path reads 0
 * messages for the same file. An archive is a dead end, so a compacted session
 * can no longer be read back.
 *
 * Checked here:
 *  (a) NEGATIVE CONTROL / RED: the pre-fix single-entry parser
 *      (`extractMessageText`) returns null for an archive line, so the old
 *      loop renders nothing. This is the in-test RED: if the envelope parser
 *      is removed, (b)/(c) fail while (a) stays true.
 *  (b) `extractLineMessages` returns every message the envelope carries, with
 *      the planted token among them.
 *  (c) The production snippet loop (mirrored line-for-line from
 *      index.ts action=search) renders a non-empty, token-bearing snippet for
 *      an archive-only fixture.
 *  (d) A live session renders exactly as before (extractMessageText non-null,
 *      snippet still produced) — no live-session behaviour change.
 *  (e) Truncation is visible: an envelope larger than MAX_ARCHIVE_MESSAGES with
 *      the match past the cap renders the provenance line naming the scan cap,
 *      rather than dropping the session silently.
 *
 * Run: node test/runtime/memory/test-session-archive-search.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  extractLineMessages,
  extractMessageText,
  snippetAround,
  MAX_ARCHIVE_MESSAGES,
} = await import("../../../dist/extensions/memory/session-recall/text-utils.js");
const { searchFiles, searchLines, MAX_SNIPPETS_PER_SESSION, projectFromPath, dateFromPath } =
  await import("../../../dist/extensions/memory/session-recall/search.js");
const { tokenizeQuery, messagesMatchingTerms } = await import(
  "../../../dist/extensions/memory/session-recall/search.js"
);
const { loadSessionMessages } = await import(
  "../../../dist/extensions/memory/session-recall/query.js"
);

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

// ── Fixture builders ─────────────────────────────────────────────────────────

const PLANTED_TOKEN = "ZZQ-PLANTED-ARCHIVE-TOKEN-777";
const LIVE_TOKEN = "ZZQ-LIVE-TOKEN-555";

function messageLine(role, text) {
  return JSON.stringify({
    type: "message",
    id: "m1",
    parentId: "root",
    timestamp: "2026-09-28T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }] },
  });
}

/** The exact envelope shape context-manager's writeOriginalsArchive emits. */
function archiveLine(messages, extra = {}) {
  return JSON.stringify({
    sessionId: "sess",
    leafId: "leaf",
    reason: "compact",
    timestamp: "2026-09-28T00:00:00.000Z",
    compactedMessages: messages.length,
    keptMessages: 4,
    originals: JSON.stringify(messages),
    ...extra,
  });
}

function rawMessage(role, text) {
  return { role, content: [{ type: "text", text }] };
}

/**
 * Production snippet loop, mirrored from index.ts action=search (the branch
 * that builds `results` from `searchFiles` + `searchLines`). Keep in sync with
 * index.ts; the loop lives inside the tool factory and is not exported.
 */
async function renderSearch(query, sessionsDir) {
  const allMatches = await searchFiles(query, sessionsDir);
  const queryTerms = tokenizeQuery(query);
  const out = [];
  for (const { path: filePath, count } of allMatches) {
    const matchLines = await searchLines(query, filePath, MAX_SNIPPETS_PER_SESSION);
    const snippets = [];
    let archiveNote = "";
    for (const line of matchLines) {
      const parsed = extractLineMessages(line);
      const shown = parsed.isArchive
        ? messagesMatchingTerms(parsed.messages, queryTerms)
        : parsed.messages;
      for (const msg of shown) {
        if (snippets.length >= MAX_SNIPPETS_PER_SESSION) break;
        snippets.push(`  [${msg.role}] ${snippetAround(msg.text, query)}`);
      }
      if (parsed.isArchive) {
        const parts = [`${parsed.totalMessages} archived message${parsed.totalMessages === 1 ? "" : "s"}`];
        if (parsed.truncated) parts.push(`scanned first ${MAX_ARCHIVE_MESSAGES} (later messages not searched)`);
        archiveNote = `  _(compaction archive: ${parts.join(", ")})_`;
      }
      if (snippets.length >= MAX_SNIPPETS_PER_SESSION) break;
    }
    if (snippets.length === 0 && !archiveNote) continue;
    out.push({
      path: filePath,
      project: projectFromPath(filePath),
      date: dateFromPath(filePath),
      count,
      body: [...snippets, archiveNote].filter(Boolean).join("\n"),
    });
  }
  return out;
}

const ROOT = await mkdtemp(join(tmpdir(), "session-archive-search-"));
const sessionDir = join(ROOT, "--Users-tester-proj--");
const archiveDir = join(sessionDir, "archives");

try {
  await mkdir(archiveDir, { recursive: true });

  // Archive-only fixture for the planted token: no live line carries it.
  const archiveMsgs = [
    rawMessage("user", "warm-up question about the build"),
    rawMessage("assistant", "warm-up answer"),
    rawMessage("user", `the encrypted config lives under ${PLANTED_TOKEN} in the vault`),
    rawMessage("assistant", "noted"),
  ];
  const archivePath = join(archiveDir, "01a0aaaa-1111-2222-3333-444444444444-1790000000000.jsonl");
  await writeFile(archivePath, archiveLine(archiveMsgs) + "\n");

  // Live control: behaves as before.
  const livePath = join(sessionDir, "2026-09-28T00-00-00-000Z_live.jsonl");
  await writeFile(livePath, messageLine("user", `the live note mentions ${LIVE_TOKEN}`) + "\n");

  // Truncation fixture: > MAX_ARCHIVE_MESSAGES messages, match past the cap.
  const big = [];
  for (let i = 0; i < MAX_ARCHIVE_MESSAGES; i++) big.push(rawMessage("user", `filler ${i}`));
  big.push(rawMessage("user", `the late token is ${PLANTED_TOKEN} beyond the cap`));
  const bigPath = join(archiveDir, "01a0bbbb-1111-2222-3333-444444444444-1790000000001.jsonl");
  await writeFile(bigPath, archiveLine(big) + "\n");

  console.log("=== session-recall archive search ===\n");

  await test("(a) NEGATIVE CONTROL: pre-fix single-entry parser yields null on an archive line", () => {
    const line = archiveLine(archiveMsgs);
    assert.equal(extractMessageText(line), null, "old parser should see no message in the envelope");
  });

  await test("(b) envelope parser returns the archived messages incl. the planted token", () => {
    const parsed = extractLineMessages(archiveLine(archiveMsgs));
    assert.equal(parsed.isArchive, true);
    assert.equal(parsed.truncated, false);
    assert.equal(parsed.totalMessages, archiveMsgs.length);
    assert.ok(parsed.messages.length > 0, "expected messages from originals");
    assert.ok(
      parsed.messages.some((m) => m.text.includes(PLANTED_TOKEN)),
      "planted token must be among the parsed messages",
    );
  });

  await test("(c) production loop renders a non-empty, token-bearing snippet for the archive", async () => {
    const rendered = await renderSearch(PLANTED_TOKEN, sessionDir);
    const archive = rendered.find((r) => r.path === archivePath);
    assert.ok(archive, "archive must render (pre-fix: zero snippets -> dropped)");
    assert.ok(archive.body.includes(PLANTED_TOKEN), `snippet must carry the token, got: ${archive.body}`);
    assert.ok(archive.body.includes("compaction archive"), "provenance line expected");
  });

  await test("(c2) query path reads >0 messages from the archive", async () => {
    const messages = await loadSessionMessages(archivePath);
    assert.ok(messages.length > 0, "archive must be readable as messages");
    assert.ok(messages.some((m) => m.content.includes(PLANTED_TOKEN)));
  });

  await test("(d) live session unchanged: old parser non-null and snippet still rendered", async () => {
    const line = messageLine("user", `the live note mentions ${LIVE_TOKEN}`);
    const msg = extractMessageText(line);
    assert.ok(msg, "live parser must still extract the message");
    assert.ok(msg.text.includes(LIVE_TOKEN));
    const rendered = await renderSearch(LIVE_TOKEN, sessionDir);
    const live = rendered.find((r) => r.path === livePath);
    assert.ok(live, "live session must render");
    assert.ok(live.body.includes(LIVE_TOKEN));
    assert.ok(!live.body.includes("compaction archive"), "live session must not carry an archive note");
  });

  await test("(e) oversized envelope: truncated flag set and the scan cap is visible", async () => {
    const parsed = extractLineMessages(archiveLine(big));
    assert.equal(parsed.isArchive, true);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.totalMessages, big.length);
    // Mirror the production loop: match is past the cap, so no candidate
    // snippet, but the provenance line (naming the cap) must still render the
    // session rather than dropping it.
    const rendered = await renderSearch(PLANTED_TOKEN, sessionDir);
    const hit = rendered.find((r) => r.path === bigPath);
    assert.ok(hit, "oversized archive must not be dropped silently");
    assert.ok(hit.body.includes("later messages not searched"), `cap must be visible, got: ${hit.body}`);
  });
} finally {
  await rm(ROOT, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
