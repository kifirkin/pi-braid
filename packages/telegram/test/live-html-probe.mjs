/**
 * Live HTML parse probe — opt-in, no delivery by default.
 *
 * Validates the local checker (`dist/lib/html-check.js`) against the live API
 * and re-verifies the corpus wires the fixes changed. Every case is sent with
 * `parse_mode: "HTML"` to an UNDELIVERABLE chat id: Telegram parses entities
 * before validating the chat, so `chat not found` means "the body parses" and
 * a `can't parse entities: …` error means "rejected" — no message reaches the
 * owner. `--deliver` additionally sends ONE marked digest of the accepted
 * shapes to `TELEGRAM_CHAT_ID` to confirm the real-chat path.
 *
 * Usage (never run by `npm test`):
 *   TELEGRAM_BOT_TOKEN=… node test/live-html-probe.mjs
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… node test/live-html-probe.mjs --deliver
 *
 * Exits 1 on any checker/live disagreement or on a post-fix wire Telegram
 * rejects; the live side wins (a disagreement is a checker finding).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sendMessage } from "../dist/lib/telegram-client.js";
import { checkTelegramHtml } from "../dist/lib/html-check.js";
import { resolveDeliveryFormat } from "../dist/lib/format.js";
import {
  HOSTILE_CASES,
  HTML_PARSE_CASES,
  VERDICT_WIRES,
} from "./fixtures/telegram-format-corpus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures", "telegram-format-baseline.json"),
    "utf8",
  ),
);
const INVALID_CHAT = "999999999999";
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error(
    "live-html-probe: TELEGRAM_BOT_TOKEN is not set — this probe is opt-in and never runs in `npm test`.",
  );
  process.exit(2);
}

async function verdictFor(wire, parseMode) {
  const result = await sendMessage(token, INVALID_CHAT, wire, { parseMode });
  if (result.ok) return "UNEXPECTED-OK";
  return /chat not found|not enough rights|did you mean/i.test(
    result.error ?? "",
  )
    ? "PARSES"
    : "REJECTED";
}

const requestedModes = [undefined, "Markdown", "HTML"];
const label = (requested) => (requested === undefined ? "none" : requested);

// ── build the probe list ────────────────────────────────────────────────────
const cases = [];
for (const { name, body, verdict } of HTML_PARSE_CASES) {
  cases.push({
    name: `checker: ${name}`,
    wire: body,
    parseMode: "HTML",
    expect: verdict,
  });
}
for (const { name, wire, parseMode, verdict } of VERDICT_WIRES) {
  if (parseMode !== "HTML") continue; // Markdown/MarkdownV2 rows carry no checker
  cases.push({ name: `verdict: ${name}`, wire, parseMode, expect: verdict });
}
for (const { name, body } of HOSTILE_CASES) {
  for (const requested of requestedModes) {
    const format = resolveDeliveryFormat(requested, body);
    const base = BASELINE.cases[name]?.find(
      (entry) => entry.requested === label(requested),
    );
    const changed =
      !base ||
      base.mode !== (format.parseMode ?? "plain") ||
      base.text !== format.text;
    if (!changed) continue;
    const mode = format.parseMode ?? "plain";
    const preInvalid =
      base?.mode === "HTML" && !checkTelegramHtml(base.text).ok;
    // HTML wires must satisfy the checker, except where the wire was already
    // unparseable in that mode (a pre-existing defect, not a fix).
    const expect =
      mode === "HTML"
        ? preInvalid
          ? verdictForLocal(format.text)
          : "PARSES"
        : mode === "Markdown"
          ? "PARSES"
          : undefined;
    if (expect === undefined) continue;
    cases.push({
      name: `changed ${name} [${label(requested)}]`,
      wire: format.text,
      parseMode: mode,
      expect,
      preExisting: Boolean(preInvalid),
    });
  }
}
function verdictForLocal(wire) {
  return checkTelegramHtml(wire).ok ? "PARSES" : "REJECTED";
}

if (process.argv.includes("--deliver")) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.error("live-html-probe: --deliver needs TELEGRAM_CHAT_ID");
    process.exit(2);
  }
  const digest =
    "[w542 format probe] one-off checker validation — accepted shapes:\n" +
    "<b>bold</b> <u>underline</u> <s>strike</s> <tg-spoiler>spoiler</tg-spoiler> <code>code</code>\n" +
    '<a href="https://example.com">link</a> and a quoted ">" inside an attribute:\n' +
    '<a href="https://example.com/a>b">quoted-gt link</a>\n' +
    "nested: <u>a <s>b</s> c</u> / <b>a <u>b</u> c</b>";
  const sent = await sendMessage(token, chatId, digest, { parseMode: "HTML" });
  console.log(
    `deliver: ${sent.ok ? `ok (message_id ${sent.messageId})` : `FAILED: ${sent.error}`}`,
  );
  if (!sent.ok) process.exit(1);
}

// ── run ─────────────────────────────────────────────────────────────────────
let failures = 0;
let passes = 0;
let preExistingRows = 0;
for (const probe of cases) {
  const live = await verdictFor(probe.wire, probe.parseMode);
  const checker =
    probe.parseMode === "HTML" ? verdictForLocal(probe.wire) : undefined;
  if (probe.preExisting && live === "REJECTED") preExistingRows++;
  const agrees =
    live === probe.expect && (checker === undefined || checker === live);
  if (agrees) {
    passes++;
    continue;
  }
  failures++;
  console.log(
    `DISAGREE ${probe.name}` +
      `\n  wire=${JSON.stringify(probe.wire.slice(0, 120))}` +
      `\n  live=${live} expected=${probe.expect}` +
      (checker === undefined
        ? ""
        : `\n  local checker=${checker} ${checker === live ? "" : "(checker disagrees with live — live wins)"}`),
  );
}
console.log(
  `live-html-probe: ${passes} agree, ${failures} disagree (of ${cases.length}); pre-existing rejected wires: ${preExistingRows}`,
);
if (failures > 0) process.exit(1);
