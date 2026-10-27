/**
 * Whisper batcher: the ONE place the shape of a heartbeat delivery is built.
 *
 * Two buffers feed it. The tick batcher collects module whispers and flushes
 * them once per tick; the delayed buffer collects policy whispers and flushes
 * them on the next before_agent_start. Both deliver the same shape: one
 * clock line, one self-state line, numbered bodies. The shape has one
 * owner here instead of a copy per flush site.
 *
 * Two rules make the delivered text trustworthy, and each is enforced by the
 * way this module is written rather than by the emitter remembering it:
 *
 *   1. One snapshot per delivery. The clock comes from the seam, and a
 *      family that renders a measurement is re-rendered from the sample
 *      taken at delivery, so a label cannot outlive the number beside it.
 *   2. Last arrival wins in a collapse. Keeping the first arrival per
 *      family is what printed the oldest label beside the newest numbers:
 *      the newest instruction is the only one whose advice can still apply.
 */

import { formatLocalTime, nowOrOverride } from "../../../lib/utils/local-time.js";
import { formatTokensK } from "../../../lib/detection/context-usage.js";
import { contextUsageTier, contextUsageTierMessage } from "../../../lib/detection/context-tiers.js";
import type { SelfStateSample } from "../../../lib/telemetry/context-heartbeat.js";

/**
 * Families whose body is a rendering of a live measurement. The emitter
 * declares the family so the batcher can re-render it from the delivery
 * sample; a family sniffed from the prose silently stops collapsing the day
 * the prose changes.
 */
export type WhisperFamily = "context-tier";

export interface WhisperBufferEntry {
  message: string;
  priority: string;
  /** Set by the emitter for a family the batcher must own at delivery. */
  family?: WhisperFamily;
}

export type WhisperSendFn = (msg: string, opts?: { category?: string; priority?: string }) => void;

/** Render a token count compactly: 0 -> "0K", 1234 -> "1K", 237785 -> "238K". */
function renderTokensK(tokens: number): string {
  return formatTokensK(tokens);
}

/**
 * Self-state line: ONE line, appended to every heartbeat delivery.
 *
 *   self-state: ctx 413K tok (41.3% measured)
 *
 * The count and the percent are one meter reading from one snapshot, and the
 * provenance word is the meter's own (context-usage describeUsage), so the two
 * cannot disagree and a reader can tell a large context from a badly counted
 * one. A percent whose provenance is missing is not rendered at all: an
 * unlabelled percentage is the class that cost a session its window.
 *
 * Metrics this line no longer carries (cache-hit share, near-duplicate count,
 * tok/s trend, hygiene acts) name no action at the moment they are read. They
 * stay in the telemetry JSONL and in the tools an agent calls while
 * diagnosing, where a reader has already decided to look. An unavailable
 * metric renders "n/a", never zero: a zero looks like a healthy reading.
 */
export function buildSelfStateLine(sample: Partial<SelfStateSample> | null | undefined): string {
  const s = sample ?? {};
  const ctxTok =
    typeof s.contextTokens === "number" ? `${renderTokensK(s.contextTokens)} tok` : "n/a";
  const percent =
    typeof s.contextPercent === "number" &&
    typeof s.contextProvenance === "string" &&
    s.contextProvenance.length > 0
      ? ` (${s.contextPercent.toFixed(1)}% ${s.contextProvenance})`
      : "";
  return `self-state: ctx ${ctxTok}${percent}`;
}

export interface DeliveryRenderOptions {
  /** Self-state line, rendered from the same sample as the rest of the delivery. */
  selfState?: string;
  /** Clock instant for the `now:` line; the clock seam applies when omitted. */
  at?: Date;
}

/**
 * Render one batched delivery. The clock is read through the seam the envelope
 * formatter uses, never from a fresh `Date` at flush time: a delivery that was
 * delayed must not claim an instant it never observed.
 */
export function renderHeartbeatDelivery(
  bodies: readonly string[],
  opts: DeliveryRenderOptions = {},
): string {
  const nowLine = `now: ${formatLocalTime(opts.at ?? nowOrOverride(), true)}`;
  const selfStateSuffix = opts.selfState ? `\n${opts.selfState}` : "";
  const head = `${nowLine}${selfStateSuffix}`;
  if (bodies.length === 1) return `${head}\n${bodies[0]}`;
  return `[Heartbeat Summary]\n${head}\n${bodies.map((m, i) => `${i + 1}. ${m}`).join("\n")}`;
}

/**
 * Flush the tick buffer: group by priority tier, render one delivery per tier.
 * Self-state (when a sample was taken) lands right after the clock line, so
 * every heartbeat summary is also a self-state checkpoint.
 */
export function flushWhisperBuffer(
  buffer: WhisperBufferEntry[],
  send: WhisperSendFn | undefined,
  selfState?: string,
  at?: Date,
): void {
  if (buffer.length === 0 || !send) return;

  const groups = new Map<string, string[]>();
  for (const entry of buffer) {
    const group = groups.get(entry.priority) ?? [];
    group.push(entry.message);
    groups.set(entry.priority, group);
  }

  for (const [priority, messages] of groups) {
    send(renderHeartbeatDelivery(messages, { selfState, at }), {
      category: "cognitive",
      priority,
    });
  }
}

/**
 * Collapse key for the delayed buffer. A declared family is its own key (the
 * emitter knows what it measured). The prose rules below cover emitters that
 * still describe themselves by their first line: each one is a coupling, so a
 * copy change there must come with a look at this list.
 */
function dedupKey(entry: WhisperBufferEntry): string {
  if (entry.family) return `family:${entry.family}`;
  const message = entry.message;
  // Duplicate count messages: "39 near-duplicate messages..."
  if (/^\d+ near-duplicate messages/.test(message)) return "duplicate-count";
  // Context density messages
  if (/^Low context density/.test(message)) return "density-low";
  if (/^High density/.test(message)) return "density-high";
  if (/^Context density still low/.test(message)) return "density-low-persistent";
  // Proactive projection messages
  if (/^\[proactive\]/.test(message)) return "proactive-projection";
  // Degradation messages
  if (/^Degradation detected/.test(message)) return "degradation";
  // Fallback: use first 80 chars
  return message.slice(0, 80);
}

/**
 * The body to deliver for one entry.
 *
 * A declared family is re-rendered from the delivery sample, so the
 * instruction and the number beside it describe one measurement. When the
 * measured state no longer reaches the family's first arm, the entry is
 * silence: advice about a condition that has passed is worse than none.
 * With no measurement in hand the emitter's own wording stands: it carries no
 * number, so it cannot contradict one.
 */
function deliveryBody(entry: WhisperBufferEntry, contextPercent: number | null): string | null {
  if (entry.family !== "context-tier") return entry.message;
  if (contextPercent === null) return entry.message;
  const tier = contextUsageTier(contextPercent);
  return tier ? contextUsageTierMessage(tier.tier) : null;
}

export interface DelayedRenderOptions extends DeliveryRenderOptions {
  /** Context percent measured at delivery, or null when nothing was measured. */
  contextPercent?: number | null;
}

/**
 * Collapse the delayed buffer and render its deliveries: last arrival wins per
 * key, then one delivery per priority tier.
 */
export function renderDelayedDelivery(
  batch: readonly WhisperBufferEntry[],
  opts: DelayedRenderOptions = {},
): string[] {
  const collapsed = new Map<string, WhisperBufferEntry>();
  for (const entry of batch) {
    // Last arrival wins: the newest instruction is the only one whose advice
    // can still be right, and the keystroke of keying on the first arrival is
    // what printed the oldest label beside the newest numbers.
    collapsed.set(dedupKey(entry), entry);
  }

  const groups = new Map<string, string[]>();
  for (const entry of collapsed.values()) {
    const body = deliveryBody(entry, opts.contextPercent ?? null);
    if (body === null) continue;
    const group = groups.get(entry.priority) ?? [];
    group.push(body);
    groups.set(entry.priority, group);
  }

  return [...groups.values()].map((bodies) => renderHeartbeatDelivery(bodies, opts));
}
