// Compaction handler: session_before_compact, session_compact (parking +
// outcome stages), session_compact_failed, and retry logic. pi-core 0.85.1
// has no `compaction_end` extension event - the cycle's outcome stages are
// wired to the events pi-core actually fires. This is the core of context
// management - compaction quality directly affects agent performance on long
// sessions.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionManager } from "../../../../lib/state/session-manager.js";

// Minimal typed interface for pi APIs that lack type declarations
interface FullSessionManager extends SessionManager {
  appendMessage(msg: unknown): string;
  getSessionId(): string;
  /** Flush tracking for compaction dedup */
  flushed?: boolean;
  /** File entries from session for diagnostics */
  fileEntries?: unknown[];
}
interface Preparation {
  messagesToSummarize?: unknown[];
}
import { addEvidence } from "../../../../lib/store/evidence-pool.js";
import { eventBus } from "../../../../lib/events/event-bus.js";
import { recordAdvice } from "../../../../lib/reasoning/advice-tracker.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { analyzeSession } from "../analysis.js";
import {
  getSessionIdSafe,
  getLeafIdSafe,
  getExtensionState,
  getFullSessionManager,
} from "../../../../lib/state/extension-state.js";
import {
  log,
  getCmState,
  isTransientCompactionError,
  isContextWindowError,
  isCompactionActive,
  setCompactionActive,
  recordCompactionOutcome,
  recordCompactionHealth,
  compactionRetryState,
  overflowRetryState,
  noteCompactionNoProgress,
  clearCompactionFailsafe,
  armCompactionFailsafeCut,
  consumeCompactionFailsafeCut,
  settleCompactionRetry,
  settleOverflowRetry,
  resetCompactionRetry,
  resetOverflowRetry,
  COMPACTION_NO_PROGRESS_LIMIT,
} from "./shared.js";
import { snapBoundaryOutsideToolBatch } from "./tool-batch-boundary.js";
import type { AgentMessage as CoreAgentMessage } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentMessage as FilterMessage } from "../../../../lib/utils/filter-safe-to-remove.js";
import { filterSafeToRemove } from "../../../../lib/utils/filter-safe-to-remove.js";
import { determineCompressionLevel } from "../../../../lib/detection/compression-strategy.js";
import {
  CONTEXT_COMPACT_REFUSE_PERCENT,
  USAGE_WHISPER_CRITICAL,
} from "../../../../lib/detection/context-thresholds.js";
import { estimateMessagesTokens, resolveWindow } from "../../../../lib/detection/context-usage.js";
import { semanticCompress } from "../semantic-compress.js";
import { onEvent } from "../../../../lib/events/event-types.js";
import {
  SESSION_SHUTDOWN,
  SESSION_COMPACT,
  SESSION_COMPACT_FAILED,
  SESSION_BEFORE_COMPACT,
  MESSAGE_END,
  AGENT_SETTLED,
  INPUT,
} from "../../../../lib/core/event-names.js";
import {
  handleOverflowFailure,
  handleTransientError,
  handleContextWindowError,
  handleThresholdFailure,
  handleSummaryCapFailure,
  triggerFailsafeCompaction,
} from "./compaction-retry.js";
import {
  COMPACTION_STALL_THRESHOLD_MS,
  armCompactionWatchdog,
  clearCompactionWatchdog,
  getCompactionWatchdogArmedAt,
  handleSummaryCapAbort,
} from "./compaction-watchdog.js";
import {
  classifyCompactionFailure,
  countSpanMessages,
  writeCompactionTrace,
} from "./compaction-trace.js";
import { summarizeSpanInChunks } from "./compaction-chunked.js";
import { trackInjection } from "../../../../lib/utils/injection-tracker.js";

// Deduplication Guard
// NOTE: registerTurnEndRetryReset is registered in compaction-retry.ts and
// wired from index.ts. Test checks it's mentioned here.
// session_before_compact fires from TWO call sites in pi core:
// (1) compact() - manual /pi compact command
// (2) _runAutoCompaction() - auto-compaction triggered by context pressure
// Without a guard, our handler fires twice per compaction cycle.
const MAX_PROCESSED_COMPACTS = 200;
const _processedCompacts = new Map<string, number>();

/**
 * Cooldown window for the dedup guard. A later compaction cycle on the same
 * session+leaf that begins AFTER this window — or once compaction is no longer
 * in-flight — is NOT a duplicate; it must run. The guard only ever blocks the
 * in-cycle double-fire from pi-core's two call sites (compact() + _runAutoCompaction()).
 */
const COMPACT_COOLDOWN_MS = 20000;

// Summarizer thinking-off switch: pi-core forwards the session thinking level
// into its own summarization call
// (agent-session.js:1844 -> compaction.js createSummarizationOptions), and
// effort-based providers bill reasoning inside max_tokens — the same budget
// the summary needs; xhigh reasoning on a large span length-stops the summary.
// When a cycle is about to hand its span to pi-core's summarizer, switch the
// level off for the call and restore it at the cycle outcome (both outcome
// events fire on every cycle that armed the switch; shutdown is the
// backstop). Summaries are mechanical merges; xhigh is actively harmful
// there. Extension-owned chunked calls (range branch, recovery branch) pass
// reasoning "off" per call and never arm this.
function armSummarizerThinkingOff(pi: ExtensionAPI, ctx: ExtensionContext): void {
  try {
    const cmState = getCmState(ctx);
    if (cmState.pendingSummarizerThinkingLevel !== undefined) return; // already armed
    const model = ctx.model as { reasoning?: boolean } | undefined;
    if (!model?.reasoning) return; // nothing to strip
    const previous = pi.getThinkingLevel();
    if (previous === "off") return; // no change, no session entry
    cmState.pendingSummarizerThinkingLevel = previous;
    // "off" is accepted at runtime by pi-ai's clampThinkingLevel (it maps to
    // the model's lowest level or disables thinking), but the public union
    // doesn't list it yet — same boundary cast callLlm centralizes for its
    // reasoning option.
    pi.setThinkingLevel("off" as unknown as ThinkingLevel);
    log.info(
      `[context-manager] Summarizer thinking off: level ${previous} -> off for the ` +
        `summarization call (restored at cycle outcome)`,
    );
  } catch (e) {
    log.warn(
      "[context-manager] thinking switch unavailable - summarizer runs at the session level:",
      e,
    );
  }
}

function restoreSummarizerThinkingLevel(pi: ExtensionAPI, ctx: ExtensionContext): void {
  try {
    const cmState = getCmState(ctx);
    const previous = cmState.pendingSummarizerThinkingLevel;
    if (previous === undefined) return;
    cmState.pendingSummarizerThinkingLevel = undefined;
    pi.setThinkingLevel(previous as ThinkingLevel);
    log.info(`[context-manager] Summarizer thinking restored: level ${previous}`);
  } catch (e) {
    log.warn("[context-manager] thinking restore failed - level may stay switched:", e);
  }
}

/**
 * Concurrency-scoped dedup guard. Returns true when the compaction should
 * proceed, false when it is a duplicate of a compaction already in-flight for
 * this leaf (same cycle).
 *
 * The dedupe covers only the in-cycle double-fire — when a compaction was
 * already in-flight as this firing began (captured before the handler marks
 * this cycle active) AND it was already seen within the cooldown window. A
 * persistent whole-session key would starve legitimate later compactions on
 * the same leaf ("duplicate - skipping"); once the cycle completes
 * (active=false) or the cooldown lapses, a fresh cycle on the same leaf runs.
 */
function markCompactProcessed(
  sessionId: string,
  leafId: string,
  ctx: ExtensionContext,
  inFlightBefore: boolean,
): boolean {
  const key = `${sessionId}::${leafId}`;
  const now = Date.now();
  const last = _processedCompacts.get(key);
  const fresh = last !== undefined && now - last < COMPACT_COOLDOWN_MS;
  // Dedupe only if a compaction was ALREADY in-flight when this firing began
  // (the in-cycle double-fire from pi-core's compact() + _runAutoCompaction())
  // AND we already saw this leaf within the cooldown window. A new cycle that
  // begins after completion — or after the cooldown lapses — must run.
  if (inFlightBefore && fresh) {
    return false;
  }
  // LRU: remove oldest half when over limit
  if (_processedCompacts.size >= MAX_PROCESSED_COMPACTS) {
    const oldest = [..._processedCompacts.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, Math.floor(MAX_PROCESSED_COMPACTS / 2));
    for (const [k] of oldest) _processedCompacts.delete(k);
  }
  _processedCompacts.set(key, now);
  return true;
}

function clearProcessedCompacts(sessionId: string, leafId: string): void {
  _processedCompacts.delete(`${sessionId}::${leafId}`);
}

/**
 * Extract the messages in a declared archive span [startIndex..endIndex] from
 * the session branch, mirroring pi-core's compaction message extraction.
 */
function collectRangeMessages(
  branch: Array<{ id: string; type?: string; message?: any }>,
  startIndex: number,
  endIndex: number,
): any[] {
  const messages: any[] = [];
  const lo = Math.max(0, startIndex);
  const hi = Math.min(branch.length - 1, endIndex);
  for (let i = lo; i <= hi; i++) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message) {
      messages.push(entry.message);
    }
  }
  return messages;
}

/**
 * Count of messages in this cycle's RAW summarization input —
 * the captured originals JSON (what the compaction summary replaced). Returns
 * undefined when the capture is absent/unparseable — telemetry degrades to
 * absent, never wrong.
 */
function countSummarizedMessages(originals: string | undefined): number | undefined {
  if (!originals) return undefined;
  try {
    const parsed = JSON.parse(originals);
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Count the messages that remain LIVE in context after a compaction with the
 * given firstKeptEntryId anchor: message entries from the anchor (inclusive)
 * to the branch end, minus any the recovery path omitted. A `context_edit`
 * with `replacement === null` removes the TARGET from model context without
 * removing it from the branch, so counting branch messages alone overcounts by
 * the omitted attempts (exactly the entries overflow recovery appends after
 * the anchor). Returns undefined when the anchor is missing from the branch
 * (degrade - telemetry is never wrong, at worst absent).
 */
function countKeptMessages(
  branch: Array<{
    id: string;
    type?: string;
    message?: any;
    targetId?: string;
    replacement?: unknown;
  }>,
  firstKeptEntryId: string | undefined,
): number | undefined {
  if (!firstKeptEntryId) return undefined;
  const anchorIndex = branch.findIndex((entry) => entry.id === firstKeptEntryId);
  if (anchorIndex < 0) return undefined;
  // Effective omissions, last edit per target wins (pi keeps a Map keyed by
  // targetId): a later non-null replacement re-includes the target.
  const omitted = new Set<string>();
  for (const entry of branch) {
    if (entry?.type !== "context_edit" || !entry.targetId) continue;
    if (entry.replacement === null) omitted.add(entry.targetId);
    else omitted.delete(entry.targetId);
  }
  let kept = 0;
  for (let i = anchorIndex; i < branch.length; i++) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message && !omitted.has(entry.id)) kept++;
  }
  return kept;
}

/**
 * Stable fingerprint over the compaction INPUT (Pattern 8 delta-only borrow):
 * sha256(branchLength + "|" + entryIds(messagesToSummarize).join(",") + "|" +
 * firstKeptEntryId). Entry ids are stable across turns; timestamps and token
 * counts are excluded because they drift and would defeat the skip.
 *
 * Messages in messagesToSummarize are the same object references as
 * branch[i].message (pi-core's prepareCompaction pushes entry.message), so
 * entry ids are recovered by identity, in branch order.
 */
function computeCompactionFingerprint(
  branch: Array<{ id: string; type?: string; message?: any }>,
  messagesToSummarize: unknown[],
  firstKeptEntryId: string | undefined,
): string {
  const summarizeSet = new Set(messagesToSummarize);
  const ids: string[] = [];
  for (const entry of branch) {
    if (entry?.type === "message" && entry.message && summarizeSet.has(entry.message)) {
      ids.push(entry.id);
    }
  }
  return createHash("sha256")
    .update(`${branch.length}|${ids.join(",")}|${firstKeptEntryId ?? ""}`)
    .digest("hex");
}

// Verify / rollback stage (light path).
// A compaction that "succeeds" can still destroy context silently: an
// empty/boilerplate summary (the STEP 0.75 defect class), a summary larger than
// the dropped span (budget not recovered), or a branch left incoherent (missing
// first-kept anchor). Recording "success" on any truthy result with no
// coherence or budget validation is exactly that silent destruction.
//
// Light path: validation + honest failure feedback. NO destructive rollback —
// pi-core 0.84.2 has no snapshot mechanism; the branch file is append-only and
// originals are recoverable via context_navigate/archive (the append-only
// archive preserves every compaction's originals batch).

/**
 * Verify a completed compaction BEFORE recording success.
 *
 * - Coherence: compactionEntry must exist with a non-empty summary (trim
 *   length > 0) and firstKeptEntryId must be present. An empty summary is the
 *   STEP 0.75 defect class — caught here even though prevents it at the
 *   source.
 * - Budget: post-compaction usage (recomputed via analyzeSession) must be
 *   strictly below the pre-compaction usage captured at session_before_compact
 *   (<= 1pp slack: a drop of 1pp or less is a no-op treadmill). Only enforced
 *   when a pre-compaction value was captured; analysis failure degrades to
 *   coherence-only and never fails a compaction on missing telemetry.
 *
 * Returns { ok: true } when verification passes, or { ok: false, reason } with a
 * specific reason ("coherence..." vs "budget...").
 */
function verifyCompactionResult(
  event: {
    compactionEntry?: { id?: string; summary?: string };
    firstKeptEntryId?: string;
  },
  ctx: ExtensionContext,
  preCompactionUsagePercent: number | undefined,
): { ok: boolean; reason?: string } {
  // Coherence: non-empty summary + first-kept anchor present.
  const summary = event.compactionEntry?.summary?.trim() ?? "";
  if (summary.length === 0) {
    return {
      ok: false,
      reason: "coherence: compaction summary is empty (STEP 0.75 defect class)",
    };
  }
  if (!event.firstKeptEntryId) {
    return {
      ok: false,
      reason: "coherence: firstKeptEntryId missing — branch anchor lost",
    };
  }
  // Budget: post-compaction usage must be strictly below the pre-compaction
  // usage captured at session_before_compact (<= 1pp slack).
  if (preCompactionUsagePercent !== undefined) {
    let postUsagePercent = 0;
    try {
      postUsagePercent = analyzeSession(ctx).usage.percent;
    } catch {
      /* analysis unavailable - cannot verify budget; do not fail the compaction */
    }
    if (postUsagePercent >= preCompactionUsagePercent - 1) {
      return {
        ok: false,
        reason:
          `budget: post-compaction usage ${postUsagePercent.toFixed(1)}% did not drop ` +
          `below pre-compaction ${preCompactionUsagePercent.toFixed(1)}% (<=1pp slack)`,
      };
    }
  }
  return { ok: true };
}

// Append-only originals archive.
// A compaction that "succeeded" but destroyed context needs recovery, not
// just detection: the dropped originals stay buried in the append-only session
// file in a way the live branch can't navigate to. EVERY compaction that
// proceeded writes its raw originals (captured at session_before_compact,
// pre-compression) into an explicit on-disk archive (pi-condense's post-hoc
// recovery-archive pattern; no new dependency), so originals are never
// silently discarded from the live branch just because verification happened
// to pass.

/**
 * Write the append-only originals archive. Called from BOTH the
 * session_compact outcome stage's success path (reason "compact") and the
 * verify-failure path (reason = verify.reason). Always-on per (lossless
 * default): whenever
 * originals were captured (a compaction actually proceeded), the exact
 * pre-compression originals are appended as one JSON line to
 * <sessionDir>/archives/<sessionId>-<leafId>-<epoch>.jsonl (mkdir -p
 * archives) and the recovery path is logged. VerifyFailed +
 * pendingCompactionOriginals are ALWAYS cleared in finally here (the archive
 * write owns the flag lifecycle) so no stale flag or capture lingers on
 * success or failure.
 *
 * Each line also carries the compacted-vs-kept message counter
 * (compactedMessages = this cycle's raw summarization input, keptMessages =
 * messages still live from the firstKeptEntryId anchor), so post-hoc loss
 * questions are answerable from the durable per-compaction record. Counts are
 * omitted (undefined) when their source degraded — absent, never wrong.
 *
 * Session file access is READ-ONLY (rotation.ts statSync pattern): the session
 * file path is read from ctx.sessionManager (getSessionFile(), backed by the
 * private sessionFile field) and never written.
 */
function writeOriginalsArchive(
  ctx: ExtensionContext,
  reason: string | undefined,
  originals: string | undefined,
  counts?: { compactedMessages?: number; keptMessages?: number },
): void {
  try {
    // Always-on / lossless default: the archive is written whenever originals
    // were captured (a compaction actually proceeded), on BOTH the healthy and
    // verify-failed path (the !originals no-op below covers abort /
    // fingerprint-skip). Future opt-out extension point: a config toggle keyed
    // on getCmState(ctx) would re-introduce a gate here (e.g.
    // archiveOriginals === false).
    if (!originals) return; // nothing captured — nothing to archive

    const sm = ctx.sessionManager as {
      sessionFile?: string;
      getSessionFile?(): string | undefined;
    };
    const sessionFilePath = sm.sessionFile ?? sm.getSessionFile?.();
    if (!sessionFilePath) {
      log.warn("[context-manager] No session file path — originals archive skipped");
      return;
    }

    const sessionDir = dirname(sessionFilePath);
    const archivesDir = join(sessionDir, "archives");
    mkdirSync(archivesDir, { recursive: true });
    const sessionId = getSessionIdSafe(ctx);
    const leafId = getLeafIdSafe(ctx);
    const epoch = Date.now();
    const archivePath = join(archivesDir, `${sessionId}-${leafId}-${epoch}.jsonl`);
    const line = JSON.stringify({
      sessionId,
      leafId,
      reason,
      timestamp: new Date().toISOString(),
      compactedMessages: counts?.compactedMessages,
      keptMessages: counts?.keptMessages,
      originals,
    });
    appendFileSync(archivePath, `${line}\n`);
    // A: count coverage on a successful append only — an
    // archive write that threw must not inflate the coverage counter.
    recordCompactionHealth("totalArchivesWritten");
    log.info(
      `[context-manager] Originals archived to ${archivePath} (verify: ${reason}) — ` +
        `recover via context_navigate/read`,
    );
  } catch (e) {
    log.error("[context-manager] Originals archive write failed:", e);
  } finally {
    // Owns the flag lifecycle: verifyFailed must never linger after the
    // write attempt (success or failure), and the capture is consumed.
    try {
      const cmState = getCmState(ctx);
      cmState.verifyFailed = false;
      cmState.pendingCompactionOriginals = undefined;
    } catch {
      /* state unavailable */
    }
  }
}

// Pre-append queued message handling.
// When a user sends a message during compaction, it is queued in the TUI's
// compactionQueuedMessages (not in sessionManager yet).
//
// On compaction_end, the TUI calls rebuildChatFromMessages() BEFORE
// flushCompactionQueue delivers the user's message. This means the user's
// message is NOT in the rebuilt chat snapshot.
//
// Fix:
//  1. input event -> capture user's message text (TUI queues it after)
//  2. session_compact -> pre-append to sessionManager + intercept appendMessage
//  3. compaction_end -> rebuildChatFromMessages() sees user's message in session [ok]
//  4. flushCompactionQueue -> session.prompt() -> appendMessage intercept SKIPS duplicate
//  5. Auto (threshold/overflow): agent turn fires [ok] - the flush replay is
//     the resume. Manual: the replay is swallowed by the input-hook hold
//     (one-shot, armed here on reason=manual) - a manual compaction is a full
//     stop; the parked message waits for the operator's next input or a wake.
//
// The intercept works by wrapping sessionManager.appendMessage to detect when
// flushCompactionQueue's session.prompt() fires (it calls appendMessage via the
// message_end handler). We skip the duplicate by returning the pre-appended
// entry ID instead of creating a new one.

// Session-scoped compaction intercept state.
// The fields below are all part of the same lifecycle: capture a user
// message during compaction, pre-append it, intercept the duplicate, then
// restore; plus the manual-compaction hold (arm/swallow/disarm). One
// per-session state object — separate module-level `let` variables would
// leak across sessions in multi-session pi-core deployments.

interface CompactionInterceptState {
  /** Text of the user's message queued during compaction. */
  queuedDuringCompaction: string | undefined;
  /** Entry ID of the message pre-appended to sessionManager. */
  preAppendedEntryId: string | undefined;
  /** Original sessionManager.appendMessage - restored after intercept window. */
  origAppendMessage: ((msg: any) => string) | undefined;
  /** Whether the intercept is currently active. */
  interceptActive: boolean;
  /** SessionManager reference at time of intercept setup. */
  interceptedSmRef: any;
  /**
   * Manual-compaction hold, armed by session_compact when a manual compaction
   * succeeded with a parked message. One-shot: the first post-compaction input
   * event spends it (swallowing the TUI flush's replay of the held text, or
   * disarming for any other input). A manual compaction is a full stop: its
   * parked message must not start a turn via the flush replay.
   */
  holdQueuedPrompt: boolean;
  /** Text snapshot held by the armed hold (isolated from later captures). */
  heldQueuedText: string | undefined;
  /**
   * Owner inputs seated durably at receipt and not yet confirmed delivered.
   * Unlike the fields above, this list is NOT part of the intercept window:
   * it survives clearInterceptState so a failure cannot wipe the only
   * in-memory pointer to text the durable seat still holds.
   */
  pendingOwnerInputs: PendingOwnerInput[];
  /**
   * Recently delivered owner texts (bounded ring). A replay of a text this
   * extension already parked (the TUI flush replay after an auto compaction)
   * must not be re-seated as if it were a fresh receipt.
   */
  deliveredOwnerInputs: string[];
}

interface PendingOwnerInput {
  text: string;
  /** Which queue the text entered: the compaction capture, or a steer into a run. */
  kind: "compaction" | "steer";
  seatedAt: number;
}

/**
 * Source stamped on the durable seat record. A reader that has to recover
 * owner input after a crash looks for this value in the branch's
 * `braid_injection` entries.
 */
export const OWNER_INPUT_SEAT_SOURCE = "context-manager/owner-input-seat";

/** Bounded ring so a long session's delivery confirmations stay small. */
const MAX_DELIVERED_OWNER_INPUTS = 32;

const EMPTY_INTERCEPT_STATE: CompactionInterceptState = {
  queuedDuringCompaction: undefined,
  preAppendedEntryId: undefined,
  origAppendMessage: undefined,
  interceptActive: false,
  interceptedSmRef: undefined,
  holdQueuedPrompt: false,
  heldQueuedText: undefined,
  pendingOwnerInputs: [],
  deliveredOwnerInputs: [],
};

function getInterceptState(ctx: ExtensionContext): CompactionInterceptState {
  return getExtensionState(ctx, "context-manager/compaction-intercept", () => ({
    ...EMPTY_INTERCEPT_STATE,
    // Fresh arrays: the spread above copies the const's references, and a
    // push into a shared array would leak one session's seats into the next.
    pendingOwnerInputs: [],
    deliveredOwnerInputs: [],
  }));
}

/**
 * Create a wrapper for sessionManager.appendMessage that skips the duplicate
 * when flushCompactionQueue's session.prompt() fires after our pre-append.
 *
 * SAFETY: Captures the original appendMessage in the closure at creation time.
 * This prevents self-recursion (max call stack) if intercept state is cleared
 * while the wrapper is still in place — the fallback still delegates to the
 * original function rather than calling sessionManager.appendMessage (which
 * IS the wrapper itself).
 *
 * Returns the pre-appended entry ID to avoid creating a duplicate entry.
 */
function createSkipDuplicateWrapper(
  sessionManager: any,
  ctx: ExtensionContext,
  originalAppendMessage: (msg: any) => string,
): (msg: any) => string {
  return (msg: any) => {
    const st = getInterceptState(ctx);

    // Safety: if intercept was deactivated (e.g., the outcome stage closing a
    // cycle with no queued messages), pass through to the original without any
    // duplicate detection.
    if (!st.interceptActive) {
      return originalAppendMessage.call(sessionManager, msg);
    }

    // Only messages with content[] can be the duplicate user message.
    // BashExecutionMessage has NO `content` field - must pass through.
    const content = msg?.content;
    if (Array.isArray(content)) {
      const text = content[0]?.text;
      if (typeof text === "string" && text === st.queuedDuringCompaction) {
        // Skip - this is the duplicate from session.prompt()'s message_end handler.
        // The original from session_compact is already in sessionManager.
        // Return the pre-appended entry ID so the caller gets a valid ID.
        return st.preAppendedEntryId ?? "";
      }
    }

    // Not a duplicate — delegate to original (captured in closure).
    return originalAppendMessage.call(sessionManager, msg);
  };
}

/**
 * Attempt to restore sessionManager.appendMessage from the intercept.
 * Called wherever the intercept window can close without the flush replay:
 * the input hook that spends the manual-compaction hold, the message_end
 * backup, session_compact_failed, and session shutdown.
 */
export function tryRestoreAppendMessage(ctx: ExtensionContext): void {
  const st = getInterceptState(ctx);
  if (!st.interceptActive || !st.origAppendMessage) return;
  // The install side wraps the manager ctx exposes (getFullSessionManager),
  // so the restore must read the same handle for the same-instance guard
  // below to mean anything. pi's ExtensionAPI carries no sessionManager.
  const sm = getFullSessionManager(ctx);
  if (!sm) {
    // No sessionManager available - clear intercept state.
    st.interceptActive = false;
    st.origAppendMessage = undefined;
    st.interceptedSmRef = undefined;
    return;
  }
  // Only restore if the sessionManager is the same one we intercepted.
  // After session replacement (reload/newSession), sm is a new instance
  // and the old st.origAppendMessage is stale - DO NOT restore.
  if (sm !== st.interceptedSmRef) {
    log.debug("[context-manager] Skipped intercept restore - sessionManager replaced");
    st.interceptActive = false;
    st.origAppendMessage = undefined;
    st.interceptedSmRef = undefined;
    return;
  }
  // Verify appendMessage is still our wrapper (not further mutated).
  // If it's no longer the wrapper, someone else already restored it.
  if (typeof sm.appendMessage !== "function" || sm.appendMessage === st.origAppendMessage) {
    // Not wrapped or already restored - nothing to do.
    st.interceptActive = false;
    st.origAppendMessage = undefined;
    st.interceptedSmRef = undefined;
    return;
  }
  sm.appendMessage = st.origAppendMessage;
  st.origAppendMessage = undefined;
  st.interceptActive = false;
  st.interceptedSmRef = undefined;
  log.debug("[context-manager] AppendMessage intercept restored");
}

export function clearInterceptState(ctx: ExtensionContext): void {
  // Unwrap before clearing: the bookkeeping below is what the restore path
  // reads, so clearing first would strand the wrapper on the session manager.
  tryRestoreAppendMessage(ctx);
  const st = getInterceptState(ctx);
  st.queuedDuringCompaction = undefined;
  st.preAppendedEntryId = undefined;
  st.origAppendMessage = undefined;
  st.interceptActive = false;
  st.interceptedSmRef = undefined;
  st.holdQueuedPrompt = false;
  st.heldQueuedText = undefined;
  setCompactionActive(false, ctx);
}

/**
 * Force-persist the session to disk.
 * This is needed because sessionManager._persist() has a no-assistant guard that
 * returns early without writing if there's no assistant message yet.
 * When we pre-append a user message during compaction (before any assistant response),
 * _persist() silently ignores it, causing the message to be lost on session reload.
 *
 * This function manually writes all pending entries to disk, bypassing the guard.
 */
function forcePersistSession(sm: any): void {
  try {
    if (!sm?.sessionFile || !sm?.persist) return;
    const flushed = (sm as FullSessionManager).flushed;
    const fileEntries = (sm as FullSessionManager).fileEntries;
    // The force-write reaches pi-core's private buffer by design (its own
    // _persist() guards on a landed user/assistant message). A rename of
    // either private field would otherwise silently turn this loss-prevention
    // write into a no-op, or re-append entries that were already persisted.
    // Verify the private shape before writing.
    if (typeof flushed !== "boolean" || !Array.isArray(fileEntries)) {
      log.warn(
        "[context-manager] Force-persist skipped: sessionManager private layout changed " +
          "(expected flushed:boolean, fileEntries:array)",
      );
      return;
    }
    if (!flushed && fileEntries.length > 0) {
      // Write all entries to establish the session file with all content
      for (const entry of fileEntries) {
        appendFileSync(sm.sessionFile, `${JSON.stringify(entry)}\n`);
      }
      (sm as FullSessionManager).flushed = true;
      log.debug(
        `[context-manager] Force-persisted ${fileEntries.length} entries to ${sm.sessionFile}`,
      );
    }
  } catch (e) {
    log.error("[context-manager] Force-persist failed:", e);
  }
}

// Durable owner-input seat.
// The intercept state above is an in-memory seat, and a failed compaction
// wipes it (clearInterceptState) while the text exists nowhere else: the
// TUI's compaction queue lives in the TUI process, non-TUI callers have none,
// and a steer parked in pi's in-memory steering queue is invisible to the
// session tree. Owner text therefore gets a durable copy at receipt, written
// through the same store every tracked injection uses (`braid_injection`
// session entries; injection-tracker owns that write path), and delivery is
// confirmed by the session's own message events.
//
// The seat is a COPY, never a second queue: text pi still holds in its own
// queue is not re-delivered (a settled run's unconsumed steer is drained by
// the next run's start), and a text confirmed delivered is never delivered
// again.

/** Record owner text in the durable seat, once per undelivered text. */
function seatOwnerInput(
  ctx: ExtensionContext,
  text: string,
  kind: PendingOwnerInput["kind"],
): void {
  try {
    const st = getInterceptState(ctx);
    if (st.deliveredOwnerInputs.includes(text)) return;
    if (st.pendingOwnerInputs.some((item) => item.text === text)) return;
    st.pendingOwnerInputs.push({ text, kind, seatedAt: Date.now() });
    trackInjection({
      type: "context",
      source: OWNER_INPUT_SEAT_SOURCE,
      content: text,
      display: true,
      steer: kind === "steer",
      fullContent: true,
    });
  } catch (e) {
    log.warn("[context-manager] owner-input seat write failed:", e);
  }
}

/**
 * Confirm delivery and drop the pending seat. `remember` also suppresses
 * re-seating a replay of this text: a park is followed by the TUI flush
 * replay, which is a second receipt of text already in the session.
 */
function markOwnerInputDelivered(ctx: ExtensionContext, text: string, remember = false): void {
  const st = getInterceptState(ctx);
  const index = st.pendingOwnerInputs.findIndex((item) => item.text === text);
  if (index >= 0) st.pendingOwnerInputs.splice(index, 1);
  if (index < 0 && !remember) return;
  st.deliveredOwnerInputs.push(text);
  while (st.deliveredOwnerInputs.length > MAX_DELIVERED_OWNER_INPUTS) {
    st.deliveredOwnerInputs.shift();
  }
}

/**
 * Write one owner text into the session as a user message and force-persist
 * it - the delivery the successful compaction path pre-appends, reused by the
 * failure and settle paths. Returns false when no session manager is
 * reachable; the durable seat still holds the text.
 */
function parkOwnerTextInSession(ctx: ExtensionContext, text: string): boolean {
  const sm = getFullSessionManager(ctx);
  if (!sm || typeof sm.appendMessage !== "function") return false;
  try {
    const st = getInterceptState(ctx);
    const messageObj = {
      role: "user" as const,
      content: [{ type: "text" as const, text }],
      timestamp: Date.now(),
    };
    // Append through the original when the intercept wrapper is already
    // installed for THIS session manager, so the wrapper's duplicate skip
    // cannot swallow this write. A replaced manager (session reload) must
    // never receive the write through the stale binding.
    const reuseWrapper = Boolean(
      st.interceptActive && st.origAppendMessage && st.interceptedSmRef === sm,
    );
    const append =
      reuseWrapper && st.origAppendMessage ? st.origAppendMessage : sm.appendMessage.bind(sm);
    st.preAppendedEntryId = append(messageObj);
    if (!reuseWrapper) {
      // Fresh intercept window: wrap appendMessage so the flush replay of this
      // text is skipped instead of creating a duplicate entry.
      st.origAppendMessage = sm.appendMessage.bind(sm);
      sm.appendMessage = createSkipDuplicateWrapper(sm, ctx, st.origAppendMessage);
      st.interceptedSmRef = sm;
      st.interceptActive = true;
    }
    forcePersistSession(sm);
    markOwnerInputDelivered(ctx, text, true);
    log.info(
      `[context-manager] Owner input parked in the session (entry: ${st.preAppendedEntryId})`,
    );
    return true;
  } catch (e) {
    log.error("[context-manager] Failed to park owner input in the session:", e);
    return false;
  }
}

/**
 * Re-deliver owner inputs still pending at a lifecycle boundary.
 *
 * - "failure": the compaction cycle landed no entry. Deliver now only when the
 *   session is idle; a live run must not receive a raw session write mid-run
 *   (message order), so the text waits for the settle boundary.
 * - "settle": the run has settled. Texts pi still holds in its own queue are
 *   skipped - the next run's start drains them (the agent loop polls the
 *   steering queue at run start), and delivering here would duplicate that.
 * - "shutdown": last chance to persist; deliver everything still pending.
 */
export function flushPendingOwnerInputs(
  ctx: ExtensionContext,
  phase: "failure" | "settle" | "shutdown",
): void {
  let pending: PendingOwnerInput[];
  try {
    pending = [...getInterceptState(ctx).pendingOwnerInputs];
  } catch {
    return;
  }
  if (pending.length === 0) return;
  if (phase === "failure" && !readIdle(ctx)) return;
  if (phase === "settle" && readHasPendingMessages(ctx)) return;
  for (const item of pending) {
    parkOwnerTextInSession(ctx, item.text);
  }
}

/** Live idle read, fail-open to delivery (a missed delivery loses owner text). */
function readIdle(ctx: ExtensionContext): boolean {
  try {
    return typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
  } catch {
    return true;
  }
}

/**
 * Live queued-messages read. Fail-closed: an unreadable queue must not make
 * the settle flush re-deliver text pi may still be holding.
 */
function readHasPendingMessages(ctx: ExtensionContext): boolean {
  try {
    return typeof ctx.hasPendingMessages === "function" ? ctx.hasPendingMessages() : false;
  } catch {
    return false;
  }
}

/**
 * Drop the seat bookkeeping. For shutdown (after the flush above) and for
 * fixtures; the durable entries stay in the session either way.
 */
export function clearOwnerInputSeats(ctx: ExtensionContext): void {
  const st = getInterceptState(ctx);
  st.pendingOwnerInputs.length = 0;
  st.deliveredOwnerInputs.length = 0;
}

// Compaction Instructions Builder
// Generates smarter instructions for the summarization model.
// The key insight: tell the model WHAT to preserve, not just "summarize".

function buildCompactionInstructions(audit: any): string[] {
  const instructions: string[] = [];

  // 1. Task state preservation
  if (audit.tagCount > 0) {
    instructions.push(
      `Session has ${audit.tagCount} checkpoint(s): preserve tag labels for navigation.`,
    );
  }

  // 2. Prune candidates - tell model what to cut
  const highPriorityPrune = audit.candidates?.filter((c: any) => c.score >= 0.6) ?? [];
  if (highPriorityPrune.length > 3) {
    instructions.push(
      `${highPriorityPrune.length} entries are prune candidates with low semantic value - summarize briefly.`,
    );
  }

  // 3. Context pressure - tell model how aggressive to be
  if (audit.usage.percent > 85) {
    instructions.push(
      `CRITICAL: Context at ${audit.usage.percent.toFixed(0)}% - aggressively summarize. ` +
        `Preserve: (1) active task/goals, (2) key file paths and edits, (3) error states. ` +
        `Discard: verbose tool outputs, repeated reads, exploration logs.`,
    );
  } else if (audit.usage.percent > CONTEXT_COMPACT_REFUSE_PERCENT) {
    instructions.push(
      `Context at ${audit.usage.percent.toFixed(0)}% - moderate summarization. ` +
        `Keep: task context, recent decisions, pending work. Summarize: older tool outputs.`,
    );
  }

  // 4. Semantic preservation rules
  instructions.push(
    "Preserve tool-call/result pairs together - never split a tool call from its result. " +
      "If a tool call produced an error, keep both the call and the error.",
  );

  // 5. Memory hint
  instructions.push(
    "After compaction: consider storing key learnings in memory for cross-session continuity.",
  );

  return instructions;
}

// Session before compact: custom instructions before compaction for
// smarter LLM summarization.
//
// The path always uses LLM summarization - it's fast (a few seconds) and
// produces better summaries than hard truncation; pi-core handles its own
// last-resort safety net.
//
// Flow:
//  1. Deduplicate - prevent two compaction entries from manual+auto call sites
//  2. Pre-filter - remove 100%-safe-to-remove items (STEP 1)
//  3. Instruct - inject smart summarization instructions (STEP 2)
//     pi core then calls LLM summarization with our instructions

/**
 * Capture the messages a deterministic cut drops as this cycle's originals
 * capture, so the trace's span size and the originals archive describe the cut
 * that actually landed rather than pi-core's default token-cut span. Degrades
 * to the existing capture, never to a wrong one.
 */
function captureDroppedSpanBefore(ctx: ExtensionContext, cutEntryId: string): void {
  try {
    const sm = ctx.sessionManager;
    const branch =
      typeof (sm as { getBranch?: () => unknown[] }).getBranch === "function"
        ? ((sm as { getBranch: () => unknown[] }).getBranch() ?? [])
        : [];
    const cutIndex = branch.findIndex((entry) => (entry as { id?: string })?.id === cutEntryId);
    if (cutIndex < 0) return;
    const droppedMessages: unknown[] = [];
    for (const entry of branch.slice(0, cutIndex)) {
      const message = (entry as { type?: string; message?: unknown }).message;
      if ((entry as { type?: string }).type === "message" && message) droppedMessages.push(message);
    }
    getCmState(ctx).pendingCompactionOriginals = JSON.stringify(droppedMessages);
  } catch {
    /* capture replacement unavailable - telemetry degrades to the default snapshot */
  }
}

/**
 * Deterministic no-LLM cut point: the last rung of the summary-cap ladder.
 * Persists an extension compaction result that drops the oldest entries and
 * keeps the recent tail live - the same cut shape the high-context guard
 * persists, reused here so a bounded summarizer failure can never leave a
 * session unable to compact. Returns null when no cut point resolves (the
 * caller then cancels as before).
 *
 * `reason` and `detail` are the landed summary's own account of why the cut was
 * taken; the defaults describe the bounded-summarizer failure this rung was
 * first built for, and the fail-safe rung passes its own.
 */
function buildDeterministicCut(
  ctx: ExtensionContext,
  prep: { tokensBefore?: number } | undefined,
  account: {
    reason?: string;
    detail?: string;
  } = {},
): {
  compaction: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details: { readFiles: string[]; modifiedFiles: string[] };
  };
} | null {
  const reason = account.reason ?? "after a bounded summarizer failure";
  const detail =
    account.detail ?? "(the chunked summarizer exhausted its bounded budget on this span)";
  try {
    const sm = ctx.sessionManager;
    const branch =
      typeof (sm as { getBranch?: () => unknown[] }).getBranch === "function"
        ? ((sm as { getBranch: () => unknown[] }).getBranch() ?? [])
        : [];
    const keepCount = Math.min(50, Math.max(10, Math.floor(branch.length * 0.3)));
    // The deterministic cut is a supplied boundary: snap it out of any tool
    // batch it lands in (HTTP 400: a kept slice that opens with a tool result
    // has no preceding tool_calls).
    const cutIndex = snapBoundaryOutsideToolBatch(branch, Math.max(0, branch.length - keepCount));
    const cutEntryId = (branch[cutIndex] as { id?: string } | undefined)?.id;
    if (!cutEntryId || cutIndex <= 0) return null;
    const keptCount = branch.length - cutIndex;
    const cmState = getCmState(ctx);
    cmState.slideMode = {
      active: true,
      cutEntryId,
      keepCount: keptCount,
      droppedCount: cutIndex,
      timestamp: Date.now(),
    };
    captureDroppedSpanBefore(ctx, cutEntryId);
    return {
      compaction: {
        summary:
          `Deterministic cut ${reason}: dropped the ${cutIndex} entries ` +
          `before the cut without LLM summarization ${detail}. The last ${keptCount} entries ` +
          `remain live; dropped content stays in the append-only session file and the originals archive.`,
        firstKeptEntryId: cutEntryId,
        tokensBefore: typeof prep?.tokensBefore === "number" ? prep.tokensBefore : 0,
        details: { readFiles: [], modifiedFiles: [] },
      },
    };
  } catch (err) {
    log.error("[context-manager] deterministic cut failed:", err);
    return null;
  }
}

export function registerBeforeCompactHandler(pi: ExtensionAPI): void {
  // Input hook: capture user's queued message during compaction
  // When the user sends a message while compaction is running, it is queued in
  // TUI's compactionQueuedMessages (not persisted to sessionManager yet).
  // We capture the text here so we can pre-append it to sessionManager in
  // session_compact (before TUI's rebuildChatFromMessages runs).
  pi.on(INPUT, (event: any, ctx: ExtensionContext) => {
    if (!event?.text) return;
    // Durable seat at receipt: text entering a queue this extension cannot
    // verify drains (the compaction capture window, or a steer/follow-up into
    // a run) gets its durable copy before any cycle can consume the capture.
    // An idle prompt is delivered by definition and is not seated.
    // Per-session active read: the ctx-less fallback is a single-session
    // shortcut, and this hook's ctx is the session the text belongs to.
    const compactionActive = isCompactionActive(ctx);
    if (compactionActive || event.streamingBehavior !== undefined) {
      seatOwnerInput(ctx, event.text, compactionActive ? "compaction" : "steer");
    }
    // Guard: only capture messages typed DURING active compaction.
    // Messages typed before compaction starts are already in sessionManager
    // and should NOT be pre-appended (would create a duplicate).
    if (compactionActive) {
      const st = getInterceptState(ctx);
      if (st.queuedDuringCompaction === undefined) {
        st.queuedDuringCompaction = event.text;
      }
    }
    // Manual-compaction hold (armed in session_compact): a manual compaction is
    // a full stop: the TUI's post-compaction flush replays the parked message
    // via session.prompt(text, {streamingBehavior}), which would start a fresh
    // assistant turn from pre-compaction input. The hold is one-shot: the first
    // post-compaction input event spends it. Swallow only the exact replay:
    // held text arriving as a queued prompt (streamingBehavior set, the flush's
    // call shape; a genuinely new idle submit carries no streamingBehavior).
    // Any other input disarms without swallowing. Either way the parked text
    // stays in the session (pre-appended at session_compact) and the intercept
    // wrapper is restored, since the flush it guarded can no longer duplicate.
    const st = getInterceptState(ctx);
    if (st.holdQueuedPrompt) {
      const isFlushReplay =
        event.text === st.heldQueuedText && event.streamingBehavior !== undefined;
      st.holdQueuedPrompt = false;
      st.heldQueuedText = undefined;
      st.queuedDuringCompaction = undefined;
      tryRestoreAppendMessage(ctx);
      if (isFlushReplay) {
        log.info(
          "[context-manager] Manual compaction: flush replay of parked message swallowed - no turn from pre-compaction input",
        );
        return { action: "handled" };
      }
    }
  });

  pi.on(SESSION_BEFORE_COMPACT, async (event: any, ctx: ExtensionContext) => {
    try {
      const sessionId = getSessionIdSafe(ctx);
      const leafId = getLeafIdSafe(ctx);
      // Capture whether a compaction is ALREADY in-flight when this firing
      // begins (a same-cycle double-fire), BEFORE we mark this cycle active.
      const wasCompactionInFlight = isCompactionActive(ctx);
      // P2a: carry the in-flight capture to the outcome stage so an abort of
      // this cycle can be tagged with whether another compaction was
      // in-flight. Store before the dedup early-return so even a second
      // (deduped) firing leaves
      // the tag for the abort path.
      try {
        getCmState(ctx).inFlightBeforeCapture = wasCompactionInFlight;
      } catch {
        /* state unavailable - abort tagging degrades to untagged */
      }
      setCompactionActive(true, ctx);
      // Arm the stall watchdog: an in-flight cycle that never reaches an
      // outcome (a summarization stream stalled mid-flight) must not freeze
      // the agent. Re-firings of the same cycle just refresh the deadline.
      armCompactionWatchdog(pi, ctx, { reason: event.reason });
      // Cycle identity for post-hoc pairing: one monotonic counter per
      // session_before_compact firing, written into every trace as `cycleId`
      // so an outcome names the attempt it belongs to rather than being
      // reconstructable only by entry ordering. Mirrors the watchdog's
      // per-arm counter.
      try {
        const cmc = getCmState(ctx);
        cmc.compactionCycleId = (cmc.compactionCycleId ?? 0) + 1;
      } catch {
        /* state unavailable - cycle id degrades to absent in the trace */
      }
      if (!markCompactProcessed(sessionId, leafId, ctx, wasCompactionInFlight)) {
        log.info("[context-manager] session_before_compact duplicate - skipping");
        return;
      }
      // Fresh cycle: the previous cycle's capture and manual-compaction hold
      // are spent. Clearing here keeps the capture keyed to THIS cycle (a stale
      // text would be pre-appended as a duplicate at this cycle's session_compact
      // and would arm the hold against the wrong message), and disarms a hold
      // that survived its flush window unspent (e.g. a queue replayed entirely
      // as commands/steers produced no input event). The new cycle re-arms at
      // session_compact if it parks a message. The stale cancel source is
      // cleared too: an unattributed abort of THIS cycle must not inherit the
      // previous cycle's attribution.
      try {
        const ist = getInterceptState(ctx);
        ist.queuedDuringCompaction = undefined;
        ist.holdQueuedPrompt = false;
        ist.heldQueuedText = undefined;
        // The replay suppression is cycle-scoped: a text parked by the cycle
        // that just closed must not suppress a seat for the same text typed
        // into a later cycle.
        ist.deliveredOwnerInputs = [];
      } catch {
        /* intercept state unavailable - fresh-cycle hygiene degrades to no-op */
      }
      try {
        getCmState(ctx).cancelSource = undefined;
        getCmState(ctx).summaryCapCancelError = undefined;
      } catch {
        /* state unavailable - abort attribution degrades to untagged */
      }
      // Reset the pre-compaction usage capture so a stale
      // value from a previous cycle can never trigger a false budget failure at
      // the outcome stage. A fresh value is stashed below wherever an existing
      // analyzeSession runs (fingerprint block + STEP 0.75 guard).
      try {
        getCmState(ctx).preCompactionUsagePercent = undefined;
      } catch {
        /* state unavailable - budget verify degrades to coherence-only */
      }
      const prep = event.preparation;
      // Read once, before any branch that may rewrite event.customInstructions:
      // the SLIDE_MODE marker decides whether this cycle is the operator's own
      // deterministic cut (below).
      const customInstructions: string | undefined = event.customInstructions;
      const isOperatorSlide =
        typeof customInstructions === "string" && customInstructions.includes("SLIDE_MODE");

      // Fail-safe rung: the previous cycles each ended with no landed entry
      // while this session sat above the critical usage band, and the failure
      // routing armed a deterministic cut rather than trying the summarizer
      // again. Land it here, BEFORE the blocks below can cancel or hand a span
      // to a summarizer: pi-core consumes an extension compaction result
      // verbatim and skips its own call, so this cycle compacts with no LLM
      // request at all. An operator's own slide keeps precedence and leaves the
      // cut armed for the next cycle.
      if (prep && !isOperatorSlide) {
        const armed = consumeCompactionFailsafeCut(ctx);
        if (armed) {
          const cut = buildDeterministicCut(ctx, prep as { tokensBefore?: number }, {
            reason: armed.reason,
            detail: "(no summarizer call was attempted for this cut)",
          });
          if (cut) {
            log.error(
              `[context-manager] Fail-safe cut landing: ${armed.reason} - persisting the ` +
                `deterministic cut (no LLM summarization)`,
            );
            return cut;
          }
          // No cut point resolves (branch too short to drop anything). Reset the
          // ladder instead of re-dispatching per failure, so the next arm needs
          // a fresh sequence of no-progress cycles.
          log.error(
            `[context-manager] Fail-safe cut armed but no cut point resolves ` +
              `(branch has nothing to drop) - continuing with the normal path`,
          );
          clearCompactionFailsafe(ctx);
        }
      }

      // If the compaction INPUT is identical to the last SUCCESSFUL compaction
      // on this leaf, re-summarizing it is pure waste ("silent re-prime
      // starvation"): the agent keeps receiving the same summary and the
      // redundant steering (pre-filter, semantic compression, summarization)
      // burns tokens for zero new value.
      //
      // pi-core 0.83.0 (installed) cancel contract — verified:
      //   runner.js:570/586-588 — a session-before handler returning an object
      //     with a truthy `.cancel` short-circuits the event emit.
      //   agent-session.js:1396/1400-1402 (manual compact()) — event.reason ===
      //     "manual"; result?.cancel throws "Compaction cancelled".
      //   agent-session.js:1615-1629 (_runAutoCompaction) — event.reason is the
      //     auto reason ("threshold"|"overflow"); extensionResult?.cancel emits
      //     the internal compaction_end(aborted) plus the extension-visible
      //     session_compact_failed, and returns false (clean no-op, no branch
      //     mutation). So auto vs manual IS distinguishable and the cancel path
      //     is safe for auto.
      //
      // Decision rule: cancel ONLY the auto path (reason !== "manual"), and
      // ONLY when usage < 85 — critical pressure must still compact to avoid
      // overflow, and manual/agent-initiated compaction is explicit intent that
      // is never skipped.
      if (prep?.messagesToSummarize?.length) {
        const cmState = getCmState(ctx);
        const leafKey = `${sessionId}::${leafId}`;
        const branch =
          typeof ctx.sessionManager?.getBranch === "function"
            ? (ctx.sessionManager.getBranch() ?? [])
            : [];
        const currentFp = computeCompactionFingerprint(
          branch,
          prep.messagesToSummarize,
          (prep as any).firstKeptEntryId,
        );
        if (cmState.lastCompactionFingerprints?.[leafKey] === currentFp) {
          let usagePercent = 0;
          try {
            usagePercent = analyzeSession(ctx).usage.percent;
            // Capture pre-compaction usage for the
            // outcome-stage budget verify — reuses this analyzeSession (
            // code path). The STEP 0.75 guard below re-stashes the same value
            // for the standard path.
            cmState.preCompactionUsagePercent = usagePercent;
          } catch {
            /* non-fatal - analysis unavailable */
          }
          const isManual = event.reason === "manual";
          if (!isManual && usagePercent < 85) {
            log.info(
              `[context-manager] Input unchanged since last compaction — skipping ` +
                `(leaf ${leafKey}, usage ${usagePercent.toFixed(1)}%)`,
            );
            // Cancel the auto-compaction: pi-core emits the internal
            // compaction_end(aborted) plus the extension-visible
            // session_compact_failed, and returns false — a clean no-op that
            // leaves the branch untouched. Attribute the cancel so the failed
            // handler records a deliberate skip, not an unexplained abort.
            try {
              getCmState(ctx).cancelSource = "extension";
            } catch {
              /* state unavailable - cancel attribution degrades to untagged */
            }
            return { cancel: true, reason: "input unchanged since last compaction" };
          }
          log.info(
            `[context-manager] Input unchanged since last compaction but NOT skipping: ` +
              `${isManual ? "manual intent" : `critical usage ${usagePercent.toFixed(1)}%`}`,
          );
        }
        // Stash the current input fingerprint so session_compact can record it
        // on success — the branch is mutated by then, so it can't be recomputed.
        cmState.pendingCompactionFingerprint = currentFp;
      }

      // Capture the RAW originals for the recovery
      // archive. Placed AFTER the fingerprint block (which may cancel) and
      // BEFORE the semantic-compression block (STEP 1.5 replaces
      // prep.messagesToSummarize in place — capture must see the RAW originals,
      // byte-exact, independent of later in-place mutation). Serialized to JSON
      // so the snapshot is immutable; serialization failure degrades the
      // archive to off and never breaks the compaction path.
      if (prep?.messagesToSummarize?.length) {
        try {
          getCmState(ctx).pendingCompactionOriginals = JSON.stringify(prep.messagesToSummarize);
        } catch {
          log.warn("[context-manager] Failed to capture compaction originals for recovery archive");
        }
      }

      // Slide mode arrives via customInstructions, set by context_compress action="slide".
      // When slide mode is active, respond with pi-core's extension-compaction
      // result: compact() skips the default LLM summarization entirely and
      // appends this result verbatim (fromExtension=true). Steering
      // prep.messagesToSummarize=[] alone would still route the stale summary
      // through the UPDATE prompt — an LLM call re-rendering old content from
      // an empty conversation, costing output tokens and minutes for zero new
      // value.
      if (isOperatorSlide && prep) {
        const cmState = getCmState(ctx);
        const slide = cmState.slideMode;
        if (slide?.active && slide.cutEntryId) {
          // The stored cut is a supplied boundary: re-snap it against the
          // branch as it stands at consumption (the armer may have read the
          // branch before the batch's later results landed). HTTP 400: a kept
          // slice that opens with a tool result has no preceding tool_calls.
          const slideBranch =
            typeof ctx.sessionManager?.getBranch === "function"
              ? (ctx.sessionManager.getBranch() ?? [])
              : [];
          const storedIndex = slideBranch.findIndex(
            (entry) => (entry as { id?: string })?.id === slide.cutEntryId,
          );
          const cutIndex =
            storedIndex >= 0 ? snapBoundaryOutsideToolBatch(slideBranch, storedIndex) : -1;
          const cutEntryId =
            cutIndex >= 0
              ? ((slideBranch[cutIndex] as { id?: string })?.id ?? slide.cutEntryId)
              : slide.cutEntryId;
          const droppedCount = cutIndex >= 0 ? cutIndex : slide.droppedCount;
          const keptCount = cutIndex >= 0 ? slideBranch.length - cutIndex : slide.keepCount;
          log.info(
            `[context-manager] Slide mode: keeping last ${keptCount} entries, ` +
              `dropping ${droppedCount}`,
          );

          // Telemetry honesty: the originals capture above snapshotted
          // pi-core's DEFAULT token-cut summarize set, not the deterministic
          // span this cycle actually drops. Replace it with the dropped span
          // so the compacted/kept counters and the originals archive describe
          // THIS cut, not the token-budget cut pi-core would have made.
          captureDroppedSpanBefore(ctx, cutEntryId);

          // One-shot consumption so a later normal compaction is unaffected.
          cmState.slideMode = null;

          return {
            compaction: {
              summary:
                `Sliding window compaction: dropped the ${droppedCount} entries before the ` +
                `cut; the last ${keptCount} entries remain live. Deterministic entry cut — ` +
                `dropped content is preserved in the append-only session file and the originals archive.`,
              firstKeptEntryId: cutEntryId,
              tokensBefore: typeof prep.tokensBefore === "number" ? prep.tokensBefore : 0,
              details: { readFiles: [], modifiedFiles: [] },
            },
          };
        } else {
          log.warn(
            "[context-manager] SLIDE_MODE marker found but slide state is missing or inactive",
          );
        }
      }

      // Set by context_compress(action="archive"): the user declared a range
      // [startIndex..endIndex] plus a summary that must anchor the compaction.
      // Apply firstKeptEntryId = <entry after endIndex> so the declared range is
      // the real compaction boundary, keep messagesToSummarize = the declared
      // span (it SHOULD be summarized), and render the user summary as an anchor
      // in the compaction instructions so the LLM carries intent, changes,
      // decisions, and next steps forward (the research-grounded anchor model).
      const rangeMode = getCmState(ctx).rangeMode;
      if (prep && rangeMode?.active) {
        const branch: Array<{ id: string; type?: string; message?: any }> =
          typeof ctx.sessionManager?.getBranch === "function"
            ? (ctx.sessionManager.getBranch() ?? [])
            : [];
        const spanMessages = collectRangeMessages(branch, rangeMode.startIndex, rangeMode.endIndex);

        // The declared boundary is a supplied one: snap it out of any tool
        // batch it lands in (HTTP 400: a kept slice that opens with a tool
        // result has no preceding tool_calls), against the branch as it
        // stands at consumption.
        let boundaryId = rangeMode.firstKeptEntryId;
        if (boundaryId) {
          const storedIndex = branch.findIndex((entry) => entry.id === boundaryId);
          if (storedIndex >= 0) {
            const snappedIndex = snapBoundaryOutsideToolBatch(branch, storedIndex);
            boundaryId = branch[snappedIndex]?.id ?? boundaryId;
          }
          (prep as any).firstKeptEntryId = boundaryId;
        }
        (prep as any).messagesToSummarize = spanMessages;
        // No split-turn prefix summary — the declared span IS the summarize set.
        (prep as any).turnPrefixMessages = [];
        (prep as any).isSplitTurn = false;

        // Telemetry honesty (same convention as the slide branch): the capture
        // above snapshotted pi-core's default token-cut span, not the declared
        // range this cycle actually summarizes. Replace it with the span.
        try {
          getCmState(ctx).pendingCompactionOriginals = JSON.stringify(spanMessages);
        } catch {
          /* capture replacement unavailable - telemetry degrades to the default snapshot */
        }

        // Anchor the user summary into the compaction instructions. pi-core
        // does not read this channel back (see the dead-code gap note below);
        // the chunked takeover below folds the anchor into its own prompts.
        event.customInstructions = [
          `Declared archive range for this compaction: entries [${rangeMode.startIndex}..${rangeMode.endIndex}] (topic: "${rangeMode.topic}").`,
          `The user supplied the following anchor summary — fold its intent, changes made, decisions, and next steps into the new compaction summary; keep this substance intact:`,
          `---ANCHOR---`,
          rangeMode.summary,
          `---END ANCHOR---`,
        ].join("\n");

        // Stash the declaration so a failed cycle can re-arm it on its
        // summary-cap retry (retry cycles recompute pi-core's default span,
        // which would silently drop the declared range).
        getCmState(ctx).pendingRangeArchive = { ...rangeMode };
        // Reset range mode so subsequent compactions are unaffected.
        getCmState(ctx).rangeMode = null;

        log.info(
          `[context-manager] Range mode: archiving entries [${rangeMode.startIndex}..${rangeMode.endIndex}], ` +
            `${spanMessages.length} messages to summarize, boundary ${boundaryId ?? "branch-end"}`,
        );

        // Bounded takeover: summarize the declared span in chunked calls
        // (reasoning off, fixed per-call output budget, previous summary and
        // anchor merged) and hand pi-core the finished summary as an extension
        // compaction result. The declared range never reaches a summarizer as
        // one giant call — that is the range-archive shape: a single
        // 185-message call length-stops and the archive lands
        // with no summary at all.
        const chunked = await summarizeSpanInChunks({
          ctx,
          span: spanMessages,
          anchor: { topic: rangeMode.topic, summary: rangeMode.summary },
          previousSummary: (prep as any).previousSummary,
          signal: (event as { signal?: AbortSignal }).signal,
          logPrefix: "Range archive summary",
        });
        if (!("error" in chunked)) {
          // Landed: the stash is consumed (the success handler also clears it,
          // this just avoids a window where a stale stash outlives the cycle).
          getCmState(ctx).pendingRangeArchive = undefined;
          return {
            compaction: {
              summary: chunked.summary,
              firstKeptEntryId: (prep as any).firstKeptEntryId,
              tokensBefore: typeof prep.tokensBefore === "number" ? prep.tokensBefore : 0,
              details: { readFiles: [], modifiedFiles: [] },
              ...(chunked.usage ? { usage: chunked.usage } : {}),
            },
          };
        }
        // Summary-cap class: a bounded failure must stay bounded. Handing the
        // span to pi-core's default summarizer is the one recovery that cannot
        // work for the class that made the bounded path necessary — an
        // observed failure (a 750-message span) shows the shape: chunk
        // capped -> fall-through -> pi-core's single unbounded call capped too
        // -> retry ladder burned on calls that could never complete. Cancel
        // the cycle instead; the failed routing attributes the cancel
        // (cancelSource "summary-cap") and re-arms the bounded recovery, with
        // the stash surviving to re-arm the declared range.
        if (chunked.failureClass === "summary-cap") {
          log.error(
            `[context-manager] Range archive chunked summary failed (${chunked.error}) — ` +
              `bounded failure, cancelling the cycle (no fall-through to pi-core's unbounded summarizer)`,
          );
          const cmState = getCmState(ctx);
          cmState.cancelSource = "summary-cap";
          cmState.summaryCapCancelError = chunked.error;
          // A cancelled cycle never fires session_compact, so the retry guard
          // it set stays true and the ladder then answers "already active" for
          // every later retry — the armed bounded recovery starves. This
          // cycle is over; release the guard.
          const wasRetryCycle = cmState.compactionRetryActive === true;
          cmState.compactionRetryActive = false;
          if (wasRetryCycle) {
            // Never block: the bounded summarizer already had its retry cycle,
            // so the next move is deterministic instead of a third cancel that
            // leaves the session unable to compact at all.
            const cut = buildDeterministicCut(ctx, prep as { tokensBefore?: number });
            if (cut) {
              log.error(
                `[context-manager] Range archive chunked summary failed twice - persisting the ` +
                  `deterministic cut (no LLM summarization)`,
              );
              return cut;
            }
          }
          return { cancel: true };
        }
        log.error(
          `[context-manager] Range archive chunked summary failed (${chunked.error}) — ` +
            `falling through to pi-core's default summarization`,
        );
        // Fall through: the span stays replaced; pi-core summarizes it. That
        // call is pi-core's own, so arm the thinking-off switch for it. The
        // stash STAYS: if pi-core's call dies with a summary-cap failure, the
        // failed routing re-arms the declared range on the retry cycle.
        armSummarizerThinkingOff(pi, ctx);
        return;
      }

      // When context exceeds CONTEXT_COMPACT_REFUSE_PERCENT (owner:
      // lib/detection/context-thresholds.ts), ANY compaction path (manual context_compress or
      // pi-core auto-compaction) can cause "max call stack" crashes that corrupt
      // session state and lead to 403 provider errors. We auto-redirect to a
      // deterministic entry-based CUT POINT (slide-mode behavior). The cut is
      // applied to pi-core's boundary-aware preparation: the guard never widens
      // messagesToSummarize back to the raw branch head, and it never hands the
      // summarizer a span that pi-ai's request clamp would strangle (that span is
      // persisted as a deterministic cut instead). The normal summarization
      // machinery below (STEP 1/1.5/2) still produces a substantive summary
      // whenever the prepared span fits the window.
      //
      // This covers both compaction paths because both fire session_before_compact.
      // The existing guard in context_compress(action="compact") only covers the
      // manual tool path. Auto-compaction bypasses that guard entirely.
      if (prep?.messagesToSummarize?.length) {
        try {
          let usagePercent = 0;
          try {
            const audit = analyzeSession(ctx);
            usagePercent = audit.usage.percent;
            // Capture pre-compaction usage for the
            // outcome-stage budget verify — reuses this analyzeSession (the
            // first unconditional one in the handler).
            try {
              getCmState(ctx).preCompactionUsagePercent = usagePercent;
            } catch {
              /* state unavailable - budget verify degrades to coherence-only */
            }
          } catch {
            // Non-fatal - analysis unavailable
          }

          if (
            usagePercent > CONTEXT_COMPACT_REFUSE_PERCENT &&
            !event.customInstructions?.includes("SLIDE_MODE")
          ) {
            const sm = ctx.sessionManager;
            const branch = typeof sm.getBranch === "function" ? sm.getBranch() : [];
            const keepCount = Math.min(50, Math.max(10, Math.floor(branch.length * 0.3)));
            // The guard arms a supplied boundary: snap it out of any tool batch
            // it lands in (HTTP 400: a kept slice that opens with a tool result
            // has no preceding tool_calls).
            const cutIndex = snapBoundaryOutsideToolBatch(
              branch,
              Math.max(0, branch.length - keepCount),
            );
            const cutEntryId = branch[cutIndex]?.id;
            const keptCount = branch.length - cutIndex;

            if (cutEntryId && cutIndex > 0) {
              // Store slide state for audit trail (session_compact handler reads it).
              const cmState = getCmState(ctx);
              cmState.slideMode = {
                active: true,
                cutEntryId,
                keepCount: keptCount,
                droppedCount: cutIndex,
                timestamp: Date.now(),
              };

              // pi-core's preparation is boundary-aware: messagesToSummarize starts
              // after the last persisted compaction boundary and ends at pi-core's own
              // cut point. Replacing it with the raw branch head re-summarizes content
              // the persisted summaries already cover and can push the span past the
              // window (the strangle class this guard exists for). Keep the prepared
              // span; shrink it only when it overlaps the entries this deterministic
              // cut keeps live, shrinking in place so the boundary-aware start survives.
              // A span lying entirely inside the kept region is left alone: trimming it
              // to the cut would empty the summarize set (the defect class this guard
              // exists for).
              // The messages are the same object references as branch[i].message
              // (pi-core's prepareCompaction pushes entry.message), so the span's
              // branch indices are recoverable by identity.
              const spanMessages = prep.messagesToSummarize as unknown[];
              const spanRefs = new Set(spanMessages);
              let spanStart = -1;
              let spanLast = -1;
              for (let i = 0; i < branch.length; i++) {
                const entry = branch[i];
                if (entry?.type === "message" && entry.message && spanRefs.has(entry.message)) {
                  if (spanStart < 0) spanStart = i;
                  spanLast = i;
                }
              }
              // Exclusive end of the prepared span: pi-core's kept-region anchor when
              // it resolves in the branch (it can sit past the span on split turns),
              // else the entry after the span's last message.
              const preparedKeepEntryId = (prep as any).firstKeptEntryId;
              const preparedKeepIndex =
                typeof preparedKeepEntryId === "string"
                  ? branch.findIndex((entry) => entry.id === preparedKeepEntryId)
                  : -1;
              const spanEnd = preparedKeepIndex >= 0 ? preparedKeepIndex : spanLast + 1;
              const spanResolved = spanStart >= 0;
              const shrinksSpan = spanResolved && spanStart <= cutIndex - 1 && spanEnd > cutIndex;
              const summarySpan = shrinksSpan
                ? collectRangeMessages(branch, spanStart, cutIndex - 1)
                : spanMessages;

              // Mirror pi-ai's request-side clamp (simple-options.js:6-12:
              // available = window - estimate(prompt) - 4096). A span whose estimate
              // no longer fits leaves max_tokens at its 1-token floor, the provider
              // returns an empty length-stopped summary, and pi-core refuses to
              // persist it - the compaction aborts and re-fires every turn. Never
              // hand the summarizer such a span: persist the deterministic cut
              // instead (pi-core consumes an extension compaction result verbatim
              // and skips its summarization call).
              const window = resolveWindow(ctx?.model?.contextWindow).contextWindow;
              const spanEstimate = estimateMessagesTokens(summarySpan);
              if (spanEstimate + 4096 >= window) {
                // Telemetry honesty, same convention as the slide branch: the
                // originals capture above snapshotted pi-core's default span, not
                // the deterministic cut this cycle persists.
                captureDroppedSpanBefore(ctx, cutEntryId);
                log.warn(
                  `[context-manager] High-context guard: dropped-span estimate ${spanEstimate} ` +
                    `+ 4096 safety >= window ${window} - deterministic cut without LLM ` +
                    `summarization (keep ${keptCount}/${branch.length}, dropped ${cutIndex} ` +
                    `entries before ${cutEntryId}).`,
                );
                return {
                  compaction: {
                    summary:
                      `High-context deterministic cut: dropped the ${cutIndex} entries before the cut ` +
                      `without LLM summarization (the summary span would not fit the configured ` +
                      `context window: estimated ${spanEstimate} tokens plus 4096 safety >= ${window}). ` +
                      `The last ${keptCount} entries remain live; dropped content stays in the ` +
                      `append-only session file and the originals archive.`,
                    firstKeptEntryId: cutEntryId,
                    tokensBefore: typeof prep.tokensBefore === "number" ? prep.tokensBefore : 0,
                    details: { readFiles: [], modifiedFiles: [] },
                  },
                };
              }

              if (shrinksSpan) {
                (prep as any).messagesToSummarize = summarySpan;
                (prep as any).turnPrefixMessages = [];
                (prep as any).isSplitTurn = false;
                (prep as any).firstKeptEntryId = cutEntryId;
                log.warn(
                  `[context-manager] High-context compact guard triggered: ` +
                    `${usagePercent.toFixed(1)}% > ${CONTEXT_COMPACT_REFUSE_PERCENT}%. ` +
                    `Deterministic cut: keep ${keptCount}/${branch.length} entries; prepared ` +
                    `span trimmed to [${spanStart}..${cutIndex - 1}].`,
                );
              } else {
                log.warn(
                  `[context-manager] High-context compact guard triggered: ` +
                    `${usagePercent.toFixed(1)}% > ${CONTEXT_COMPACT_REFUSE_PERCENT}%. ` +
                    `Prepared boundary-aware span preserved unchanged ` +
                    `(the deterministic cut [..${cutIndex - 1}] requires no trim).`,
                );
              }
            } else {
              // Edge case: can't determine cut point - log and fall through.
              log.warn(
                `[context-manager] High-context guard: context at ${usagePercent.toFixed(1)}% ` +
                  `but could not determine cut point (branch=${branch.length}, cutEntryId=${cutEntryId}). ` +
                  `Falling through to normal compaction path.`,
              );
            }
          }
        } catch (err) {
          // If guard itself fails, fall through to normal compaction without modifying prep.
          log.error("[context-manager] High-context guard error, falling through:", err);
        }
      }

      // Removes duplicate reads, resolved errors, oversized non-critical outputs.
      // Reduces context before LLM call so LLM summarization has an easier job.
      if (prep?.messagesToSummarize?.length) {
        // Type bridge: filterSafeToRemove uses its own AgentMessage interface;
        // pi's messagesToSummarize uses pi's AgentMessage. Structurally compatible.
        const { filtered, stats } = filterSafeToRemove(prep.messagesToSummarize as FilterMessage[]);
        if (stats.totalRemoved > 0) {
          const pct = Math.round((1 - stats.afterTokens / stats.beforeTokens) * 100);
          log.info(
            `[context-manager] Pre-filter: removed ${stats.totalRemoved} messages ` +
              `(from ${stats.beforeTokens} to ${stats.afterTokens} tokens, saved ~${pct}%)`,
          );
          (prep as Preparation).messagesToSummarize = filtered;
        }
      }

      // Compresses semantic units (redundant tool results, bloated reasoning chains,
      // low-value exchanges) before LLM summarization.
      // Uses adaptive compression level based on session state (turn count,
      // context usage %) to control how aggressively we compress.
      if (prep?.messagesToSummarize?.length) {
        try {
          // Determine adaptive compression level from session metrics
          const audit = analyzeSession(ctx);
          // Use current session context usage instead of cross-session peak
          // (getPeakUsagePercent leaked peakUsage across sessions, causing
          // aggressive compression in sessions that never hit high usage).
          const currentUsage = audit.usage.percent;
          // ExtensionContext has no turnCount - use audit.branchLength as proxy
          const proxyTurnCount = audit.branchLength ?? 0;
          const decision = await determineCompressionLevel(ctx, {
            turnCount: proxyTurnCount,
            turnsSinceCompression:
              proxyTurnCount - (getCmState(ctx).lastCompressionStats?.turnRange?.to ?? 0),
            consecutiveFailures: 0,
            reasoningChainDepth: audit.recommendations.length > 3 ? 4 : 1,
            messageCount: prep.messagesToSummarize.length,
          });
          const baseLevel = decision.level;
          // Escalate compression level when current context is near-full
          const compressionLevel =
            currentUsage > 85
              ? baseLevel === "short-term"
                ? "medium-term"
                : "long-term"
              : baseLevel;

          const { compressed, stats: scStats } = semanticCompress(
            (prep as Preparation).messagesToSummarize as CoreAgentMessage[],
            compressionLevel,
          );
          if (scStats.messagesOut < scStats.messagesIn) {
            log.info(
              `[context-manager] Semantic compress[${compressionLevel}]: ` +
                `${scStats.messagesIn}->${scStats.messagesOut} msgs ` +
                `(${scStats.unitsCollapsed} collapsed, ${scStats.unitsDropped} dropped)`,
            );
            (prep as Preparation).messagesToSummarize = compressed;

            // Store compression metadata for retrieval quality scoring
            try {
              const state = getCmState(ctx);
              state.lastCompressionStats = {
                ...scStats,
                turnRange: {
                  from: proxyTurnCount,
                  to: proxyTurnCount,
                },
                timestamp: Date.now(),
              };
            } catch {
              log.warn("[context-manager] failed to emit end-of-turn context signal");
            }
          }
        } catch (err) {
          log.error("session_before_compact semantic compression error:", err);
        }
      }

      // Bounded recovery for a summary token-cap failure (class "summary-cap"):
      // the retry cycle re-enters here, and instead of replaying the same
      // oversized single call, the span is summarized in bounded chunks with
      // reasoning off (compaction-chunked.ts), then handed to pi-core as an
      // extension compaction result. Requires the armed recovery flag AND an
      // active retry cycle — a stale flag never hijacks a user compaction.
      if (prep?.messagesToSummarize?.length) {
        try {
          const cmState = getCmState(ctx);
          const recovery = cmState.pendingSummaryCapRecovery;
          if (recovery && cmState.compactionRetryActive) {
            cmState.pendingSummaryCapRecovery = undefined;
            log.info(
              `[context-manager] Summary-cap recovery (attempt ${recovery.attempt}): ` +
                `summarizing the ${prep.messagesToSummarize.length}-message span in bounded chunks, reasoning off`,
            );
            const chunked = await summarizeSpanInChunks({
              ctx,
              span: prep.messagesToSummarize as unknown[],
              anchor: recovery.anchor,
              previousSummary: (prep as any).previousSummary,
              signal: (event as { signal?: AbortSignal }).signal,
              logPrefix: `Summary-cap recovery (attempt ${recovery.attempt})`,
            });
            if (!("error" in chunked)) {
              return {
                compaction: {
                  summary: chunked.summary,
                  firstKeptEntryId: (prep as any).firstKeptEntryId,
                  tokensBefore: typeof prep.tokensBefore === "number" ? prep.tokensBefore : 0,
                  details: { readFiles: [], modifiedFiles: [] },
                  ...(chunked.usage ? { usage: chunked.usage } : {}),
                },
              };
            }
            if (chunked.failureClass === "summary-cap") {
              log.error(
                `[context-manager] Summary-cap recovery chunked summary failed (${chunked.error}) — ` +
                  `bounded failure, cancelling the cycle (no fall-through to pi-core's unbounded summarizer)`,
              );
              const cmState = getCmState(ctx);
              cmState.cancelSource = "summary-cap";
              cmState.summaryCapCancelError = chunked.error;
              // This cycle IS the retry (the recovery only runs on one), so the
              // ladder ends here: release the guard and take the deterministic
              // cut instead of cancelling into a session that cannot compact.
              cmState.compactionRetryActive = false;
              const cut = buildDeterministicCut(ctx, prep as { tokensBefore?: number });
              if (cut) {
                log.error(
                  `[context-manager] Summary-cap recovery failed - persisting the deterministic ` +
                    `cut (no LLM summarization)`,
                );
                return cut;
              }
              return { cancel: true };
            }
            log.error(
              `[context-manager] Summary-cap recovery chunked summary failed (${chunked.error}) — ` +
                `falling through to pi-core's default summarization`,
            );
            // Fall through to pi-core's own call — arm the thinking switch.
            armSummarizerThinkingOff(pi, ctx);
          }
        } catch (err) {
          log.error("[context-manager] summary-cap recovery error:", err);
        }
      }

      // pi core passes these to the LLM summarization call. The LLM handles all
      // chunking - we just tell it WHAT to preserve.
      // NOTE (pi-core 0.84.2 dead-code gap): event.customInstructions is NOT read
      // back by pi-core (verified agent-session.js:1422/1665) — preparation
      // steering (messagesToSummarize, firstKeptEntryId, turnPrefixMessages,
      // isSplitTurn) is the only channel that takes effect. Kept for forward
      // compatibility with pi-core versions that do read it.
      const audit = analyzeSession(ctx);
      const instructions = buildCompactionInstructions(audit);
      if (instructions.length > 0) {
        event.customInstructions = instructions.join(" ");
      }

      try {
        eventBus.emit({
          type: "memory_evict",
          reason: "context compaction",
          count: prep?.messagesToSummarize?.length ?? 0,
        });
      } catch {
        log.warn("[context-manager] failed to emit memory_evict event");
      }

      // This cycle hands its span to pi-core's summarizer: keep reasoning out
      // of the summary budget (switch helper above).
      if (prep?.messagesToSummarize?.length) {
        armSummarizerThinkingOff(pi, ctx);
      }
    } catch (err) {
      log.error("session_before_compact error:", err);
    }
  });
}

// Session Compact (success only)
// session_compact fires ONLY on successful compaction. pi-core 0.85.1 has no
// `compaction_end` extension event: the post-compaction outcome handling lives
// in registerSessionCompactOutcomeHandler (a second, deliberately separate
// session_compact stage below) and the failure handling in
// registerSessionCompactFailedHandler on session_compact_failed.

export function registerSessionCompactHandler(pi: ExtensionAPI): void {
  pi.on(SESSION_COMPACT, async (event: any, ctx: ExtensionContext) => {
    try {
      // The compaction completed: the cycle's dedup-relevant in-flight phase is
      // over. A later cycle on the same leaf must run (no lifetime block) while
      // the in-cycle double-fire stays deduped — see markCompactProcessed.
      setCompactionActive(false, ctx);
      // Cycle outcome arrived: disarm the stall watchdog.
      clearCompactionWatchdog(ctx);
      // The cycle LANDED an entry: that is progress, so the fail-safe ladder is
      // broken and the retry dispatch (if any) is over. Cleared here, before the
      // parking work below can throw, so a landed compaction can never leave a
      // cut armed against an unrelated later cycle.
      try {
        clearCompactionFailsafe(ctx);
        settleCompactionRetry();
        settleOverflowRetry();
      } catch {
        /* state unavailable - fail-safe bookkeeping degrades to the failure path */
      }

      const entry = event.compactionEntry;

      // Pattern 8: record the compaction-input fingerprint for this leaf so a
      // later auto-compaction with an identical input can be skipped. The
      // fingerprint was stashed at session_before_compact (before the branch
      // was mutated) and is only recorded here, on SUCCESS.
      try {
        const cmState = getCmState(ctx);
        if (cmState.pendingCompactionFingerprint) {
          const key = `${getSessionIdSafe(ctx)}::${getLeafIdSafe(ctx)}`;
          cmState.lastCompactionFingerprints ??= {};
          cmState.lastCompactionFingerprints[key] = cmState.pendingCompactionFingerprint;
          cmState.pendingCompactionFingerprint = undefined;
        }
      } catch {
        /* state unavailable - fingerprint skip degrades to off */
      }

      if (entry) {
        addEvidence(
          ctx,
          "context_compacted",
          "session",
          `Context compressed: ${entry.summary?.slice(0, 80) ?? "no summary"}`,
          0.8,
        );
      }

      // FIX: Pre-append the user's queued message to sessionManager BEFORE
      // compaction_end fires (which triggers TUI's rebuildChatFromMessages).
      // Intercept appendMessage to skip the duplicate from flushCompactionQueue's
      // session.prompt() -> message_end -> appendMessage call.
      const st = getInterceptState(ctx);
      if (st.queuedDuringCompaction) {
        // Delivery through the shared park path: session write + force-persist
        // + the appendMessage wrapper that dedups the flush replay. The text
        // leaves the pending seat here - a landed cycle delivered it.
        const parked = parkOwnerTextInSession(ctx, st.queuedDuringCompaction);
        if (parked) {
          // Manual compaction: full stop. Arm the one-shot hold so the TUI
          // flush's replay prompt is swallowed in the input hook instead of
          // starting a turn from pre-compaction input. Auto reasons keep the
          // flush replay as their resume and are never armed. Snapshot the
          // text so later capture clears cannot retarget the hold.
          if (event?.reason === "manual") {
            st.holdQueuedPrompt = true;
            st.heldQueuedText = st.queuedDuringCompaction;
            log.info(
              "[context-manager] Manual compaction: hold armed - queued message will not resume the turn",
            );
          }
        } else {
          // The cycle landed but the write path was unavailable. The seat keeps
          // the text for the settle flush; it must not be cleared here.
          log.error(
            "[context-manager] Failed to park the queued message - it stays seated for the settle flush",
          );
        }
        // NOTE: st.queuedDuringCompaction stays set after intercept setup.
        // It must survive until flushCompactionQueue's session.prompt()
        // fires AFTER session_compact returns, so skipDuplicateAppend can
        // detect the duplicate user message. Cleared on turn_end or abort.
      }

      // NOTE: Do NOT inject a resume steer here.
      // The queued message's lifecycle after a manual compaction is: parked via
      // the pre-append above, its flush replay swallowed by the input-hook hold
      // (no turn from pre-compaction input; the operator sends the next input
      // themselves). After an auto compaction (threshold/overflow) the flush
      // replay IS the resume: it fires message_start/message_end, is persisted
      // by sessionManager, and renders in the TUI. The steer from agent.steer()
      // is delivered via agent-loop _steeringMessages, never emits message_start/
      // message_end events, never reaches sessionManager.appendMessage(), and is
      // invisible in both the TUI and session tree. Adding it would only add noise
      // to agent context without any user-visible benefit.

      // Clear overflow notification flag and retry guards on success.
      const cmState = getCmState(ctx);
      cmState.overflowNotified = false;
      cmState.compactionRetryActive = false;
      cmState.overflowRetryActive = false;
      // A landed compaction consumes the range stash and any armed recovery
      // (normally already consumed by the owning branch), and restores the
      // summarizer thinking switch this cycle armed.
      cmState.pendingRangeArchive = undefined;
      cmState.pendingSummaryCapRecovery = undefined;
      restoreSummarizerThinkingLevel(pi, ctx);
    } catch (err) {
      log.error("session_compact error:", err);
    }
  });
}

/**
 * Concatenated text of a user message's content parts ("" when none). Used as
 * the delivery proof for a seated owner input, so the comparison is exact.
 */
function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type?: string; text?: string } => typeof part === "object" && part !== null,
    )
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

// Session Compact Outcome (success shape on session_compact)
// pi-core 1.0.1 has no `compaction_end` extension event. The post-compaction
// outcome (verify + telemetry + the always-on originals archive) rides
// session_compact, fired ONCE per landed compaction entry, after
// registerSessionCompactHandler's parking stage above. The event still carries
// willRetry, but on 1.0.1 it means "pi will retry the aborted turn after this
// compaction" (overflow recovery) - not "this is an intermediate firing". The
// overflow-recovery compaction IS the one that rescued the session, so its
// outcome must be verified and archived exactly like any other; skipping it
// silently lost both the verify stage and the originals archive for that path.
// session_compact_failed is the only failure signal (see the handler below).

interface SessionCompactOutcomeEvent {
  compactionEntry?: {
    id?: string;
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore?: number;
  };
  /** Cycle trigger: manual | threshold | overflow. */
  reason?: string;
  willRetry?: boolean;
}

export function registerSessionCompactOutcomeHandler(pi: ExtensionAPI): void {
  onEvent(
    pi,
    SESSION_COMPACT,
    async (event: SessionCompactOutcomeEvent, _ctx: ExtensionContext) => {
      try {
        // Cycle outcome (intermediate or final): restore the summarizer
        // thinking switch this cycle may have armed. Idempotent no-op when
        // the switch was never armed.
        restoreSummarizerThinkingLevel(pi, _ctx);

        const entry = event.compactionEntry;
        if (!entry) return;

        // A stale originals capture must never leak into a later cycle. Snapshot it into a local for the always-on archive
        // write below, then clear the session state; the archive write
        // consumes and clears it in finally.
        let pendingCompactionOriginals: string | undefined;
        try {
          const cmState = getCmState(_ctx);
          pendingCompactionOriginals = cmState.pendingCompactionOriginals;
          cmState.pendingCompactionOriginals = undefined;
        } catch {
          /* state unavailable - archive write degrades to off */
        }
        // Compacted-vs-kept message counter, snapped once per cycle so
        // post-hoc loss questions are answerable from telemetry. compacted =
        // this cycle's raw summarization input (the originals capture — what
        // the summary replaced); kept = messages still live from the
        // firstKeptEntryId anchor to the branch end. Both degrade to undefined
        // — absent, never wrong.
        const compactedMessages = countSummarizedMessages(pendingCompactionOriginals);
        let keptMessages: number | undefined;
        try {
          const sm = _ctx.sessionManager as {
            getBranch?: () => Array<{ id: string; type?: string; message?: any }>;
          };
          const branch = typeof sm?.getBranch === "function" ? (sm.getBranch() ?? []) : [];
          keptMessages = countKeptMessages(branch, entry.firstKeptEntryId);
        } catch {
          /* branch unavailable - kept count degrades to absent */
        }

        // Verify the completed compaction BEFORE recording success. Coherence
        // (non-empty summary + first-kept anchor) and budget (post-compaction
        // usage dropped below pre-compaction usage) must both pass; otherwise
        // the "success" is a silent context destroyer and must be reported
        // honestly as a failure. No destructive rollback — originals remain in
        // the append-only branch and are recoverable via context_navigate/archive.
        let preCompactionUsagePercent: number | undefined;
        try {
          preCompactionUsagePercent = getCmState(_ctx).preCompactionUsagePercent;
        } catch {
          /* state unavailable - budget verify degrades to coherence-only */
        }
        let cycleId: number | undefined;
        try {
          cycleId = getCmState(_ctx).compactionCycleId;
        } catch {
          /* state unavailable - cycle id degrades to absent */
        }
        const verify = verifyCompactionResult(
          { compactionEntry: entry, firstKeptEntryId: entry.firstKeptEntryId },
          _ctx,
          preCompactionUsagePercent,
        );
        if (!verify.ok) {
          recordCompactionOutcome("failure", {
            errorMessage: `verify: ${verify.reason}`,
          });
          // Feed outcome into advice-tracker for retry strategy adjustment
          recordAdvice("compaction", "failure", 0);
          log.error(
            `[context-manager] Compaction verify FAILED — ${verify.reason}; ` +
              `originals preserved in branch, use context_navigate/archive to recover`,
          );
          // Durable trace: the session file gains one entry naming the
          // verify class (coherence/budget), the span size, and the retry
          // count, so the rollback is visible after the fact.
          writeCompactionTrace(pi, _ctx, {
            event: "verify-failed",
            reason: event.reason,
            failureClass: String(verify.reason).startsWith("coherence:")
              ? "verify-coherence"
              : "verify-budget",
            errorMessage: `verify: ${verify.reason}`,
            spanMessages: compactedMessages,
            retryAttempt: 0,
            willRetry: false,
            cycleId,
          });
          try {
            const cmState = getCmState(_ctx);
            cmState.verifyFailed = true;
            // A verify rejection is a rollback (loss) — count it distinctly
            // from generic failures so the telemetry can measure the
            // verify/rollback stage.
            recordCompactionHealth("totalVerifyFailures");
            // The append-only originals archive also writes on the
            // verify-failure path (always-on / lossless default), with the
            // verify rejection as the reason. WriteOriginalsArchive clears
            // verifyFailed + pendingCompactionOriginals in finally.
            writeOriginalsArchive(_ctx, verify.reason, pendingCompactionOriginals, {
              compactedMessages,
              keptMessages,
            });
          } catch {
            /* state unavailable - archive write degrades to off */
          }
          return;
        }
        log.info("[context-manager] Compaction completed successfully");
        // The outcome carries the compacted-vs-kept message counter.
        // entriesRemoved (existing CompactionHealth field) records the
        // compacted side cumulatively; the kept side + both counts land in the
        // per-compaction archive line below. The same counters also surface as
        // the lastCompactedMessages/lastKeptMessages health fields, rendered by
        // formatCompactionLossLine in context_inspect.
        recordCompactionOutcome("success", {
          entriesRemoved: compactedMessages,
          compactedMessages,
          keptMessages,
        });
        log.info(
          `[context-manager] Compaction outcome: ` +
            `${compactedMessages ?? "?"} message(s) compacted into summary, ` +
            `${keptMessages ?? "?"} kept live (anchor ${entry.firstKeptEntryId ?? "none"})`,
        );
        // Always-on append-only originals archive on the healthy path too:
        // the raw originals this compaction replaced are preserved
        // even when verification passes (lossless default). reason="compact"
        // (the healthy path has no verify reason).
        writeOriginalsArchive(_ctx, "compact", pendingCompactionOriginals, {
          compactedMessages,
          keptMessages,
        });
        // Feed outcome into advice-tracker for retry strategy adjustment
        recordAdvice("compaction", "success", 0);
      } catch (err) {
        log.error("session_compact outcome error:", err);
      }
    },
  );

  // message_end backup cleanup
  // Catches edge cases where turn_end is missed (no tools called that turn).
  // Ensures intercept state is always cleaned up before the next assistant turn.
  onEvent(pi, MESSAGE_END, async (_event, _ctx) => {
    // Delivery proof for a seated owner input: a consumed steer and a flush
    // replay both land as user messages, while text pi never consumed never
    // appears.
    const message = (_event as { message?: { role?: string; content?: unknown } } | null)?.message;
    if (message?.role === "user") {
      const text = userMessageText(message.content);
      if (text) {
        let confirmed = false;
        let parked = false;
        try {
          const st = getInterceptState(_ctx);
          confirmed = st.pendingOwnerInputs.some((i) => i.text === text);
          parked = st.deliveredOwnerInputs.includes(text);
          if (confirmed) markOwnerInputDelivered(_ctx, text);
        } catch {
          /* state unavailable - confirmation degrades to the settle flush */
        }
        // Do NOT unwrap on the delivery of a text this extension parked: pi
        // persists this message right after extension handlers run, and the
        // wrapper is what skips the duplicate entry. The next unrelated
        // message_end (or input) restores it.
        if (confirmed || parked) return;
      }
    }
    tryRestoreAppendMessage(_ctx);
  });

  // Settle reconciliation
  // The run has settled: deliver seated owner input that no queue will carry
  // any further. pi's own queue is checked first, so an unconsumed steer
  // (drained by the next run's start) is never double-delivered.
  onEvent(pi, AGENT_SETTLED, async (_event, _ctx) => {
    try {
      flushPendingOwnerInputs(_ctx, "settle");
    } catch (err) {
      log.error("session settle owner-input flush error:", err);
    }
  });
}

// Session Compact Failed (failure + abort)
// session_compact_failed fires when a compaction cycle does not land an entry:
// the model call failed, the fingerprint skip cancelled the cycle, or the user
// aborted. Owns the failure/abort cleanup the previous (never-fired)
// compaction_end registration carried: dedup guard reset, stale capture clear,
// intercept restore, and the failure routing into the retry machinery
// (compaction-retry.ts) that schedules ctx.compact() retries.

interface SessionCompactFailedShape {
  reason?: string;
  errorMessage?: string;
  aborted?: boolean;
  /**
   * pi's retry flag. On 1.0.1 it is ALWAYS false on session_compact_failed:
   * all three emit sites pass it literally (a returned compaction snapshot is
   * the only setter, and a returned compaction never fails). Kept in the shape
   * and the trace because it is pi's contract and may return.
   */
  willRetry?: boolean;
  /**
   * Whether the failed content came from this extension's own
   * session_before_compact result (pi-core's fromExtension flag).
   */
  fromExtension?: boolean;
}

export function registerSessionCompactFailedHandler(pi: ExtensionAPI): void {
  onEvent(
    pi,
    SESSION_COMPACT_FAILED,
    async (event: SessionCompactFailedShape, _ctx: ExtensionContext) => {
      try {
        setCompactionActive(false, _ctx);
        // Cycle outcome arrived: restore the summarizer thinking switch this
        // cycle may have armed, and disarm the stall watchdog. Read the armed
        // timestamp and the cycle id BEFORE clearing the watchdog: the failure
        // trace below carries both (only the watchdog stall path
        // populates durationMs).
        restoreSummarizerThinkingLevel(pi, _ctx);
        let cycleId: number | undefined;
        try {
          cycleId = getCmState(_ctx).compactionCycleId;
        } catch {
          /* state unavailable - cycle id degrades to absent */
        }
        let durationMs: number | undefined;
        try {
          const armedAt = getCompactionWatchdogArmedAt(_ctx);
          if (typeof armedAt === "number") durationMs = Date.now() - armedAt;
        } catch {
          /* state unavailable - duration degrades to absent */
        }
        clearCompactionWatchdog(_ctx);
        // The cycle never landed an entry: clear the dedup guard so the next
        // compaction can run, and drop the pending fingerprint (the input was
        // never compacted, so it must not be recorded as processed).
        clearProcessedCompacts(getSessionIdSafe(_ctx), getLeafIdSafe(_ctx));
        try {
          getCmState(_ctx).pendingCompactionFingerprint = undefined;
        } catch {
          /* state unavailable */
        }
        // Span size for the trace: read the pending originals capture BEFORE
        // the clear below consumes it. Degrades to absent, never wrong.
        let spanMessages: number | undefined;
        try {
          spanMessages = countSpanMessages(getCmState(_ctx).pendingCompactionOriginals);
        } catch {
          /* state unavailable - span degrades to absent */
        }
        // Resolve who cancelled the cycle (extension skip vs watchdog vs
        // external), then consume the marker so it never leaks into a later
        // cycle's abort attribution.
        let cancelSource: string | undefined;
        let cancelSummaryCapError: string | undefined;
        try {
          cancelSource = getCmState(_ctx).cancelSource;
          getCmState(_ctx).cancelSource = undefined;
          // Carried with the "summary-cap" cancel: the bounded path's real
          // error text (names the capped chunk). Consumed with the source so
          // it never outlives the cycle.
          cancelSummaryCapError = getCmState(_ctx).summaryCapCancelError;
          getCmState(_ctx).summaryCapCancelError = undefined;
        } catch {
          /* state unavailable - untagged */
        }
        // Non-destructive failure: a cycle that landed no entry must not
        // consume parked owner text. It is delivered now when the session is
        // idle (re-queued through the same session write the success path
        // uses) or kept pending for the settle boundary; the durable seat
        // already holds it either way. clearInterceptState drops only the
        // intercept window - the seat list survives it.
        flushPendingOwnerInputs(_ctx, "failure");
        // Restore intercept state: flushCompactionQueue won't fire on failure,
        // so message_end won't trigger the normal restoration path. If we
        // don't clean up here, the wrapper stays in place and a future message
        // with matching text would be incorrectly skipped.
        tryRestoreAppendMessage(_ctx);
        clearInterceptState(_ctx);
        // A stale originals capture must never leak into a later cycle. The
        // compaction failed, so the branch still carries the originals -
        // there is nothing to archive, just clear the capture.
        try {
          getCmState(_ctx).pendingCompactionOriginals = undefined;
        } catch {
          /* state unavailable */
        }

        // Durable trace on EVERY failed/aborted/cancelled firing. On 1.0.1
        // pi sends willRetry:false on all three emit sites, so this is the
        // final outcome of a cycle, never an intermediate retry; the field
        // stays recorded because it is pi's contract. The post-mortem triad
        // (failure class, span size, retry count) plus fromExtension and the
        // cycle id are only reconstructable from the entry sequence. The entry
        // is a plain custom entry: it lands in the session file and never
        // participates in the LLM context.
        // A "summary-cap" cancelSource is an extension cancel (no
        // errorMessage, aborted=true by pi-core's shape), which classifies as
        // "aborted"; the honest class is the one that caused the cancel.
        let failureClass = classifyCompactionFailure(event);
        if (failureClass === "aborted" && cancelSource === "summary-cap") {
          failureClass = "summary-cap";
        }
        writeCompactionTrace(pi, _ctx, {
          event: event.aborted ? "aborted" : "failure",
          reason: event.reason,
          failureClass,
          errorMessage:
            event.errorMessage ??
            (failureClass === "summary-cap" ? cancelSummaryCapError : undefined),
          spanMessages,
          retryAttempt:
            event.reason === "overflow" ? overflowRetryState.attempt : compactionRetryState.attempt,
          willRetry: event.willRetry,
          fromExtension: event.fromExtension,
          cycleId,
          cancelSource,
          durationMs,
        });

        // pi core is retrying - nothing to do, let pi handle it. On 1.0.1
        // willRetry is always false here (a returned compaction snapshot is
        // the only setter, and a returned compaction does not fail), so this
        // branch is unreachable today; it stays because it is pi's contract.
        if (event.willRetry) return;

        // This cycle is over and it landed no entry. Release the dispatch
        // guards the cycle held: they exist to stop a second compaction being
        // dispatched INTO a live cycle; releasing them only on success leaves
        // the first failed retry guarding the session for good - every later
        // dispatch then logs "already active"
        // and reset the ladder, so the exhausted rungs were unreachable.
        settleCompactionRetry();
        settleOverflowRetry();
        try {
          const cmState = getCmState(_ctx);
          cmState.compactionRetryActive = false;
          cmState.overflowRetryActive = false;
        } catch {
          /* state unavailable - the next dispatch's own guard check decides */
        }

        // Fail-safe accounting: a cycle that lands no entry while the session
        // sits above the critical band is one turn of a loop, not an incident.
        // Count it and, once the loop is established, arm the deterministic cut
        // for the next cycle - the per-cycle routing below has no view of the
        // repetition, and at this usage every rung it can reach either asks the
        // operator to act (emergency rotation) or tries a summarizer that has
        // just failed. An extension cancel is the operator's own decision to
        // skip (unchanged input), so it is not counted as no progress.
        if (cancelSource !== "extension") {
          try {
            const noProgress = noteCompactionNoProgress(_ctx);
            if (noProgress >= COMPACTION_NO_PROGRESS_LIMIT) {
              const usagePercent = getCmState(_ctx).preCompactionUsagePercent;
              if (typeof usagePercent === "number" && usagePercent >= USAGE_WHISPER_CRITICAL) {
                const failSafeReason =
                  `fail-safe after ${noProgress} consecutive compaction cycles landed no entry ` +
                  `at ${usagePercent.toFixed(0)}% context`;
                if (armCompactionFailsafeCut(_ctx, failSafeReason)) {
                  log.error(
                    `[context-manager] Compaction fail-safe armed: ${failSafeReason} - the next cycle ` +
                      `compacts deterministically (no LLM summarization)`,
                  );
                  triggerFailsafeCompaction(_ctx);
                }
              }
            }
          } catch {
            /* state unavailable - a session without fail-safe bookkeeping keeps
               the pre-existing per-cycle routing */
          }
        }

        const { reason, aborted, errorMessage } = event;

        // Aborted - user cancelled. Record the abort in loss telemetry, tagged
        // with whether a compaction was in-flight when the aborted cycle began
        // (the inFlightBefore capture from session_before_compact). Aborts are
        // counted distinctly from failures and successes.
        if (aborted) {
          // A watchdog cancel is a stall, not an operator abort: the cycle
          // died on a hung summarization stream and was killed by the stall
          // watchdog's ctx.abort(). Record it as a failure and re-issue a
          // bounded retry through the existing machinery, so a recoverable
          // stream cut does not leave the context uncompacted and the turn
          // stuck above its threshold.
          if (cancelSource === "watchdog") {
            const watchdogMessage =
              errorMessage ??
              `watchdog: compaction stalled >${Math.round(COMPACTION_STALL_THRESHOLD_MS / 1000)}s`;
            recordCompactionOutcome("failure", { errorMessage: watchdogMessage });
            recordAdvice("compaction", "failure", 0);
            if (reason === "overflow") {
              handleOverflowFailure(pi, event, _ctx, watchdogMessage);
            } else {
              handleThresholdFailure(pi, event, _ctx, watchdogMessage);
            }
            return;
          }
          // A summary-cap cancel came from this extension's bounded path
          // (chunked split failed with the summary-cap class and the cycle was
          // cancelled instead of falling through to pi-core's unbounded
          // summarizer). Route it exactly like a pi-core summary-cap failure:
          // the bounded recovery re-arms (with the range stash folded in) and
          // the retry ladder advances. A cancel is not a user abort — the
          // agent never pressed ESC here.
          if (cancelSource === "summary-cap") {
            recordCompactionOutcome("failure", { errorMessage: cancelSummaryCapError });
            recordAdvice("compaction", "failure", 0);
            // Watchdog rule: a summary-cap abort at the critical band lands one
            // deterministic slide, so the class can never be terminal (the
            // bounded retry can wedge on "already active"). Runs before the
            // retry arms, so the armed cut is visible to that retry cycle.
            handleSummaryCapAbort(pi, _ctx, {
              errorMessage: cancelSummaryCapError,
              spanMessages,
            });
            handleSummaryCapFailure(pi, event, _ctx, cancelSummaryCapError);
            return;
          }
          let inFlightBeforeAbort = false;
          try {
            inFlightBeforeAbort = getCmState(_ctx).inFlightBeforeCapture ?? false;
          } catch {
            /* state unavailable - untagged abort */
          }
          recordCompactionOutcome("aborted", { inFlight: inFlightBeforeAbort });
          return;
        }

        // Summary token-cap failure: the generation hit its output budget
        // before the summary completed (class "summary-cap"). Not a context
        // emergency — recover with a
        // bounded chunked summary on the retry cycle. Checked before the
        // context-window branch: a cap failure is about the OUTPUT budget,
        // not the input fit, and must not be routed into window-error advice.
        if (classifyCompactionFailure(event) === "summary-cap") {
          recordCompactionOutcome("failure", { errorMessage });
          recordAdvice("compaction", "failure", 0);
          // Watchdog rule (see the cancel branch above): one deterministic
          // slide per cooldown window at the critical band.
          handleSummaryCapAbort(pi, _ctx, { errorMessage, spanMessages });
          handleSummaryCapFailure(pi, event, _ctx, errorMessage);
          return;
        }

        // Context window error - context too large even for LLM summarization
        if (isContextWindowError(errorMessage)) {
          recordCompactionOutcome("failure", { errorMessage });
          // Feed outcome into advice-tracker for retry strategy adjustment
          recordAdvice("compaction", "failure", 0);
          handleContextWindowError(pi, event, _ctx, errorMessage);
          return;
        }

        // Threshold/manual compaction failure
        if (reason === "threshold" || reason === "manual") {
          handleThresholdFailure(pi, event, _ctx, errorMessage);
          return;
        }

        // Overflow recovery failure
        if (reason === "overflow") {
          handleOverflowFailure(pi, event, _ctx, errorMessage);
          return;
        }

        // Transient server error (529, 500, network)
        if (isTransientCompactionError(errorMessage)) {
          handleTransientError(pi, event, _ctx, errorMessage);
          return;
        }

        // The failed cycle's range stash was consumed by the summary-cap
        // routing (re-armed as range mode) or is stale — never outlive the
        // cycle.
        try {
          getCmState(_ctx).pendingRangeArchive = undefined;
        } catch {
          /* state unavailable */
        }
      } catch (err) {
        log.error("session_compact_failed error:", err);
      }
    },
  );

  // Session lifecycle cleanup
  // Prevents _processedCompacts memory leak across sessions. Module-level state
  // must be explicitly cleared; LRU eviction alone is insufficient for
  // long-running agent processes with many session rotations.
  onEvent(pi, SESSION_SHUTDOWN, (_event, ctx) => {
    _processedCompacts.clear();
    // The retry ladders and the fail-safe are module-level and session-scoped
    // respectively: neither may outlive the session that armed it. A stale
    // in-flight marker would block the next session's turn-end resets, and an
    // armed cut belongs to the session that earned it.
    resetCompactionRetry();
    resetOverflowRetry();
    // A shutdown must not leave a stall timer holding a dying session's ctx,
    // nor a switched summarizer thinking level armed across the crash.
    try {
      clearCompactionWatchdog(ctx);
      clearCompactionFailsafe(ctx);
      restoreSummarizerThinkingLevel(pi, ctx);
    } catch {
      /* state unavailable */
    }
  });
}
