/**
 * live-update.test.mjs — LiveUpdateTracker (item 31), deterministic.
 *
 * NO network, NO real LLM: the client calls and clock are injected. Covers:
 *  - start(): immediate "Working…" send + persisted message_id/chat_id
 *  - update(): in-place edit, idempotent (no new-message spam), rate-limited
 *  - finish(): done-edit + SEPARATE final summary (crafted markdown / raw
 *    fallback), clear of tracked state
 *  - restart: a persisted tracked message is resumed (no duplicate)
 *  - failure paths: send-failed, no-chat, no-tracked-message
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";

import {
  createLiveUpdateTracker,
  TRACKED_START_TEXT,
  TRACKED_DONE_TEXT,
  TRACKED_DONE_TEXT_REPORT_SENT,
  TRACKED_TERMINAL_TEXT,
  saveLiveState,
  clearLiveState,
} from "../dist/lib/notify/live-update.js";
import {
  markAgentDeliveredMessage,
  clearAgentDeliveredMessage,
} from "../dist/lib/notify/agent-delivery.js";
import { BOT_TOKEN, OWNER_CHAT_ID } from "./fixtures.mjs";

function tmpStateFile(label) {
  const dir = mkdtempSync(join(tmpdir(), `tg-live-${label}-`));
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

// ── start ───────────────────────────────────────────────────────────────────

test("start: sends the immediate Working… message and persists message_id + chat_id", async () => {
  const { dir, stateFile } = tmpStateFile("start");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  const out = await tracker.start();
  assert.equal(out.started, true);
  assert.equal(out.reused, false);
  assert.equal(out.messageId, 1001);

  assert.equal(stub.sends.length, 1);
  assert.equal(stub.sends[0].chatId, OWNER_CHAT_ID);
  assert.equal(stub.sends[0].text, TRACKED_START_TEXT);
  assert.equal(stub.edits.length, 0, "fresh start sends, never edits");

  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(persisted.messageId, 1001);
  assert.equal(persisted.chatId, OWNER_CHAT_ID);
  assert.ok(await tracker.isActive());
  rmSync(dir, { recursive: true, force: true });
});

test("start: sends without a message_id → not editable, so no tracked state is kept", async () => {
  const { dir, stateFile } = tmpStateFile("noid");
  const client = {
    sendMessage: async () => ({ ok: true, messageId: undefined }),
    editMessageText: async () => ({ ok: false }),
  };
  const tracker = createLiveUpdateTracker({
    client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });
  const out = await tracker.start();
  assert.equal(out.started, true);
  assert.equal(out.messageId, undefined);
  assert.equal(
    await tracker.isActive(),
    false,
    "no editable message_id → nothing to edit later",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("start: send failure → { started:false, reason:'send-failed' }, nothing persisted", async () => {
  const { dir, stateFile } = tmpStateFile("fail");
  const client = {
    sendMessage: async () => ({ ok: false, error: "401 unauthorized" }),
    editMessageText: async () => ({ ok: false }),
  };
  const tracker = createLiveUpdateTracker({
    client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });
  const out = await tracker.start();
  assert.equal(out.started, false);
  assert.equal(out.reason, "send-failed");
  assert.equal(await tracker.isActive(), false);
  rmSync(dir, { recursive: true, force: true });
});

test("start: no resolved owner chat → { started:false, reason:'no-chat' } (resolver path)", async () => {
  const { dir, stateFile } = tmpStateFile("nochat");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: () => 0,
    stateFile,
  });
  const out = await tracker.start();
  assert.equal(out.started, false);
  assert.equal(out.reason, "no-chat");
  assert.equal(stub.sends.length, 0, "no send without a chat id");
  rmSync(dir, { recursive: true, force: true });
});

// ── update ──────────────────────────────────────────────────────────────────

test("update: edits the tracked message in place — no new-message spam", async () => {
  const { dir, stateFile } = tmpStateFile("update");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.start();
  const u1 = await tracker.update("step 1: grepping logs");
  const u2 = await tracker.update("step 2: running tests");

  assert.equal(u1.updated, true);
  assert.equal(u2.updated, true);
  assert.equal(
    stub.sends.length,
    1,
    "exactly one message ever sent (the tracked one)",
  );
  assert.equal(stub.edits.length, 2);
  assert.equal(stub.edits[0].messageId, 1001);
  assert.equal(stub.edits[1].messageId, 1001);
  assert.equal(stub.edits[0].text, "step 1: grepping logs");
  assert.equal(stub.edits[1].text, "step 2: running tests");
  rmSync(dir, { recursive: true, force: true });
});

test("update: idempotent — no-op when no tracked message exists", async () => {
  const { dir, stateFile } = tmpStateFile("idem");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });
  const out = await tracker.update("nothing tracked");
  assert.equal(out.updated, false);
  assert.equal(out.reason, "no-tracked-message");
  assert.equal(stub.edits.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("update: rate-limited beyond max-per-window (edits skipped, no API call)", async () => {
  const { dir, stateFile } = tmpStateFile("rate");
  const stub = makeStub();
  let clock = 0;
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
    now: () => clock,
    maxPerWindow: 2,
    windowMs: 60_000,
  });

  await tracker.start(); // consumes slot 1
  const u1 = await tracker.update("a"); // consumes slot 2
  const u2 = await tracker.update("b"); // window saturated
  assert.equal(u1.updated, true);
  assert.equal(u2.updated, false);
  assert.equal(u2.reason, "rate-limited");
  assert.equal(
    stub.edits.length,
    1,
    "only the admitted update reached the API",
  );
  rmSync(dir, { recursive: true, force: true });
});

// ── finish ──────────────────────────────────────────────────────────────────

test("finish: edits tracked → Done, then sends a SEPARATE crafted markdown summary, clears state", async () => {
  const { dir, stateFile } = tmpStateFile("finish");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.start();
  const craftRich = async () => ({
    text: "**Report ready**\n\n- Point one\n- Point two",
    crafted: true,
  });
  const out = await tracker.finish({
    resultText: "the raw long answer",
    craftRich,
  });

  assert.equal(out.completed, true);
  assert.equal(out.doneEdited, true);
  assert.equal(out.summarySent, true);
  assert.equal(out.summaryChunks, 1);

  // done-edit is FIRST (on the tracked message), then a NEW send (summary).
  assert.equal(stub.edits[0].messageId, 1001);
  assert.equal(stub.edits[0].text, TRACKED_DONE_TEXT);
  assert.equal(
    stub.sends.length,
    2,
    "Working… + final summary = 2 messages total",
  );
  assert.equal(stub.sends[1].chatId, OWNER_CHAT_ID);
  assert.equal(
    stub.sends[1].text,
    "<b>Report ready</b>\n\n- Point one\n- Point two",
  );
  assert.equal(
    stub.sends[1].options.parseMode,
    "HTML",
    "MarkdownV2 crafted body converts instead of shipping literal **",
  );

  assert.equal(
    await tracker.isActive(),
    false,
    "tracked state cleared after finish",
  );
  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(persisted.messageId, 0, "state file cleared after finish");
  rmSync(dir, { recursive: true, force: true });
});

test("finish: suppressSummary skips the separate summary, done-edit points above (owner double-message fix)", async () => {
  const { dir, stateFile } = tmpStateFile("suppress");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.start();
  const craftRich = async () => ({
    text: "**Report ready**\n\n- Point one",
    crafted: true,
  });
  const out = await tracker.finish({
    resultText: "the raw long answer",
    craftRich,
    suppressSummary: true,
  });

  assert.equal(out.completed, true);
  assert.equal(out.doneEdited, true);
  assert.equal(
    out.summarySent,
    false,
    "agent already reported — no duplicate summary",
  );
  assert.equal(out.summaryChunks, 0);

  // Only the tracked done-edit happens; NO second message goes out.
  assert.equal(stub.edits[0].messageId, 1001);
  assert.equal(stub.edits[0].text, TRACKED_DONE_TEXT_REPORT_SENT);
  assert.equal(
    stub.sends.length,
    1,
    "Working… only — the report above IS the deliverable",
  );

  assert.equal(
    await tracker.isActive(),
    false,
    "tracked state cleared after finish",
  );
  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(persisted.messageId, 0, "state file cleared after finish");
  rmSync(dir, { recursive: true, force: true });
});

test("end(done): the agent-delivered flag suppresses the auto summary through the resolver", async () => {
  const { dir, stateFile } = tmpStateFile("suppress-end");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.begin();
  markAgentDeliveredMessage(); // telegram_send succeeded earlier in the turn
  const out = await tracker.end("done", { resultText: "the report" });

  assert.equal(out.ended, true);
  assert.equal(out.doneEdited, true);
  assert.equal(
    out.summarySent,
    false,
    "flag read by the resolver — summary suppressed",
  );
  assert.equal(stub.edits[0].text, TRACKED_DONE_TEXT_REPORT_SENT);
  assert.equal(stub.sends.length, 1, "no summary message sent");

  clearAgentDeliveredMessage();
  rmSync(dir, { recursive: true, force: true });
});

test("end(done): resolver clears the flag — a later finish on the same turn does not suppress", async () => {
  const { dir, stateFile } = tmpStateFile("suppress-clear");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.begin();
  markAgentDeliveredMessage();
  const out = await tracker.end("done", { resultText: "the report" });
  assert.equal(out.summarySent, false);
  // Next resolution on a fresh unit (flag was read+cleared): a NEW turn that
  // did NOT send a report gets its auto summary back.
  await tracker.begin();
  const out2 = await tracker.end("done", {
    resultText: "turn without a report",
  });
  assert.equal(out2.summarySent, true, "flag cleared — auto summary restored");
  assert.equal(stub.edits[1].text, TRACKED_DONE_TEXT);

  clearAgentDeliveredMessage();
  rmSync(dir, { recursive: true, force: true });
});

test("finish: drops parse_mode when crafted markdown is unbalanced (plain-text fallback)", async () => {
  const { dir, stateFile } = tmpStateFile("unbalanced");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.start();
  const craftRich = async () => ({
    text: "**unclosed bold * and _orphan italic",
    crafted: true,
  });
  const out = await tracker.finish({ resultText: "raw", craftRich });

  assert.equal(out.summarySent, true);
  assert.equal(stub.sends[1].text, "**unclosed bold * and _orphan italic");
  assert.equal(
    stub.sends[1].options.parseMode,
    undefined,
    "unbalanced markdown delivered plain",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("finish: crafted HTML summary body ships as HTML, never leaks raw tags under Markdown (Task C)", async () => {
  const { dir, stateFile } = tmpStateFile("htmlsum");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.start();
  // Pre-fix this body was "balanced" to isBalancedMarkdown → shipped Markdown
  // → the raw <b> tags leaked to the owner. Now HTML mode is chosen.
  const craftRich = async () => ({
    text: "<b>Report ready</b>\n\nDetail here.",
    crafted: true,
  });
  const out = await tracker.finish({ resultText: "raw", craftRich });

  assert.equal(out.summarySent, true);
  assert.equal(
    stub.sends[1].options.parseMode,
    "HTML",
    "HTML body must not ship under Markdown",
  );
  assert.equal(stub.sends[1].text, "<b>Report ready</b>\n\nDetail here.");
  rmSync(dir, { recursive: true, force: true });
});

test("finish: crafted mixed body (HTML + stray Markdown) ships as HTML with markers converted", async () => {
  const { dir, stateFile } = tmpStateFile("mixedsum");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.start();
  const craftRich = async () => ({
    text: "**Lead** <i>then</i> detail",
    crafted: true,
  });
  const out = await tracker.finish({ resultText: "raw", craftRich });

  assert.equal(out.summarySent, true);
  assert.equal(stub.sends[1].options.parseMode, "HTML");
  assert.ok(
    !stub.sends[1].text.includes("**"),
    "markdown marker converted on an HTML wire",
  );
  assert.equal(stub.sends[1].text, "<b>Lead</b> <i>then</i> detail");
  rmSync(dir, { recursive: true, force: true });
});

test("finish: falls back to the raw result text when no craft hook is supplied", async () => {
  const { dir, stateFile } = tmpStateFile("raw");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.start();
  const out = await tracker.finish({
    resultText: "the final answer, split-to-fit if long",
  });
  assert.equal(out.completed, true);
  assert.equal(out.summarySent, true);
  assert.equal(stub.sends[1].text, "the final answer, split-to-fit if long");
  assert.equal(stub.sends[1].options.parseMode, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("finish: splits a long final summary across multiple messages yet still clears state", async () => {
  const { dir, stateFile } = tmpStateFile("long");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.start();
  const longResult = Array.from(
    { length: 300 },
    (_, i) => `section ${i} ` + "y".repeat(40),
  ).join("\n\n");
  const out = await tracker.finish({ resultText: longResult });
  assert.equal(out.completed, true);
  assert.equal(out.summarySent, true);
  assert.ok((out.summaryChunks ?? 1) > 1, "long summary split to fit");
  assert.equal(
    stub.sends.length,
    1 + out.summaryChunks,
    "1 tracked + N summary messages",
  );
  assert.equal(await tracker.isActive(), false);
  rmSync(dir, { recursive: true, force: true });
});

test("finish: completed even with no tracked message — the final summary still goes out", async () => {
  const { dir, stateFile } = tmpStateFile("notracked");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });
  const out = await tracker.finish({
    resultText: "report without a tracked message",
  });
  assert.equal(out.doneEdited, false);
  assert.equal(out.summarySent, true);
  assert.equal(stub.sends[0].text, "report without a tracked message");
  rmSync(dir, { recursive: true, force: true });
});

// ── restart / persistence ───────────────────────────────────────────────────

test("restart: a persisted tracked message is resumed (reused edit, no duplicate send)", async () => {
  const { dir, stateFile } = tmpStateFile("restart");
  const stubA = makeStub();
  const trackerA = createLiveUpdateTracker({
    client: stubA.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });
  await trackerA.start(); // messageId 1001, persisted

  // "new process" — fresh tracker + fresh stub over the SAME state file.
  const stubB = makeStub();
  const trackerB = createLiveUpdateTracker({
    client: stubB.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });
  const out = await trackerB.start();

  assert.equal(out.started, true);
  assert.equal(out.reused, true);
  assert.equal(out.messageId, 1001);
  assert.equal(
    stubB.sends.length,
    0,
    "resume must NOT re-send the tracked message",
  );
  assert.equal(
    stubB.edits.length,
    1,
    "resume re-pins the existing message via edit",
  );
  assert.equal(stubB.edits[0].messageId, 1001);
  assert.equal(stubB.edits[0].text, TRACKED_START_TEXT);
  rmSync(dir, { recursive: true, force: true });
});

test("restart: state file with messageId 0 (cleared) is treated as no tracked message", async () => {
  const { dir, stateFile } = tmpStateFile("cleared");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });
  const out = await tracker.start();
  assert.equal(out.started, true);
  assert.equal(out.reused, false, "washed-out state → fresh tracked message");
  assert.equal(stub.sends.length, 1);
  assert.ok(existsSync(stateFile));
  rmSync(dir, { recursive: true, force: true });
});

// ── durability: the state file is never observed torn ─────────────────────

test("concurrent saves and clears: a parsing reader never observes a torn state", async () => {
  const { dir, stateFile } = tmpStateFile("race");
  const cleared = JSON.stringify({ messageId: 0, chatId: 0, startedAt: 0 });
  const snapshots = Array.from({ length: 60 }, (_, i) => ({
    messageId: 8000 + i,
    chatId: OWNER_CHAT_ID,
    startedAt: 1_700_000_000_000 + i,
  }));
  const whole = new Set([
    cleared,
    ...snapshots.map((snapshot) => JSON.stringify(snapshot)),
  ]);

  // The reader is the suite's own instrument (readFileSync + JSON.parse) run
  // in a loop while writers are in flight. A truncate-then-write lets it
  // observe a state that was never written: an empty file inside the truncate
  // window, or one document followed by the tail of another.
  const torn = [];
  let stop = false;
  const reader = (async () => {
    // Every sample yields once, even a sample that FAILED to parse: a
    // parse-failure branch that loops without yielding starves the writers it
    // is racing (their truncate/write pair never completes), which wedges the
    // file in the very state the reader is waiting to escape.
    for (let reads = 0; !stop && reads < 20_000 && torn.length < 5; reads++) {
      let raw;
      try {
        raw = readFileSync(stateFile, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error; // first save may not have landed yet
      }
      if (raw !== undefined) {
        try {
          const parsed = JSON.parse(raw);
          const doc = JSON.stringify({
            messageId: parsed.messageId,
            chatId: parsed.chatId,
            startedAt: parsed.startedAt,
          });
          if (!whole.has(doc)) torn.push(`never-written state: ${doc}`);
        } catch (error) {
          torn.push(`unparsable (${String(error)}): ${JSON.stringify(raw)}`);
        }
      }
      await yieldToLoop();
    }
  })();

  try {
    for (const snapshot of snapshots) {
      // Three writers on one file: a clear racing a save is the shape of an
      // abort racing the next turn's start.
      await Promise.all([
        saveLiveState(stateFile, snapshot),
        clearLiveState(stateFile),
        saveLiveState(stateFile, snapshot),
      ]);
      await yieldToLoop(); // the reader gets a turn inside every round
    }
  } finally {
    stop = true;
    await reader;
  }

  assert.deepEqual(
    torn.slice(0, 3),
    [],
    `torn state observed ${torn.length} time(s) across ${snapshots.length} rounds`,
  );
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    [],
    "every temp file is renamed, none is left behind",
  );
  const final = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.ok(
    whole.has(JSON.stringify(final)),
    "the surviving state is one whole written snapshot",
  );
  rmSync(dir, { recursive: true, force: true });
});

// ── terminate (§5b-2: abort/error turns release the indicator) ──────────────

test("terminate: edits tracked → '⏹️ Turn ended without a report', clears state (state file washed out)", async () => {
  const { dir, stateFile } = tmpStateFile("terminate");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.start();
  const out = await tracker.terminate();

  assert.equal(out.terminated, true);
  assert.equal(out.terminalEdited, true);
  assert.equal(
    stub.edits.length,
    1,
    "exactly one edit (to the terminal state)",
  );
  assert.equal(stub.edits[0].messageId, 1001);
  assert.equal(stub.edits[0].text, TRACKED_TERMINAL_TEXT);
  assert.equal(
    stub.sends.length,
    1,
    "no summary on a no-report turn — only the tracked Working… send",
  );

  assert.equal(
    await tracker.isActive(),
    false,
    "indicator released after terminate",
  );
  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(persisted.messageId, 0, "state file cleared after terminate");
  rmSync(dir, { recursive: true, force: true });
});

// ── activity refcount + never-freeze safety-net (owner report) ──────────────
// The "⚙️ Working…" indicator is gated on an ACTIVE-WORK counter: begin()
// (0→1) pins the tracked message, end() (1→0) resolves it to the honest
// terminal state, and settle() forces an honest completion at an idle/settled
// boundary when the work ended WITHOUT any completion call — so the indicator
// NEVER freezes at "Working…" even when the agent never calls a finalize path.

test("activity: begin() 0→1 pins Working; a second unit reuses; end() 1→0 resolves to ✅ Done + summary (0→1→0)", async () => {
  const { dir, stateFile } = tmpStateFile("activity-cycle");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  assert.equal(tracker.activeCount(), 0, "idle → no active work");
  const b1 = await tracker.begin(); // unit 1 starts
  assert.equal(b1.started, true);
  assert.equal(b1.reused, false);
  assert.equal(tracker.activeCount(), 1, "0→1 increments");
  assert.equal(stub.sends.length, 1, "first begin pins the Working… message");
  assert.equal(stub.sends[0].text, TRACKED_START_TEXT);

  const b2 = await tracker.begin(); // unit 2 starts while unit 1 is in flight
  assert.equal(tracker.activeCount(), 2, "second unit keeps the counter at 2");
  assert.equal(
    stub.sends.length,
    1,
    "second begin does NOT re-send — the indicator is already pinned",
  );
  assert.equal(b2.reused, true);

  const e1 = await tracker.end("done", { resultText: "unit one done" });
  assert.equal(
    e1.ended,
    false,
    "2→1 does NOT resolve — another unit is still active",
  );
  assert.equal(e1.active, 1);
  assert.equal(
    stub.edits.length,
    0,
    "indicator stays Working… while a unit remains",
  );

  const e2 = await tracker.end("done", { resultText: "the final answer" });
  assert.equal(e2.ended, true, "1→0 resolves the cycle");
  assert.equal(e2.active, 0);
  assert.equal(tracker.activeCount(), 0, "counter back to 0");
  assert.equal(stub.edits.length, 1, "resolved via a single done-edit");
  assert.equal(stub.edits[0].messageId, 1001);
  assert.equal(stub.edits[0].text, TRACKED_DONE_TEXT);
  assert.equal(stub.sends.length, 2, "Working… + final summary");
  assert.equal(
    stub.sends[1].text,
    "the final answer",
    "last completed unit's text becomes the summary",
  );
  assert.equal(
    await tracker.isActive(),
    false,
    "tracked state cleared after resolve",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("activity: an in-flight unit (no end yet) keeps the indicator active — toolUse semantics", async () => {
  const { dir, stateFile } = tmpStateFile("activity-inflight");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.begin();
  assert.equal(tracker.activeCount(), 1, "work in flight");
  assert.equal(await tracker.isActive(), true, "indicator active");
  assert.equal(
    stub.edits.length,
    0,
    "mid-work the indicator is still the pinned Working… (never cleared mid-tool)",
  );
  assert.equal(stub.sends.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("activity: end('no-report') on 1→0 resolves to the ⏹ terminal state — no summary, state cleared (§5b-2)", async () => {
  const { dir, stateFile } = tmpStateFile("activity-noreport");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.begin();
  const out = await tracker.end("no-report");

  assert.equal(out.ended, true);
  assert.equal(out.terminalEdited, true);
  assert.equal(tracker.activeCount(), 0);
  assert.equal(
    stub.edits.length,
    1,
    "exactly one edit (to the terminal state)",
  );
  assert.equal(
    stub.edits[0].text,
    TRACKED_TERMINAL_TEXT,
    "terminal edit, never ✅ Done",
  );
  assert.equal(stub.sends.length, 1, "no summary on a no-report turn");
  assert.equal(
    await tracker.isActive(),
    false,
    "state cleared after terminal resolve",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("settle: work finished WITHOUT any completion call → forced to ✅ Done — the indicator NEVER freezes (owner-report regression)", async () => {
  const { dir, stateFile } = tmpStateFile("settle-freeze");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.begin(); // inbound work pinned "Working…"
  assert.equal(stub.sends.length, 1);
  assert.equal(stub.sends[0].text, TRACKED_START_TEXT);

  // The agent's turn ends WITHOUT any completion path (no finish, no terminate,
  // no end) — the exact owner-reported freeze. Pre-fix: settle() does not exist
  // (or is not wired), so the indicator is stuck at Working… forever.
  assert.equal(stub.edits.length, 0, "pre-fix: still frozen at Working…");
  assert.equal(
    await tracker.isActive(),
    true,
    "pre-fix: tracked message still active/frozen",
  );

  // At the settled/idle boundary the safety-net forces the honest completion.
  const out = await tracker.settle();
  assert.equal(out.resolved, true, "settle resolved the frozen indicator");
  assert.equal(out.reason, "resolved");
  assert.equal(tracker.activeCount(), 0);
  assert.equal(stub.edits.length, 1, "forced exactly one done-edit");
  assert.equal(
    stub.edits[0].text,
    TRACKED_DONE_TEXT,
    "settle forces ✅ Done, never leaves Working…",
  );
  assert.equal(
    await tracker.isActive(),
    false,
    "state cleared — a reload cannot resurrect Working…",
  );

  const again = await tracker.settle();
  assert.equal(
    again.resolved,
    false,
    "already resolved → no second forced edit",
  );
  assert.equal(again.reason, "already-resolved");
  assert.equal(stub.edits.length, 1, "no duplicate done-edit");
  rmSync(dir, { recursive: true, force: true });
});

test("settle: does NOT force while more inbound work may continue (mayContinue) — counter untouched", async () => {
  const { dir, stateFile } = tmpStateFile("settle-maycontinue");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.begin(); // a queued inbound message starts immediately after this boundary
  const out = await tracker.settle({ mayContinue: true });
  assert.equal(
    out.resolved,
    false,
    "not forced while more inbound work is queued",
  );
  assert.equal(out.reason, "might-continue");
  assert.equal(
    tracker.activeCount(),
    1,
    "counter untouched — work still in flight",
  );
  assert.equal(await tracker.isActive(), true, "indicator still active");
  assert.equal(stub.edits.length, 0, "no forced edit while work continues");
  assert.equal(stub.sends.length, 1, "Working… still pinned");

  // Once that work REALLY completes → normal 1→0 resolution.
  await tracker.end("done", { resultText: "real completion" });
  assert.equal(stub.edits.length, 1);
  assert.equal(stub.edits[0].text, TRACKED_DONE_TEXT);
  rmSync(dir, { recursive: true, force: true });
});

test("settle: preserves the ⏹ terminal outcome on the safety-net path (honest, never a fake ✅)", async () => {
  const { dir, stateFile } = tmpStateFile("settle-noreport");
  const stub = makeStub();
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  await tracker.begin();
  await tracker.begin(); // two units; one ends as no-report, the other never reports
  await tracker.end("no-report"); // 2→1 — does NOT resolve yet
  assert.equal(tracker.activeCount(), 1, "still one unit in flight");

  const out = await tracker.settle(); // agent settles idle — force the honest state
  assert.equal(out.resolved, true, "forced on the safety-net path");
  assert.equal(out.terminalEdited, true);
  assert.equal(stub.edits.length, 1);
  assert.equal(
    stub.edits[0].text,
    TRACKED_TERMINAL_TEXT,
    "terminal outcome preserved — never fake ✅ Done",
  );
  assert.equal(stub.sends.length, 1, "no summary on the terminal path");
  assert.equal(
    await tracker.isActive(),
    false,
    "state cleared after terminal resolve",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("settle: resurrected stale pinned message (no active work this session) → forced ⏹ terminal, never a frozen Working…", async () => {
  const { dir, stateFile } = tmpStateFile("settle-resurrected");
  const stub = makeStub();
  // Simulate a crash-left pending state file (prior run's Working… never cleared).
  await saveLiveState(stateFile, {
    messageId: 42,
    chatId: OWNER_CHAT_ID,
    startedAt: 1,
  });
  const tracker = createLiveUpdateTracker({
    client: stub.client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  assert.equal(
    await tracker.isActive(),
    true,
    "stale Working… resumed from disk",
  );
  const out = await tracker.settle();
  assert.equal(
    out.resolved,
    true,
    "resurrected stale indicator is resolved — never freezes",
  );
  assert.equal(out.terminalEdited, true);
  assert.equal(stub.edits.length, 1);
  assert.equal(
    stub.edits[0].text,
    TRACKED_TERMINAL_TEXT,
    "turn ended without a report → ⏹, not a fake ✅",
  );
  assert.equal(
    await tracker.isActive(),
    false,
    "state cleared — no resurrectable Working…",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("terminate: still clears the persisted state when the terminal edit fails (best-effort, non-throwing)", async () => {
  const { dir, stateFile } = tmpStateFile("terminate-editfail");
  const client = {
    sendMessage: async () => ({ ok: false }),
    editMessageText: async () => ({
      ok: false,
      error: "message is not modified",
    }),
  };
  // Simulate a crash-left stale state file: a reload must never resurrect it.
  await saveLiveState(stateFile, {
    messageId: 42,
    chatId: OWNER_CHAT_ID,
    startedAt: 1,
  });
  const tracker = createLiveUpdateTracker({
    client,
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    stateFile,
  });

  const out = await tracker.terminate();

  assert.equal(out.terminated, true);
  assert.equal(
    out.terminalEdited,
    false,
    "edit failed — terminate still resolves (non-throwing)",
  );
  assert.equal(
    await tracker.isActive(),
    false,
    "stale state never resurrects a Working… message",
  );
  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(
    persisted.messageId,
    0,
    "stale persisted state always cleared after terminate",
  );
  rmSync(dir, { recursive: true, force: true });
});
