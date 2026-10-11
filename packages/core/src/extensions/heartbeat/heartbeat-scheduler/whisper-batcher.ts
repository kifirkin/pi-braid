/**
 * Whisper batcher for heartbeat ticks.
 *
 * During a heartbeat tick, multiple cognitive modules may want to
 * whisper to the agent. If we just forward them through ctx.whisper,
 * the agent gets N separate messages -- which is both noisy and
 * expensive (each message becomes a turn boundary in the agent's
 * context).
 *
 * The batcher intercepts the whisper call during the tick, buffers
 * messages grouped by priority, and flushes them as aggregated
 * messages per priority tier. High-priority messages flush first.
 */

import { formatLocalTime } from "../../../lib/utils/local-time.js";
import { formatTokensK } from "../../../lib/detection/context-usage.js";
import type { SelfStateSample } from "../../../lib/telemetry/context-heartbeat.js";

export interface WhisperBufferEntry {
  message: string;
  priority: string;
}

export type WhisperSendFn = (msg: string, opts?: { category?: string; priority?: string }) => void;

/** Render a token count compactly: 0 -> "0K", 1234 -> "1K", 237785 -> "238K". */
function renderTokensK(tokens: number): string {
  return formatTokensK(tokens);
}

/**
 * Self-state line (2 directive): every heartbeat
 * summary makes the agent self-aware of its own context health. ONE line,
 * <= 40 tokens, appended to every heartbeat summary:
 *
 *   self-state: ctx 213K tok · cache 96% · dup 39 · tps-ema 87
 *
 * An unavailable metric renders "n/a" — never zero (a zero looks like a
 * healthy reading; "n/a" honestly says the telemetry is missing).
 */
export function buildSelfStateLine(sample: Partial<SelfStateSample> | null | undefined): string {
  const s = sample ?? {};
  const ctxTok =
    typeof s.contextTokens === "number" ? `${renderTokensK(s.contextTokens)} tok` : "n/a";
  const cache = typeof s.cacheHitShare === "number" ? `${Math.round(s.cacheHitShare)}%` : "n/a";
  const dup = typeof s.nearDupCount === "number" ? String(s.nearDupCount) : "n/a";
  const tps = typeof s.tpsEma === "number" ? `${Math.round(s.tpsEma)} tok/s` : "n/a";
  const acts = typeof s.hygieneActs === "number" ? String(s.hygieneActs) : null;
  const actPart = acts ? ` · acts ${acts}` : "";
  return `self-state: ctx ${ctxTok} · cache ${cache} · dup ${dup} · tps-ema ${tps}${actPart}`;
}

/**
 * Flush batched whispers: group by priority tier, concatenate per tier,
 * and send as aggregated messages. This prevents N separate injected
 * messages per heartbeat tick when multiple modules activate.
 *
 * Fresh clock: every batched summary
 * (and its single-message form) prepends a `now:` line rendered by the
 * ONE local-time formatter (lib/utils/local-time.ts) so the agent never
 * reasons on a stale clock mid-session.
 *
 * Self-state (Refine-2): when `selfState` is provided (the caller
 * samples context tokens / cache-hit share / near-duplicates / tok/s trend
 * via lib/telemetry/context-heartbeat.ts getSelfStateSample), the summary
 * gains ONE self-state line right after the `now:` line — every heartbeat
 * summary makes the agent aware of its own context health. Absent sample =
 * no line (callers opt in).
 */
export function flushWhisperBuffer(
  buffer: WhisperBufferEntry[],
  send: WhisperSendFn | undefined,
  selfState?: string,
): void {
  if (buffer.length === 0 || !send) return;

  const groups = new Map<string, string[]>();
  for (const entry of buffer) {
    const p = entry.priority;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push(entry.message);
  }

  // Flush one message per priority tier
  for (const [priority, messages] of groups) {
    const nowLine = `now: ${formatLocalTime(new Date(), true)}`;
    const selfStateSuffix = selfState ? `\n${selfState}` : "";
    if (messages.length === 1) {
      send(`${nowLine}${selfStateSuffix}\n${messages[0]}`, {
        category: "cognitive",
        priority: priority,
      });
    } else {
      const combined = `[Heartbeat Summary]\n${nowLine}${selfStateSuffix}\n${messages.map((m, i) => `${i + 1}. ${m}`).join("\n")}`;
      send(combined, { category: "cognitive", priority: priority });
    }
  }
}
