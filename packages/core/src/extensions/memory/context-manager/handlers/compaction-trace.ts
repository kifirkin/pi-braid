// Compaction failure trace.
//
// A failed, aborted, cancelled or empty-summary compaction leaves no trace in
// the session file on its own: pi-core's session_compact_failed reaches only
// extension handlers (agent-session.js:326-327), so a post-mortem cannot tell
// that compaction was attempted, why it failed, or how often it was retried.
// This module owns the durable transcript trace:
// one custom session entry per non-success outcome, plus the log line naming
// the failure class, the span size, and the retry count.
//
// The entry lands via pi.appendEntry (pi-core ExtensionAPI, types.d.ts
// "appendEntry<T>(customType, data)" → sessionManager.appendCustomEntry →
// _persist → immediate appendFileSync to the session file), the documented
// write seam that also emits entry_appended so renderers and integrations
// observe the trace. Plain custom
// entries are display/state entries: sessionEntryToContextMessages
// (pi-core session-manager.js:166-193) documents that they never participate
// in the LLM context, so the trace is visible to operators and session
// readers without polluting the agent's context or the summarizer's input.
//
// Read it back: grep '"context_compaction_failure"' over the session file, or
// jq 'select(.customType=="context_compaction_failure")' <session>.jsonl.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log } from "./shared.js";
import { getSessionIdSafe, getLeafIdSafe } from "../../../../lib/state/extension-state.js";
export const COMPACTION_TRACE_ENTRY_TYPE = "context_compaction_failure";

/** What kind of non-success outcome this trace records. */ export type CompactionTraceEvent =
  | /** The cycle failed and will not retry (or was retried and failed again). */ "failure"
  /** The cycle was cancelled (user Escape, pi-core signal abort, or an extension cancel). */
  | "aborted"
  /** The verify stage rejected the compaction (empty summary / budget not recovered). */
  | "verify-failed"
  /** The watchdog fired: the cycle showed no completion past the stall threshold. */
  | "stall";

/** Coarse failure class carried in the log line and the trace entry. */
export type CompactionFailureClass =
  | "transient"
  | "context-window"
  | "summary-cap"
  | "threshold"
  | "overflow"
  | "manual"
  | "cancelled"
  | "verify-coherence"
  | "verify-budget"
  | "aborted"
  | "stall"
  | "unknown";

export interface CompactionTraceData {
  event: CompactionTraceEvent;
  /** pi-core's cycle trigger: manual | threshold | overflow | undefined. */
  reason?: string;
  /** Coarse failure class (classifyCompactionFailure or the verify reason). */
  failureClass?: string;
  errorMessage?: string;
  /** Messages in this cycle's raw summarization input (absent when unmeasured). */
  spanMessages?: number;
  /** Active retry attempt at trace time (0 = first attempt of the sequence). */
  retryAttempt?: number;
  /** Whether pi-core announced a further retry for this firing. */
  willRetry?: boolean;
  /**
   * Whether the failing content came from this extension's own
   * session_before_compact result (pi-core's fromExtension flag). Separates
   * "braid's bounded/chunked summary failed" from "pi's default summarizer
   * failed" - the first question after a compaction incident. Always false on
   * a cancelled cycle (no compaction was returned), which is why cancelSource
   * is recorded alongside it rather than instead of it.
   */
  fromExtension?: boolean;
  /** Monotonic per-session compaction cycle counter (session_before_compact firing). */
  cycleId?: number;
  /** Who cancelled the cycle, when known: extension | watchdog (else unset). */
  cancelSource?: string;
  /** Wall time from cycle start (watchdog arm) to this trace, when armed. */
  durationMs?: number;
}

/**
 * Classify a failed/aborted cycle. Order matters: explicit cancel markers
 * first, then the error-text classes shared with the retry machinery, then
 * the cycle trigger as the fallback.
 */
export function classifyCompactionFailure(input: {
  errorMessage?: string;
  reason?: string;
  aborted?: boolean;
  cancelSource?: string;
}): CompactionFailureClass {
  const { errorMessage, reason, aborted, cancelSource } = input;
  if (cancelSource === "watchdog") return "stall";
  if (errorMessage && /compaction cancelled/i.test(errorMessage)) return "cancelled";
  if (aborted) return "aborted";
  if (errorMessage) {
    // A length-stopped summarization generation is its own class, distinct
    // from both transient faults and context-window rejections: the REQUEST
    // fit the window (pi-ai clamps max_tokens to window - prompt - 4096), but
    // the generation burned its output budget before finishing the summary
    // (observed: xhigh reasoning on a 185-message range-archive span).
    // pi-core throws it verbatim from getSummarizationFailure, with and
    // without the "Compaction failed: / Auto-compaction failed:" cycle
    // prefixes, so the match keys on the provider-independent suffix.
    if (
      /generation hit the token cap/i.test(errorMessage) ||
      /summary is incomplete/i.test(errorMessage)
    ) {
      return "summary-cap";
    }
    // Mirror shared.isTransientCompactionError / isContextWindowError here so
    // the trace names the class without re-running the full routing chain.
    const transient = [
      /529/,
      /overloaded/i,
      /rate.?limit/i,
      /too many requests/i,
      /server error/i,
      /service unavailable/i,
      /503/,
      /502/,
      /network/i,
      /timeout/i,
      /ECONNRESET/i,
      // Stream-cut classes: a summarization stream that ends mid-flight
      // (pi-ai throws "Stream ended without finish_reason") or is terminated
      // by the transport is a transient provider fault, and the trace says so.
      /stream ended/i,
      /terminated/i,
    ];
    const contextWindow = [
      /context window exceeds limit/i,
      /context length exceeded/i,
      /maximum context length/i,
      /token limit exceeded/i,
      /too many tokens/i,
      /invalid_request_error.*context/i,
    ];
    if (contextWindow.some((p) => p.test(errorMessage))) return "context-window";
    if (transient.some((p) => p.test(errorMessage))) return "transient";
    return "unknown";
  }
  if (reason === "threshold" || reason === "manual") return "threshold";
  if (reason === "overflow") return "overflow";
  return "unknown";
}

/** One-line human summary: class, span size, retry count — the post-mortem triad. */
export function formatCompactionTraceLine(data: CompactionTraceData): string {
  const parts = [
    `class=${data.failureClass ?? "unknown"}`,
    `span=${data.spanMessages ?? "?"} msgs`,
    `retry=${data.retryAttempt ?? 0}`,
  ];
  if (data.willRetry) parts.push("will-retry");
  if (data.cancelSource) parts.push(`source=${data.cancelSource}`);
  if (data.durationMs !== undefined) parts.push(`duration=${Math.round(data.durationMs / 1000)}s`);
  if (data.reason) parts.push(`reason=${data.reason}`);
  // Appended last so the established class/span/retry prefix stays byte-stable
  // for log scrapers and fixtures.
  if (data.fromExtension) parts.push("from-extension");
  if (data.cycleId !== undefined) parts.push(`cycle=${data.cycleId}`);
  return parts.join(" ");
}

/**
 * The appendEntry seam of the extension API: the documented write path for
 * durable custom entries (it wraps the session manager's append and emits
 * entry_appended). Structural so tests can double it without a full API.
 */
export interface EntryAppender {
  appendEntry<T = unknown>(customType: string, data?: T): void;
}

/**
 * Write the durable trace: one custom session entry plus a log line. Every
 * non-success compaction outcome funnels here; the trace must never break the
 * compaction path it describes, so every failure degrades to logging.
 */
export function writeCompactionTrace(
  appender: EntryAppender,
  ctx: ExtensionContext,
  data: CompactionTraceData,
): void {
  try {
    let sessionId: string | undefined;
    let leafId: string | undefined;
    try {
      sessionId = getSessionIdSafe(ctx);
      leafId = getLeafIdSafe(ctx);
    } catch {
      /* identity unavailable - trace degrades to untagged */
    }
    const entryData = {
      event: data.event,
      failureClass: data.failureClass,
      reason: data.reason,
      errorMessage: data.errorMessage,
      spanMessages: data.spanMessages,
      retryAttempt: data.retryAttempt,
      willRetry: data.willRetry,
      fromExtension: data.fromExtension,
      cycleId: data.cycleId,
      cancelSource: data.cancelSource,
      durationMs: data.durationMs,
      sessionId,
      leafId,
      timestamp: new Date().toISOString(),
    };
    // The extension API's appendEntry is the documented write path; the
    // event-handler context types sessionManager as read-only, and reaching
    // through it would also bypass the entry_appended notification.
    try {
      appender.appendEntry(COMPACTION_TRACE_ENTRY_TYPE, entryData);
    } catch (e) {
      log.warn("[context-manager] compaction trace entry append failed:", e);
    }
    log.error(
      `[context-manager] Compaction ${data.event.toUpperCase()}: ` +
        `${formatCompactionTraceLine(data)}` +
        (data.errorMessage ? ` — ${data.errorMessage}` : ""),
    );
  } catch (e) {
    log.warn("[context-manager] compaction trace write failed:", e);
  }
}

/**
 * Count messages in a captured raw summarization input (the pending originals
 * capture) so the trace carries the span size. Returns undefined when the
 * capture is absent/unparseable — degrade to absent, never wrong.
 */
export function countSpanMessages(originals: string | undefined): number | undefined {
  if (!originals) return undefined;
  try {
    const parsed = JSON.parse(originals);
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}
