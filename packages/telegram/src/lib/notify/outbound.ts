/**
 * OUTBOUND GATE — one place that decides what leaves for the owner's chat.
 *
 * Every owner-facing message in this package passes through `planOutbound`
 * before a client call exists, so a body the Telegram API would reject is
 * refused locally, with the rule and the offending tag or offset named, and
 * nothing is sent. The tool path, the tracked live-update message, the turn
 * summary, the turn-complete notify and the two cross-package senders
 * (watchdog canary, adherence digest) all share this one decision.
 *
 * Why a gate rather than a check in each notification's text: the failure the
 * owner saw was a body authored far from the send site (`<ul>` in a report, an
 * eleven-line adherence ping). A per-notification check is a promise each new
 * notification can forget; a check at the sender is a promise the wire keeps.
 *
 * Rules, applied in this order:
 *  1. Resolve the delivery format ONCE (`resolveDeliveryFormat`): MarkdownV2
 *     marker pairs convert to HTML, an explicit request wins, a no-request
 *     body with raw tags auto-selects HTML, `rich` opts a no-request body into
 *     Markdown detection. The conversion's output is what gets sent.
 *  2. An HTML body is validated against Telegram's parser
 *     (`checkTelegramHtml`). An unsupported tag, a tag left open, a stray end
 *     tag or a malformed attribute is a REFUSAL naming the rule, the tag and
 *     the offset.
 *  3. A body that would ship PLAIN and is longer than
 *     `OUTBOUND_PLAIN_MAX_CHARS`, with neither a parse mode nor `rich` in the
 *     request, is a REFUSAL naming the length and the cap. The fix is either
 *     structure it (bold subject, short labelled lines) and send it as HTML,
 *     or ask for `rich` — not to send 600 unstructured characters.
 *
 * The gate also owns the four counters that make this surface measurable:
 * tracked acks, owner-facing messages in the last hour by source, escalations
 * folded into a digest (reported by the adherence meter), and refusals by rule.
 * `BRAID_TG_OUTBOUND_METRICS=1` logs them after every send or refusal; the
 * fixtures print them with `renderOutboundMetrics`.
 */

import type {
  ParseMode,
  TelegramClient,
  TelegramReplyMarkup,
} from "../telegram-client.js";
import { checkTelegramHtml, type TelegramHtmlVerdict } from "../html-check.js";
import { attachIdentity } from "../identity.js";
import {
  convertMarkdownV2ToHtml,
  resolveDeliveryFormat,
  sendMessageChunks,
  type ConversionCounts,
  type SendChunksResult,
} from "../format.js";

/** Longest body that may ship as PLAIN text with no parse mode and no `rich`. */
export const OUTBOUND_PLAIN_MAX_CHARS = 280;

/** Who asked for the message; the metrics bucket by it. */
export type OutboundSource =
  | "tool"
  | "tracked"
  | "summary"
  | "turn-notify"
  | "adherence-digest"
  | "watchdog-signal"
  | "outage-notify";

/** Why a body was refused before any network call. */
export type OutboundRefusalRule =
  | "plain-over-cap"
  | "unstructured-over-cap"
  | "unsupported-tag"
  | "unclosed-tag"
  | "stray-end-tag"
  | "html-syntax";

export interface OutboundRefusal {
  rule: OutboundRefusalRule;
  /** Body length at refusal time. */
  length: number;
  /** The rule's own offset in the body (the cap for `plain-over-cap`). */
  offset?: number;
  /** Offending tag name, lowercased, when the rule names one. */
  tag?: string;
  /** Owner-readable sentence naming the rule and the offending tag/offset. */
  error: string;
}

export interface OutboundRequest {
  text: string;
  /** Explicit `parse_mode` request. */
  parseMode?: ParseMode;
  /** Long-form request: may exceed the plain cap, converted once. */
  rich?: boolean;
  /**
   * Let the resolver pick Markdown for a well-formed no-request body (the
   * crafted-summary path). Off by default: a `rich` request keeps the legacy
   * behavior of leaving a plain body plain.
   */
  detectMarkdown?: boolean;
  /**
   * Wire cap for a conversion: a rendered body over it is refused and the
   * authored text ships instead (the tool's configured `sendMaxChars`).
   */
  renderedCap?: number;
  source: OutboundSource;
  /**
   * Label to attach instead of this process's own. Exactly one caller uses it:
   * the chat-keyed tracked message, whose persisted record outlives the process
   * that pinned it, so its label stays the pinner's. Every other caller omits
   * it and gets the line `identity.ts` renders from this process.
   */
  identityLine?: string;
  /** Inline keyboard, attached to the last chunk only. */
  replyMarkup?: TelegramReplyMarkup;
  /**
   * Events the caller folded into THIS message instead of sending each one
   * (the adherence meter's digest reports how many escalations it suppressed).
   * Recorded with the delivery, so the counter and the message agree.
   */
  suppressed?: number;
}

export type OutboundPlan =
  | {
      ok: true;
      /** The body to send (converted/sanitized once). */
      text: string;
      parseMode?: ParseMode;
      converted?: ConversionCounts;
      downgraded?: boolean;
    }
  | { ok: false; refusal: OutboundRefusal };

// ── Refusal classification ───────────────────────────────────────────────────

/**
 * Classify an HTML verdict into a refusal. The verdict carries the tag and
 * offset when its rule names one; the fallback keeps the API's own wording so
 * an unclassified failure still reads as a specific refusal, never "invalid".
 */
function refusalFromHtml(
  verdict: Extract<TelegramHtmlVerdict, { ok: false }>,
  length: number,
): OutboundRefusal {
  const { error } = verdict;
  const tag = "tag" in verdict ? verdict.tag : undefined;
  const offset = "offset" in verdict ? verdict.offset : undefined;
  let rule: OutboundRefusalRule = "html-syntax";
  if (error.startsWith("Unsupported start tag")) rule = "unsupported-tag";
  else if (error.startsWith("Can't find end tag")) rule = "unclosed-tag";
  else if (error.startsWith("Unexpected end tag")) rule = "stray-end-tag";
  else if (error.startsWith("Unmatched end tag")) rule = "stray-end-tag";
  const where =
    tag !== undefined
      ? `tag <${tag}>${offset !== undefined ? ` at offset ${offset}` : ""}`
      : offset !== undefined
        ? `offset ${offset}`
        : "no tag";
  return {
    rule,
    length,
    ...(offset !== undefined ? { offset } : {}),
    ...(tag !== undefined ? { tag } : {}),
    error:
      `outbound refused (rule ${rule}): ${where} — ${error}. ` +
      `Telegram only accepts b, i, u, s, a, code, pre, tg-spoiler and blockquote ` +
      `(plus their documented aliases); NOTHING was sent.`,
  };
}

/**
 * Sources whose body a caller can rewrite after a refusal. Only these are held
 * to the structure rule: for an automatic source (a crafted summary, a digest,
 * an outage alert) a refusal has no recipient — the message would simply never
 * arrive — so its delivery stays as it was and only the markup rules apply.
 */
const SENDER_FACING_SOURCES: ReadonlySet<OutboundSource> = new Set(["tool"]);

/** A line that is visibly structure: bullet, number, heading, quote, table. */
const STRUCTURE_LINE_RE =
  /^[ \t]{0,3}(?:[-•*·–—][ \t]|\d{1,3}[.)][ \t]|#{1,6}[ \t]|>[ \t]|\|)/m;

/**
 * A labelled line (`Label: value`). A URL is not one: `https://` has no space
 * after the colon, which is what separates a label from a scheme.
 */
const LABEL_LINE_RE = /^[ \t]{0,3}[^:\n]{1,48}:[ \t]\S/m;

/**
 * Does the body carry formatting a reader can see — a tag, a MarkdownV2 pair
 * that converts to one, a bullet/numbered/heading line, or a `Label: value`
 * line? Prose alone is not structure, however many paragraphs it has: that is
 * the wall the owner asked not to receive.
 */
export function hasOutboundStructure(text: string): boolean {
  if (looksLikeHtmlMarkup(text)) return true;
  const counts = convertMarkdownV2ToHtml(text).converted;
  if (counts.bold + counts.underline + counts.strike + counts.spoiler > 0)
    return true;
  return STRUCTURE_LINE_RE.test(text) || LABEL_LINE_RE.test(text);
}

function unstructuredOverCap(
  text: string,
  cap: number,
  requested: ParseMode | undefined,
  rich: boolean,
): OutboundRefusal {
  const asked =
    requested !== undefined
      ? `parse_mode ${requested}`
      : rich
        ? "rich"
        : "no format";
  return {
    rule: "unstructured-over-cap",
    length: text.length,
    offset: cap,
    error:
      `outbound refused (rule unstructured-over-cap): body is ${text.length} chars and carries no structure — ` +
      `no tag, no bullet or numbered line, no "Label: value" line. ` +
      `The rule: over ${cap} chars a body ships formatted, so ${asked} alone does not make it formatted. ` +
      `Fix: structure it (a bold subject, short labelled lines, a bullet list) and send it with ` +
      `parse_mode:"HTML" — or with parse_mode/rich AND that structure for a long report; ` +
      `or send ${cap} chars or fewer. NOTHING was sent.`,
  };
}

function plainOverCap(
  text: string,
  cap: number,
  requested?: ParseMode,
): OutboundRefusal {
  const why =
    requested !== undefined
      ? ` (requested parse_mode ${requested} could not be delivered and the body would ship plain)`
      : "";
  return {
    rule: "plain-over-cap",
    length: text.length,
    offset: cap,
    error:
      `outbound refused (rule plain-over-cap): body is ${text.length} chars${why}; ` +
      `the plain cap is ${cap} and the request carried neither parse_mode nor rich. ` +
      `Structure it (bold subject, short labelled lines) and send it as HTML, or ask for rich. ` +
      `NOTHING was sent.`,
  };
}

// ── Planning ────────────────────────────────────────────────────────────────

/**
 * Does the body carry a tag-shaped token? `hasHtmlTags` answers for Telegram's
 * OWN tag set, so a body containing only `<ul>` reads as plain text and would
 * ship literally — and a body containing `<b>` plus `<ul>` selects HTML and
 * then fails at the API. This selector is broader on purpose: any
 * `<name …>`/`</name>` token means the author meant markup, so the body is
 * validated as markup. Angle-bracketed URLs (`<https://…>`) and math
 * (`a <b`) do not match: the token must close and the name must be a plain
 * ASCII name.
 */
const TAG_TOKEN_RE = /<\/?([A-Za-z][A-Za-z0-9-]*)(\s[^<>]*)?\/?>/;

export function looksLikeHtmlMarkup(text: string): boolean {
  return TAG_TOKEN_RE.test(text);
}

/**
 * Decide the wire by deciding the body: a refusal here means the client is
 * never touched. Pure of the network and the clock (a fixture can assert every
 * rule without a stub that could hide a call); the one process fact it reads is
 * the label `identity.ts` renders — memoized, so a plan is stable.
 */
export function planOutbound(req: OutboundRequest): OutboundPlan {
  const text = req.text ?? "";
  if (!text.trim()) {
    return {
      ok: true,
      text: "",
      ...(req.parseMode ? { parseMode: req.parseMode } : {}),
    };
  }
  const rich = req.rich === true;
  // No explicit mode + a tag-shaped token → treat the body as markup, so an
  // unsupported or unclosed tag is refused here instead of by the API.
  const impliedHtml = req.parseMode === undefined && looksLikeHtmlMarkup(text);
  const fmt = resolveDeliveryFormat(
    req.parseMode ?? (impliedHtml ? "HTML" : undefined),
    text,
    req.detectMarkdown === true,
    req.renderedCap,
  );
  if (fmt.parseMode === "HTML") {
    const verdict = checkTelegramHtml(fmt.text);
    if (!verdict.ok)
      return { ok: false, refusal: refusalFromHtml(verdict, text.length) };
  }
  // The cap keys on the REQUEST, not the resolved mode: a caller who asked for
  // Markdown on a body that cannot be Markdown gets the plain fallback it has
  // always got, while a caller who asked for nothing gets told to structure.
  if (req.parseMode === undefined && !rich && fmt.parseMode === undefined) {
    if (text.length > OUTBOUND_PLAIN_MAX_CHARS) {
      return {
        ok: false,
        refusal: plainOverCap(text, OUTBOUND_PLAIN_MAX_CHARS),
      };
    }
  }
  // The other half of the same rule, and the half a REQUEST cannot satisfy:
  // `rich: true` or a bare `parse_mode` used to exempt any body, so a wall of
  // prose could ship past the cap by asking for the format instead of using it.
  // Past the cap a sender-facing body must be structured; the request only
  // decides which transport carries that structure.
  if (
    SENDER_FACING_SOURCES.has(req.source) &&
    text.length > OUTBOUND_PLAIN_MAX_CHARS &&
    !hasOutboundStructure(text)
  ) {
    return {
      ok: false,
      refusal: unstructuredOverCap(
        text,
        OUTBOUND_PLAIN_MAX_CHARS,
        req.parseMode,
        rich,
      ),
    };
  }
  // The label goes on at this boundary, not at the call sites: every
  // owner-facing message in the package plans through here, so a new send path
  // cannot forget it, and no caller can label a message as someone else's.
  const body = attachIdentity(fmt.text, fmt.parseMode, req.identityLine);
  return {
    ok: true,
    text: body,
    ...(fmt.parseMode ? { parseMode: fmt.parseMode } : {}),
    ...(fmt.converted ? { converted: fmt.converted } : {}),
    ...(fmt.downgraded ? { downgraded: true } : {}),
  };
}

// ── Metrics ─────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

export interface OutboundMetricsSnapshot {
  /** Tracked "Working…" acks delivered (one per inbound batch, per chat). */
  trackedAcks: number;
  /** Owner-facing messages in the last hour, by source. */
  ownerMessagesLastHour: Partial<Record<OutboundSource, number>>;
  /** Owner-facing messages since the counters were last reset, by source. */
  ownerMessagesTotal: Partial<Record<OutboundSource, number>>;
  /** Escalations folded into an adherence digest (reported by the meter). */
  escalationsSuppressed: number;
  /** Refusals by rule, since the counters were last reset. */
  refusalsByRule: Partial<Record<OutboundRefusalRule, number>>;
  /** Rolling window the `LastHour` view uses. */
  windowMs: number;
}

interface SentStamp {
  source: OutboundSource;
  at: number;
}

function emptySnapshot(): OutboundMetricsSnapshot {
  return {
    trackedAcks: 0,
    ownerMessagesLastHour: {},
    ownerMessagesTotal: {},
    escalationsSuppressed: 0,
    refusalsByRule: {},
    windowMs: HOUR_MS,
  };
}

let metrics: OutboundMetricsSnapshot = emptySnapshot();
let sentStamps: SentStamp[] = [];

/** Record one delivered owner-facing message (called by the gate). */
export function noteOwnerMessage(
  source: OutboundSource,
  at: number = Date.now(),
): void {
  metrics.ownerMessagesTotal[source] =
    (metrics.ownerMessagesTotal[source] ?? 0) + 1;
  sentStamps.push({ source, at });
  if (sentStamps.length > 512) sentStamps = sentStamps.slice(-256);
}

/** Record one tracked "Working…" ack. */
export function noteTrackedAck(): void {
  metrics.trackedAcks += 1;
}

/** Record one refusal (called by the gate; exported for the meter's callers). */
export function noteRefusal(rule: OutboundRefusalRule): void {
  metrics.refusalsByRule[rule] = (metrics.refusalsByRule[rule] ?? 0) + 1;
}

/** Record escalations folded into a digest rather than sent on their own. */
export function noteEscalationsSuppressed(count: number): void {
  if (!Number.isFinite(count) || count <= 0) return;
  metrics.escalationsSuppressed += Math.floor(count);
}

/** The counters, with the hourly view computed against `nowMs`. */
export function outboundMetricsSnapshot(
  nowMs: number = Date.now(),
): OutboundMetricsSnapshot {
  const hour: Partial<Record<OutboundSource, number>> = {};
  for (const stamp of sentStamps) {
    // The window is [now - 1h, now]: a send exactly an hour old has left it.
    if (nowMs - stamp.at >= HOUR_MS || stamp.at > nowMs) continue;
    hour[stamp.source] = (hour[stamp.source] ?? 0) + 1;
  }
  return { ...metrics, ownerMessagesLastHour: hour };
}

/** Reset every counter (fixtures). */
export function resetOutboundMetrics(): void {
  metrics = emptySnapshot();
  sentStamps = [];
}

const SOURCE_ORDER: OutboundSource[] = [
  "tool",
  "tracked",
  "summary",
  "turn-notify",
  "adherence-digest",
  "watchdog-signal",
  "outage-notify",
];

/**
 * One-page metric line. `hour`/`total` list only the sources that carried
 * traffic, in a stable order, so a log line stays comparable between runs.
 */
export function renderOutboundMetrics(nowMs: number = Date.now()): string {
  const snap = outboundMetricsSnapshot(nowMs);
  const list = (m: Partial<Record<OutboundSource, number>>): string => {
    const parts = SOURCE_ORDER.filter((s) => (m[s] ?? 0) > 0).map(
      (s) => `${s} ${m[s]}`,
    );
    return parts.length > 0 ? parts.join(" · ") : "none";
  };
  const refused = Object.entries(snap.refusalsByRule)
    .map(([rule, n]) => `${rule} ${n}`)
    .sort()
    .join(" · ");
  return (
    `outbound metrics: tracked acks ${snap.trackedAcks} · ` +
    `owner messages/hour ${list(snap.ownerMessagesLastHour)} · ` +
    `escalations suppressed ${snap.escalationsSuppressed} · ` +
    `refusals ${refused || "none"}`
  );
}

// ── The gate ────────────────────────────────────────────────────────────────

export interface OutboundSendResult {
  ok: boolean;
  sent: number;
  total: number;
  messageIds: number[];
  source: OutboundSource;
  parseMode?: ParseMode;
  converted?: ConversionCounts;
  downgraded?: boolean;
  /** Present when the gate refused; nothing was sent in that case. */
  refusal?: OutboundRefusal;
  error?: string;
}

export interface OutboundSender {
  /** Plan without sending (the tracked-message text decisions use it). */
  plan(req: OutboundRequest): OutboundPlan;
  /** Plan then send; a refusal never reaches the client. */
  send(req: OutboundRequest): Promise<OutboundSendResult>;
}

export interface OutboundSenderDeps {
  client: Pick<TelegramClient, "sendMessage">;
  token: string;
  /** Target chat, or a resolver (the owner chat is captured at first inbound). */
  chatId: number | string | (() => number | string);
  /** Per-chunk cap (default Telegram's 4096). */
  maxLen?: number;
  log?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    ...rest: unknown[]
  ) => void;
}

/**
 * Build the sender. One instance per process is enough — it holds no state
 * besides the injected client — and the counters are module-level so every
 * instance reports into the same snapshot.
 */
export function createOutboundSender(deps: OutboundSenderDeps): OutboundSender {
  const chatIdOf = (): number | string =>
    typeof deps.chatId === "function" ? deps.chatId() : deps.chatId;
  const log = deps.log ?? (() => {});
  // One debug flag turns the counter line on: BRAID_TG_OUTBOUND_METRICS=1.
  const metricsFlag = process.env.BRAID_TG_OUTBOUND_METRICS;
  const reportMetrics = (): void => {
    if (!metricsFlag || metricsFlag === "0") return;
    log("info", renderOutboundMetrics());
  };

  const send = async (req: OutboundRequest): Promise<OutboundSendResult> => {
    const plan = planOutbound(req);
    if (!plan.ok) {
      noteRefusal(plan.refusal.rule);
      log("warn", plan.refusal.error, { source: req.source });
      reportMetrics();
      return {
        ok: false,
        sent: 0,
        total: 0,
        messageIds: [],
        source: req.source,
        refusal: plan.refusal,
        error: plan.refusal.error,
      };
    }
    if (!plan.text.trim()) {
      return {
        ok: true,
        sent: 0,
        total: 0,
        messageIds: [],
        source: req.source,
      };
    }
    const chatId = chatIdOf();
    if (
      chatId === undefined ||
      chatId === null ||
      chatId === 0 ||
      chatId === ""
    ) {
      return {
        ok: false,
        sent: 0,
        total: 0,
        messageIds: [],
        source: req.source,
        error: "outbound: no chat id resolved; NOTHING was sent",
      };
    }
    const body: SendChunksResult = await sendMessageChunks(deps.client, {
      token: deps.token,
      chatId,
      text: plan.text,
      ...(plan.parseMode ? { parseMode: plan.parseMode } : {}),
      ...(req.replyMarkup ? { replyMarkup: req.replyMarkup } : {}),
      ...(deps.maxLen !== undefined ? { maxLen: deps.maxLen } : {}),
    });
    if (body.ok && body.sent > 0) {
      noteOwnerMessage(req.source);
      if (req.source === "tracked") noteTrackedAck();
      if (req.suppressed) noteEscalationsSuppressed(req.suppressed);
    }
    reportMetrics();
    return {
      ok: body.ok,
      sent: body.sent,
      total: body.total,
      messageIds: body.messageIds,
      source: req.source,
      ...(plan.parseMode ? { parseMode: plan.parseMode } : {}),
      ...(plan.converted ? { converted: plan.converted } : {}),
      ...(plan.downgraded ? { downgraded: true } : {}),
      ...(body.error !== undefined ? { error: body.error } : {}),
    };
  };

  return { plan: planOutbound, send };
}
