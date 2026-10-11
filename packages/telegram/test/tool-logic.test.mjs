/**
 * tool-logic.test.mjs — telegram_send param validation, concise enforcement,
 * and delivery orchestration against a stubbed client. NO network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  enforceConcise,
  validateSendParams,
  runTelegramSend,
} from "../dist/lib/tool-logic.js";
import { DEFAULT_SEND_MAX_CHARS } from "../dist/lib/telegram-settings.js";
import {
  clearAgentDeliveredMessage,
  wasAgentDeliveredMessage,
} from "../dist/lib/notify/agent-delivery.js";

import { BOT_TOKEN, OWNER_CHAT_ID } from "./fixtures.mjs";

// Default plain-path cap (4096 = braid.telegram.sendMaxChars fallback).
const N = DEFAULT_SEND_MAX_CHARS;

function fakeClient({ onSendMessage, onSendVoiceNote } = {}) {
  const calls = { sendMessage: [], sendVoiceNote: [] };
  const state = { ignore: false };
  return {
    calls,
    get ignore() {
      return state.ignore;
    },
    set ignore(v) {
      state.ignore = v;
    },
    client: {
      sendMessage: async (token, chatId, text) => {
        calls.sendMessage.push({ token, chatId, text });
        if (onSendMessage) return onSendMessage({ token, chatId, text });
        if (state.ignore) return { ok: false, error: "injected failure" };
        return { ok: true, messageId: 42 };
      },
      sendVoiceNote: async (token, chatId, ogg, caption) => {
        calls.sendVoiceNote.push({ token, chatId, ogg, caption });
        if (onSendVoiceNote)
          return onSendVoiceNote({ token, chatId, ogg, caption });
        return { ok: true, messageId: 77 };
      },
    },
  };
}

test("validateSendParams: refuses undefined / empty / whitespace text", () => {
  for (const bad of [
    undefined,
    {},
    { text: "" },
    { text: "   " },
    { text: "\n\t" },
  ]) {
    const r = validateSendParams(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test("defaults: the send cap is 4096 (Telegram's per-message limit)", () => {
  assert.equal(DEFAULT_SEND_MAX_CHARS, 4096);
});

// The plain-path cap is settings-driven (braid.telegram.sendMaxChars,
// 4096 fallback) — index.ts resolves it per call and passes it as
// `sendMaxChars`. These pin the seam behavior and explicit-limit precedence.

test("runTelegramSend: sendMaxChars:300 caps the plain path — over it without a choice → ERROR naming 300", async () => {
  const { client, calls } = fakeClient();
  const outcome = await runTelegramSend(
    { text: "x".repeat(400) },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, sendMaxChars: 300 },
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /limit is 300/);
  assert.match(outcome.error ?? "", /NOTHING was sent/);
  assert.equal(calls.sendMessage.length, 0);
});

test("runTelegramSend: sendMaxChars:300 — a 250-char body sends verbatim", async () => {
  const { client, calls } = fakeClient();
  const body = "y".repeat(250);
  const outcome = await runTelegramSend(
    { text: body },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, sendMaxChars: 300 },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.truncated, false);
  assert.equal(calls.sendMessage[0].text, body);
});

test("runTelegramSend: an explicit limit overrides the settings cap", async () => {
  const { client, calls } = fakeClient();
  const body = "z".repeat(500);
  const outcome = await runTelegramSend(
    { text: body, limit: 1000 },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, sendMaxChars: 300 },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.truncated, false);
  assert.equal(calls.sendMessage[0].text, body);
});

test("enforceConcise: leaves ≤ cap untouched", () => {
  const short = "a".repeat(N);
  const r = enforceConcise(short);
  assert.equal(r.text, short);
  assert.equal(r.truncated, false);
});

test("enforceConcise: truncates > cap with an ellipsis and flags it", () => {
  const long = "a".repeat(N + 50);
  const r = enforceConcise(long);
  assert.equal(r.text.length, N);
  assert.equal(r.truncated, true);
  assert.ok(r.text.endsWith("…"));
});

test("runTelegramSend: malformed explicit limit / strategy are refused, never ignored", async () => {
  const { client, calls } = fakeClient();
  const badLimit = await runTelegramSend(
    { text: "hi", limit: -5 },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(badLimit.ok, false);
  assert.match(badLimit.error ?? "", /limit/);
  const badStrategy = await runTelegramSend(
    { text: "hi", strategy: "bogus" },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(badStrategy.ok, false);
  assert.match(badStrategy.error ?? "", /strategy/);
  assert.equal(
    calls.sendMessage.length,
    0,
    "nothing sent for malformed explicit params",
  );
});

// The [tg-end] marker is an INBOUND parse boundary only (owner, Aug 9):
// outbound sends the raw trimmed text verbatim, never the marker. The
// delivery tests below pin that with negative assertions.

test("runTelegramSend: delivers text and returns message_id", async () => {
  const { client, calls } = fakeClient();
  const outcome = await runTelegramSend(
    { text: "hello owner" },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.messageId, 42);
  assert.equal(outcome.channel, "text");
  assert.equal(outcome.truncated, false);
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.sendMessage[0].token, BOT_TOKEN);
  assert.equal(calls.sendMessage[0].chatId, OWNER_CHAT_ID);
  // Outbound carries NO end marker (marker is inbound-only, item 20): raw
  // trimmed text verbatim.
  assert.equal(calls.sendMessage[0].text, `hello owner`);
  assert.ok(
    !calls.sendMessage[0].text.includes("[tg-end]"),
    "outbound must NOT carry the inbound-only [tg-end] marker",
  );
});

// Poller-liveness guard: a successful send
// while the inbound poller is dead must WARN on the outcome — the owner's
// reply would never be consumed. ok:false outcomes stay untouched.
test("runTelegramSend: poller OFF warns on success, stays silent on failure and when running", async () => {
  const { client } = fakeClient();
  const ok = await runTelegramSend(
    { text: "hello" },
    {
      client,
      token: BOT_TOKEN,
      chatId: OWNER_CHAT_ID,
      pollerRunning: () => false,
    },
  );
  assert.equal(ok.ok, true);
  assert.match(ok.warn ?? "", /inbound poller OFF/);
  assert.match(ok.warn ?? "", /telegram_poller/);

  const running = await runTelegramSend(
    { text: "hello owner" },
    {
      client,
      token: BOT_TOKEN,
      chatId: OWNER_CHAT_ID,
      pollerRunning: () => true,
    },
  );
  assert.equal(running.ok, true);
  assert.equal(running.warn, undefined);

  const failed = fakeClient({
    onSendMessage: () => ({ ok: false, error: "boom" }),
  });
  const failOutcome = await runTelegramSend(
    { text: "hello owner" },
    {
      client: failed.client,
      token: BOT_TOKEN,
      chatId: OWNER_CHAT_ID,
      pollerRunning: () => false,
    },
  );
  assert.equal(failOutcome.ok, false);
  assert.equal(failOutcome.warn, undefined);

  // Absent check dep = legacy behavior, no warning.
  const noDep = await runTelegramSend(
    { text: "hello owner" },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(noDep.ok, true);
  assert.equal(noDep.warn, undefined);
});

// Truncation contract: over-limit without an
// explicit choice = ERROR result + NOTHING sent. The crafting model distills
// first (LLM rewrite); only an explicit strategy:"truncate" hard-truncates.

test("runTelegramSend: over-limit without explicit choice → ERROR, nothing sent (no silent truncate)", async () => {
  const { client, calls } = fakeClient();
  const long = "b".repeat(N + 100);
  const outcome = await runTelegramSend(
    { text: long },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(
    outcome.ok,
    false,
    "over-limit without an explicit choice must NOT send",
  );
  assert.equal(outcome.truncated, false);
  assert.match(outcome.error ?? "", /limit/i);
  assert.match(outcome.error ?? "", /NOTHING was sent/);
  assert.equal(
    calls.sendMessage.length,
    0,
    "nothing sent on the over-limit default error",
  );
  // The error names the options (rich / shorter / explicit strategy).
  assert.match(outcome.error ?? "", /rich:true/);
  assert.match(outcome.error ?? "", /strategy:"truncate"/);
});

test("runTelegramSend: explicit strategy:'truncate' → hard-truncated to the limit and sent", async () => {
  const { client, calls } = fakeClient();
  const long = "b".repeat(N + 100);
  const outcome = await runTelegramSend(
    { text: long, strategy: "truncate" },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, sendMaxChars: N },
  );
  assert.equal(outcome.ok, true);
  assert.equal(
    outcome.truncated,
    true,
    "explicit truncate flags the shortening",
  );
  assert.ok(outcome.warn);
  assert.equal(calls.sendMessage[0].text, "b".repeat(N - 1) + "…");
  assert.match(outcome.warn, /truncate/);
});

test("runTelegramSend: explicit strategy:'truncate' skips crafting (user chose truncate, not a rewrite)", async () => {
  const { client, calls } = fakeClient();
  let craftCalls = 0;
  const craft = async () => {
    craftCalls++;
    return { text: "crafted", crafted: true };
  };
  const outcome = await runTelegramSend(
    { text: "a".repeat(N + 10), strategy: "truncate" },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, craft, sendMaxChars: N },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.truncated, true);
  assert.equal(craftCalls, 0, "no LLM rewrite when the strategy is explicit");
  assert.equal(calls.sendMessage[0].text, "a".repeat(N - 1) + "…");
});

test("runTelegramSend: explicit strategy:'error' → error, nothing sent, even though craft could run", async () => {
  const { client, calls } = fakeClient();
  let craftCalls = 0;
  const craft = async () => {
    craftCalls++;
    return { text: "crafted short", crafted: true };
  };
  const outcome = await runTelegramSend(
    { text: "a".repeat(N + 10), strategy: "error" },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, craft },
  );
  assert.equal(outcome.ok, false);
  assert.equal(craftCalls, 0, "explicit error strategy skips crafting");
  assert.equal(calls.sendMessage.length, 0);
  assert.match(outcome.error ?? "", /NOTHING was sent/);
});

test("runTelegramSend: explicit limit honored — text within the limit sends verbatim (no crafting)", async () => {
  const rc = recordingClient();
  let craftCalls = 0;
  const craft = async () => {
    craftCalls++;
    return { text: "crafted", crafted: true };
  };
  const body = "c".repeat(500); // 500 chars — under the explicit limit of 1000
  const outcome = await runTelegramSend(
    { text: body, limit: 1000 },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, craft },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.truncated, false);
  assert.equal(
    craftCalls,
    0,
    "within an explicit limit there is nothing to distill",
  );
  assert.equal(
    rc.calls[0].text,
    body,
    "verbatim delivery up to the explicit limit",
  );
});

test("runTelegramSend: explicit limit honored — over it without strategy → error stating THE limit", async () => {
  const { client, calls } = fakeClient();
  const body = "d".repeat(1200);
  const outcome = await runTelegramSend(
    { text: body, limit: 1000 },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /limit is 1000/);
  assert.match(outcome.error ?? "", /NOTHING was sent/);
  assert.equal(calls.sendMessage.length, 0);
});

test("runTelegramSend: crafted result that still exceeds the limit → error (no truncate of the craft)", async () => {
  const { client, calls } = fakeClient();
  const craft = async () => ({ text: "e".repeat(N + 5), crafted: true });
  const outcome = await runTelegramSend(
    { text: "a".repeat(N + 50) },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, craft },
  );
  assert.equal(
    outcome.ok,
    false,
    "distillation failure is an error, never a silent truncate",
  );
  assert.equal(calls.sendMessage.length, 0);
});

test("runTelegramSend: craft hook replaces dumb truncate — crafted text is delivered", async () => {
  const { client, calls } = fakeClient();
  const craftCalls = [];
  const craft = async (text) => {
    craftCalls.push(text);
    return { text: "distilled: the long message, concise", crafted: true };
  };
  const outcome = await runTelegramSend(
    { text: "a".repeat(N + 100) },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, craft },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.truncated, false);
  assert.equal(craftCalls.length, 1);
  assert.equal(
    calls.sendMessage[0].text,
    "distilled: the long message, concise",
  );
  assert.ok(
    !calls.sendMessage[0].text.includes("[tg-end]"),
    "crafted outbound must not carry the inbound-only marker",
  );
});

test("runTelegramSend: craft returning null (model unavailable) → ERROR, nothing sent (A1)", async () => {
  const { client, calls } = fakeClient();
  const craft = async () => null; // model unavailable
  const long = "c".repeat(N + 50);
  const outcome = await runTelegramSend(
    { text: long },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, craft },
  );
  assert.equal(
    outcome.ok,
    false,
    "no silent truncate when crafting is unavailable",
  );
  assert.match(outcome.error ?? "", /NOTHING was sent/);
  assert.equal(calls.sendMessage.length, 0);
});

test("runTelegramSend: a throwing craft hook → ERROR, nothing sent (A1)", async () => {
  const { client, calls } = fakeClient();
  const craft = async () => {
    throw new Error("LLM down");
  };
  const long = "d".repeat(N + 25);
  const outcome = await runTelegramSend(
    { text: long },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, craft },
  );
  assert.equal(
    outcome.ok,
    false,
    "crafting failure must not silently truncate",
  );
  assert.match(outcome.error ?? "", /NOTHING was sent/);
  assert.equal(calls.sendMessage.length, 0);
});

test("runTelegramSend: short text skips crafting entirely (verbatim delivery)", async () => {
  const { client, calls } = fakeClient();
  let craftCalls = 0;
  const craft = async () => {
    craftCalls++;
    return { text: "x", crafted: true };
  };
  await runTelegramSend(
    { text: "hi owner" },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, craft },
  );
  assert.equal(craftCalls, 0, "no model call for already-concise text");
  assert.equal(calls.sendMessage[0].text, "hi owner");
});

test("runTelegramSend: refuses empty text before any send", async () => {
  const { client, calls } = fakeClient();
  const outcome = await runTelegramSend(
    { text: "" },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /text.*required/i);
  assert.equal(calls.sendMessage.length, 0);
});

test("runTelegramSend: surfaces a delivery failure (not a throw)", async () => {
  const fc = fakeClient();
  fc.ignore = true; // client will fail the send
  const outcome = await runTelegramSend(
    { text: "will fail" },
    { client: fc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /injected failure/);
});

test("runTelegramSend: voice without a configured TTS is refused with a clear error", async () => {
  const { client, calls } = fakeClient();
  const outcome = await runTelegramSend(
    { text: "important", voice: true, voiceText: "read this aloud" },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID }, // tts omitted
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /TTS|voice/i);
  assert.equal(calls.sendMessage.length, 0);
  assert.equal(calls.sendVoiceNote.length, 0);
});

test("runTelegramSend: voice with a TTS hook synthesizes OGG and calls sendVoiceNote", async () => {
  const { client, calls } = fakeClient();
  const tts = { synthesize: async (text) => Buffer.from(`OGG:${text}`) };
  const outcome = await runTelegramSend(
    {
      text: "summary",
      voice: true,
      voiceText: "this is the long read-aloud text",
    },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, tts },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.messageId, 77);
  assert.equal(outcome.channel, "voice");
  assert.equal(calls.sendMessage.length, 0);
  assert.equal(calls.sendVoiceNote.length, 1);
  const sent = calls.sendVoiceNote[0];
  assert.equal(sent.token, BOT_TOKEN);
  assert.equal(sent.chatId, OWNER_CHAT_ID);
  assert.equal(sent.caption, "summary"); // concise text is used as the caption
  assert.ok(sent.ogg instanceof Buffer);
  assert.ok(sent.ogg.toString().startsWith("OGG:"));
});

test("runTelegramSend: voice with tts but voiceText falls back to the concise text", async () => {
  const { client, calls } = fakeClient();
  const tts = { synthesize: async (text) => Buffer.from(`OGG:${text}`) };
  const outcome = await runTelegramSend(
    { text: "short summary", voice: true },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, tts },
  );
  assert.equal(outcome.ok, true);
  assert.equal(calls.sendVoiceNote[0].caption, "short summary");
  assert.ok(calls.sendVoiceNote[0].ogg.toString().startsWith("OGG:"));
});

// ── Rich formatted / split messages (item 31) ───────────────────────────────

/** Recording client that captures the 4th arg (options) — used for parse_mode assertions. */
function recordingClient() {
  const calls = [];
  let seq = 100;
  return {
    calls,
    client: {
      sendMessage: async (token, chatId, text, options = {}) => {
        calls.push({ kind: "send", token, chatId, text, options });
        return { ok: true, messageId: ++seq };
      },
      sendVoiceNote: async (token, chatId, ogg, caption, options = {}) => {
        calls.push({ kind: "voice", token, chatId, ogg, caption, options });
        return { ok: true, messageId: 77 };
      },
    },
  };
}

function longRichText() {
  return Array.from(
    { length: 200 },
    (_, i) => `line ${i} ` + "z".repeat(30),
  ).join("\n");
}

test("runTelegramSend: rich:true bypasses the default cap — no truncation, no crafting, split-to-fit", async () => {
  const rc = recordingClient();
  let craftCalls = 0;
  const craft = async () => {
    craftCalls++;
    return { text: "crafted", crafted: true };
  };
  const outcome = await runTelegramSend(
    { text: longRichText(), rich: true },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, craft },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.truncated, false);
  assert.equal(craftCalls, 0, "no LLM crafting in rich mode");
  assert.ok(
    (outcome.chunks ?? 1) > 1,
    "long rich text is split across messages",
  );
  assert.equal(rc.calls.length, outcome.chunks);
  for (const call of rc.calls) {
    assert.match(
      call.text,
      /\(\d+\/\d+\)$/,
      "continuity marker on every chunk",
    );
  }
  assert.equal(typeof outcome.messageId, "number");
});

test("runTelegramSend: rich:true short message → single send (chunks:1), no craft, verbatim", async () => {
  const rc = recordingClient();
  const outcome = await runTelegramSend(
    { text: "**short rich**", rich: true, parse_mode: "Markdown" },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.chunks, 1);
  assert.equal(rc.calls.length, 1);
  assert.equal(rc.calls[0].text, "**short rich**");
  assert.ok(
    !rc.calls[0].text.includes("(1/1)"),
    "no marker on a single message",
  );
});

test("runTelegramSend: rich:true honors parse_mode HTML on every chunk", async () => {
  const rc = recordingClient();
  const outcome = await runTelegramSend(
    { text: longRichText(), rich: true, parse_mode: "HTML" },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.chunks, rc.calls.length);
  assert.ok(rc.calls.every((c) => c.options.parseMode === "HTML"));
});

test("runTelegramSend: default path passes parse_mode through on a short send", async () => {
  const rc = recordingClient();
  const outcome = await runTelegramSend(
    { text: "**heads up** — short", parse_mode: "Markdown" },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(rc.calls[0].options.parseMode, "Markdown");
});

test("runTelegramSend: Markdown parse_mode is dropped (plain text) when delimiters are unbalanced", async () => {
  const rc = recordingClient();
  const outcome = await runTelegramSend(
    { text: "_italic never closed", parse_mode: "Markdown" },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(
    rc.calls[0].options.parseMode,
    undefined,
    "imbalanced markdown → plain, never an API error",
  );
});

test("runTelegramSend: rich + unbalanced markdown → parse_mode dropped with a warn", async () => {
  const rc = recordingClient();
  const outcome = await runTelegramSend(
    { text: "some _unbalanced text", rich: true, parse_mode: "Markdown" },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(rc.calls[0].options.parseMode, undefined);
  assert.match(outcome.warn, /unbalanced/);
});

test("runTelegramSend: an invalid parse_mode value is ignored (plain text, no throw)", async () => {
  const rc = recordingClient();
  const outcome = await runTelegramSend(
    { text: "hi", parse_mode: "Bogus" },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(rc.calls[0].options.parseMode, undefined);
});

test("runTelegramSend: rich + voice keeps the voice path (rich text used as the caption source)", async () => {
  const rc = recordingClient();
  const tts = { synthesize: async (text) => Buffer.from(`OGG:${text}`) };
  const outcome = await runTelegramSend(
    { text: "short voice note", rich: true, voice: true },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID, tts },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.channel, "voice");
  assert.equal(rc.calls[0].kind, "voice");
  assert.equal(rc.calls[0].caption, "short voice note");
});

// ── cross-mode delivery (Task C): parse_mode sanitizes the body to its format ──

test("runTelegramSend: HTML body + parse_mode HTML → clean HTML render (tags live, parseMode HTML)", async () => {
  const rc = recordingClient();
  const outcome = await runTelegramSend(
    { text: "see <b>bold</b> and <i>italic</i>", parse_mode: "HTML" },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(rc.calls[0].options.parseMode, "HTML");
  assert.equal(
    rc.calls[0].text,
    "see <b>bold</b> and <i>italic</i>",
    "HTML tags stay live in HTML mode",
  );
});

test("runTelegramSend: HTML body + parse_mode Markdown → tags stripped, no raw-tag leak", async () => {
  const rc = recordingClient();
  const outcome = await runTelegramSend(
    { text: "<b>bold</b> and <i>italic</i>", parse_mode: "Markdown" },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(rc.calls[0].options.parseMode, "Markdown");
  assert.equal(
    rc.calls[0].text,
    "bold and italic",
    "raw HTML tags must not reach the wire",
  );
  assert.ok(!rc.calls[0].text.includes("<"), "no raw tag characters delivered");
});

test("runTelegramSend: HTML body + no parse_mode → auto-selects HTML (old leak fixed)", async () => {
  const rc = recordingClient();
  const outcome = await runTelegramSend(
    { text: "<b>bold</b> summary", rich: true },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(
    rc.calls[0].options.parseMode,
    "HTML",
    "HTML body auto-selects HTML mode",
  );
  assert.equal(rc.calls[0].text, "<b>bold</b> summary");
});

test("runTelegramSend: Markdown body + parse_mode HTML → markers neutralized, no raw ** leak", async () => {
  const rc = recordingClient();
  const outcome = await runTelegramSend(
    { text: "**bold** and `code`", parse_mode: "HTML" },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(rc.calls[0].options.parseMode, "HTML");
  assert.equal(
    rc.calls[0].text,
    "bold and code",
    "markdown markers neutralized in HTML mode",
  );
  assert.ok(!rc.calls[0].text.includes("**"), "no raw ** on an HTML wire");
});

test("runTelegramSend: mixed cross-mode body → sanitized so nothing leaks raw", async () => {
  const rc = recordingClient();
  const outcome = await runTelegramSend(
    { text: "**md bold** and <i>html italic</i>", rich: true },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(
    rc.calls[0].options.parseMode,
    "HTML",
    "mixed body with tags ships as HTML",
  );
  assert.equal(rc.calls[0].text, "md bold and <i>html italic</i>");
  assert.ok(!rc.calls[0].text.includes("**"), "markdown token neutralized");
});

test("runTelegramSend: Markdown body + parse_mode Markdown stays clean (regression guard)", async () => {
  const rc = recordingClient();
  const outcome = await runTelegramSend(
    { text: "**bold** and _italic_ and `code`", parse_mode: "Markdown" },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(rc.calls[0].options.parseMode, "Markdown");
  assert.equal(
    rc.calls[0].text,
    "**bold** and _italic_ and `code`",
    "markdown stays verbatim in Markdown mode",
  );
});

test("runTelegramSend: rich HTML body with long text → every chunk is HTML mode, no leaks", async () => {
  const rc = recordingClient();
  const htmlLong = Array.from(
    { length: 200 },
    (_, i) => `<b>line ${i}</b> content`,
  ).join("\n");
  const outcome = await runTelegramSend(
    { text: htmlLong, rich: true, parse_mode: "HTML" },
    { client: rc.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.ok(rc.calls.length > 1, "long html body split");
  assert.ok(
    rc.calls.every((c) => c.options.parseMode === "HTML"),
    "every chunk HTML mode",
  );
  assert.ok(
    rc.calls.every((c) => /<b>/.test(c.text)),
    "HTML tags preserved across chunks (no leak)",
  );
});

// ── agent-delivery flag (owner double-message fix) ─────────────────────────

test("runTelegramSend: successful concise send marks the agent-delivered flag", async () => {
  clearAgentDeliveredMessage();
  const f = fakeClient();
  const outcome = await runTelegramSend(
    { text: "hello owner" },
    { client: f.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(
    wasAgentDeliveredMessage(),
    true,
    "delivery marked — live-update will suppress its auto summary",
  );
});

test("runTelegramSend: failed send does NOT mark the flag", async () => {
  clearAgentDeliveredMessage();
  const f = fakeClient();
  f.ignore = true;
  const outcome = await runTelegramSend(
    { text: "hello owner" },
    { client: f.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, false);
  assert.equal(
    wasAgentDeliveredMessage(),
    false,
    "no delivery — nothing to suppress",
  );
});

test("runTelegramSend: rich HTML send marks the flag", async () => {
  clearAgentDeliveredMessage();
  const f = fakeClient();
  const outcome = await runTelegramSend(
    { text: "<b>Отчёт</b> готов", rich: true, parse_mode: "HTML" },
    { client: f.client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(wasAgentDeliveredMessage(), true);
  clearAgentDeliveredMessage();
});
