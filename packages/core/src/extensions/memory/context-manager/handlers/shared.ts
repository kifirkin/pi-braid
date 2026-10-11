// Context-Manager Shared State & Helpers
// Shared across all handler modules. Module-level singletons + session-scoped factories.

import { getExtensionState } from "../../../../lib/state/extension-state.js";
import { createLogger } from "../../../../lib/core/logger.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPruningState } from "../pruning.js";
import { getSessionManager } from "../../../../lib/state/session-manager.js";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { getRotationState } from "../../../../lib/state/global-state.js";

export const log = createLogger("context-manager");

// Internal tool detection
export const INTERNAL_TOOLS = new Set([
  "context_navigate",
  "context_compress",
  "context_inspect",
  "context_proposals",
  "offload_recover",
  "think",
  "hypothesize",
  "finalize",
  "heuristics_evaluate",
  "cognition_evaluate",
  "memory_store",
  "memory",
  "goal",
  "plan",
  "scratchpad",
  "health_maintenance",
]);

export function isInternal(toolName: string): boolean {
  return INTERNAL_TOOLS.has(toolName);
}

// Session-scoped state
import type { CompressionStats } from "../semantic-compress.js";

interface CmState {
  checkoutParams: { target: string; newId: string; targetId: string; backupTag?: string } | null;
  pruningState: any;
  overflowNotified?: boolean;
  // H5: Retry guards for compaction/overflow (prevents double-trigger)
  compactionRetryActive?: boolean;
  overflowRetryActive?: boolean;
  /**
   * Consecutive compaction cycles that ended without landing an entry
   * (failure, abort, or verify rejection) while the session sat at or above
   * the critical usage band. Reset by any landed compaction. Read by the
   * failure routing: at COMPACTION_NO_PROGRESS_LIMIT the next cycle takes the
   * deterministic cut instead of trying a summarizer that has already failed.
   */
  compactionNoProgress?: number;
  /**
   * The deterministic cut armed for the next compaction cycle. Present means
   * the session is known to be unable to summarize its own context at this
   * usage; the next session_before_compact returns this cut instead of
   * handing a span to a summarizer (pi-core consumes an extension compaction
   * result verbatim and skips its own call). One-shot, and cleared by any
   * landed compaction.
   */
  compactionFailsafeCut?: FailsafeCutState;
  /** Compression metadata from the last semantic compression pass. */
  lastCompressionStats?: CompressionStats & {
    turnRange: { from: number; to: number };
    timestamp: number;
  };
  /** Slide-mode state for deterministic sliding-window compaction. */
  slideMode?: SlideModeState | null;
  /** Archive range-mode state for commitment-preserving archive compactions. */
  rangeMode?: RangeModeState | null;
  /**
   * Bounded-recovery state armed by a summary token-cap failure; consumed by
   * the retry cycle's session_before_compact (chunked summarization, reasoning
   * off). Cleared by the consuming branch, the success handler, and the
   * failure routing so a stale flag never hijacks an unrelated cycle.
   */
  pendingSummaryCapRecovery?: SummaryCapRecoveryState;
  /**
   * The declared range stashed by the range branch so a failed range-archive
   * cycle can be re-armed as range mode on its summary-cap retry cycle
   * (retry cycles recompute pi-core's default span, which would silently drop
   * the declaration). Cleared on success and consumed by the failure routing.
   */
  pendingRangeArchive?: RangeModeState;
  /**
   * Thinking level captured when the summarizer thinking-off switch armed,
   * restored at the cycle outcome. Absent means the switch is not armed.
   */
  pendingSummarizerThinkingLevel?: string;
  /**
   * Whether a compaction was already in-flight when the current cycle's
   * session_before_compact firing began (P2a). Captured BEFORE the cycle is
   * marked active, carried to the session_compact_failed abort branch to tag
   * the abort telemetry.
   */
  inFlightBeforeCapture?: boolean;
  /**
   * Monotonic counter of this session's compaction cycle firings, incremented
   * at session_before_compact (the watchdog arm site) and written into every
   * compaction trace as `cycleId`. Without it a retry ladder is reconstructable
   * only by entry ordering; with it, an outcome names the attempt it belongs
   * to. Mirrors the watchdog's own per-arm counter.
   */
  compactionCycleId?: number;
  /**
   * Fingerprint of the current compaction cycle's INPUT (Pattern 8 delta-only
   * skip). Computed at session_before_compact (before the branch is mutated),
   * recorded into lastCompactionFingerprints on successful compaction, cleared
   * on failure/abort.
   */
  pendingCompactionFingerprint?: string;
  /**
   * Per-leaf (sessionId::leafId) fingerprints of the last SUCCESSFUL compaction
   * input. A later auto-compaction whose input fingerprint matches is skipped
   * (no re-summarization of identical content — silent re-prime starvation).
   */
  lastCompactionFingerprints?: Record<string, string>;
  /**
   * Pre-compaction context usage (percent) captured at session_before_compact
   * (the session_before_compact stage). Reuses the analyzeSession already performed there; consumed
   * by the session_compact verify stage to check that the compaction actually
   * recovered budget (post-compaction usage strictly below this, <=1pp slack).
   * Cleared at the start of each compaction cycle so a stale value from a
   * previous cycle can never trigger a false budget failure.
   */
  preCompactionUsagePercent?: number;
  /**
   * Set when the session_compact verify stage rejects a "successful" compaction
   * (empty/boilerplate summary or budget not recovered). Records the failure
   * truthfully on the archive path; it is NOT a gate anymore (the append-only
   * originals archive is always-on per option B P1). Cleared by
   * writeOriginalsArchive's finally, along with the capture.
   */
  verifyFailed?: boolean;
  /**
   * Who cancelled the current cycle, when the cancellation came from inside
   * this extension: "extension" (a session_before_compact cancel return, e.g.
   * the fingerprint skip), "watchdog" (the stall watchdog's ctx.abort()), or
   * "summary-cap" (the bounded chunked path itself failed with a
   * summary-cap-class error and the cycle was cancelled instead of falling
   * through to pi-core's unbounded summarizer). Read and cleared by the
   * session_compact_failed handler so an abort can be attributed (user Escape
   * leaves it unset). Cleared at fresh-cycle start so a stale source never
   * mislabels a later abort.
   */
  cancelSource?: "extension" | "watchdog" | "summary-cap";
  /**
   * The chunked summary's error text behind a "summary-cap" cancelSource
   * cancel. Read and cleared by the session_compact_failed handler (the
   * retry warn and the trace name the real error); cleared at fresh-cycle
   * start with cancelSource so a stale text never mislabels a later cycle.
   */
  summaryCapCancelError?: string;
  /**
   * JSON serialization of the RAW compaction input (prep.messagesToSummarize)
   * captured at session_before_compact — AFTER the fingerprint
   * block, BEFORE the semantic-compression block (which replaces
   * prep.messagesToSummarize in place, so the capture must see the raw
   * originals). Consumed by the session_compact append-only originals archive
   * write (always-on, on both the success and verify-failure
   * paths); cleared on the session_compact outcome stage and on every
   * session_compact_failed path so a stale capture never leaks into a later
   * cycle.
   */
  pendingCompactionOriginals?: string;
  /**
   * Lazy per-session navigation-adoption counters.
   * Created ONLY when a navigation/compression action actually succeeds —
   * absent means the agent has not steered anywhere this session.
   */
  navigationAdoption?: NavigationAdoption;
  /**
   * ToolCallId → ISO timestamp of the first offloader flush, so the stub
   * rendered into the per-request context stays byte-identical across LLM
   * calls within a session (idempotent substitution). Lazily initialized by
   * the offloader handler when the setting is enabled.
   */
  offloadIsoByToolCallId?: Record<string, string>;
  /**
   * ToolCallId → emergency stub record. Populated ONLY by an
   * emergency offload run (context_window/413 error path); consumed by the
   * context-emergency `context` handler to substitute stubs into the
   * per-request context on every LLM call until the session rotates. Session-
   * scoped via getExtensionState — never process-global.
   */
  emergencyStubsByToolCallId?: Record<string, import("./context-emergency.js").EmergencyStubRecord>;
}

/**
 * State for the sliding-window compaction action (action="slide").
 * Stored per-session via getExtensionState, consumed by session_before_compact.
 */
export interface SlideModeState {
  /** Whether slide mode is active for the current compaction cycle. */
  active: boolean;
  /** Entry ID to start keeping from (cut point). */
  cutEntryId: string;
  /** Number of entries to keep (the `keep` parameter). */
  keepCount: number;
  /** Number of entries dropped before the cut point. */
  droppedCount: number;
  /** Timestamp when slide mode was activated. */
  timestamp: number;
}

/**
 * State for the declared archive range (action="archive").
 * Stored per-session via getExtensionState, consumed by session_before_compact.
 * Carries the user's `summary` as the commitment-preserving anchor so the
 * compaction summarizing LLM folds intent/changes/decisions/next-steps forward.
 */
export interface RangeModeState {
  /** Whether range mode is active for the current compaction cycle. */
  active: boolean;
  /** First entry index of the declared span. */
  startIndex: number;
  /** Last entry index of the declared span (inclusive). */
  endIndex: number;
  /** User-provided summary that must anchor the compaction summary. */
  summary: string;
  /** Topic label for the declared span. */
  topic: string;
  /** Entry id at endIndex+1 — the compaction boundary AFTER the declared span. */
  firstKeptEntryId?: string;
  /** True when the declared span reaches the branch end (no post-span entry to keep). */
  boundaryIsBranchEnd: boolean;
  /** Timestamp when range mode was activated. */
  timestamp: number;
}

/**
 * Recovery state armed by a summary token-cap failure (class "summary-cap").
 * Consumed by the retry cycle's session_before_compact, which replaces the
 * default summarization with a bounded chunked summary (reasoning off).
 */
export interface SummaryCapRecoveryState {
  /** Retry attempt the recovery was armed for (1-based, mirrors compactionRetryState). */
  attempt: number;
  /** Epoch ms when the recovery was armed (diagnostics only). */
  armedAt: number;
  /** Range anchor to fold into the chunked summary, when the failed cycle was a range archive. */
  anchor?: { topic: string; summary: string };
}

export function getCmState(ctx: ExtensionContext): CmState {
  return getExtensionState<CmState>(ctx, "context-manager", () => ({
    checkoutParams: null,
    pruningState: createPruningState(),
    overflowNotified: false,
    // H5: Retry guards initialized to false (prevents double-trigger)
    compactionRetryActive: false,
    overflowRetryActive: false,
    compactionNoProgress: 0,
    compactionFailsafeCut: undefined,
    slideMode: null,
    rangeMode: null,
    pendingCompactionFingerprint: undefined,
    lastCompactionFingerprints: {},
    preCompactionUsagePercent: undefined,
    verifyFailed: false,
    pendingCompactionOriginals: undefined,
    cancelSource: undefined,
    summaryCapCancelError: undefined,
    compactionCycleId: 0,
  }));
}

// Navigation Adoption Counters
// Per-session counters measuring whether the agent STEERS with
// loss-preferring navigation (tag/checkout/log/archive/slide) instead of
// destructive compact. Fixed 7 kinds — no free-form counters. LONG-
// RUNNING-SESSIONS.md success metrics: "navigation adoption per long
// session ... trending up, compaction-per-session trending down". The block
// is lazily initialized by recordNavigationAction so an untouched session
// stays free of the field.

export interface NavigationAdoption {
  tags: number;
  checkouts: number;
  logs: number;
  archives: number;
  slides: number;
  compacts: number;
  deepCleans: number;
}

export type NavigationActionKind =
  | "tag"
  | "checkout"
  | "log"
  | "archive"
  | "slide"
  | "compact"
  | "deep_clean";

const NAVIGATION_KIND_FIELD: Record<NavigationActionKind, keyof NavigationAdoption> = {
  tag: "tags",
  checkout: "checkouts",
  log: "logs",
  archive: "archives",
  slide: "slides",
  compact: "compacts",
  deep_clean: "deepCleans",
};

/**
 * Lazily initialize the session navigation-adoption counter block and
 * increment one fixed kind. Callers invoke this ONLY after the action has
 * truly succeeded (the archive was declared, the compact was scheduled, the
 * tag was written) — abort/error/no-op paths must never reach this helper so
 * the counters measure real steering, not intent.
 */
export function recordNavigationAction(ctx: ExtensionContext, kind: NavigationActionKind): void {
  const state = getCmState(ctx);
  if (!state.navigationAdoption) {
    state.navigationAdoption = {
      tags: 0,
      checkouts: 0,
      logs: 0,
      archives: 0,
      slides: 0,
      compacts: 0,
      deepCleans: 0,
    };
  }
  state.navigationAdoption[NAVIGATION_KIND_FIELD[kind]]++;
}

/**
 * One-line navigation-adoption summary for context_inspect detail=detailed.
 * Loss-preferring navigation (tag/checkout/archive/slide, plus deep-cleans)
 * is visually separated from destructive compacts. Returns null when no
 * navigation action has succeeded yet (must not show an empty line).
 */
export function formatNavigationAdoptionLine(na?: NavigationAdoption): string | null {
  if (!na) return null;
  return (
    `navigation: ${na.tags} tags / ${na.checkouts} checkouts / ${na.logs} logs · ` +
    `archives ${na.archives} / slides ${na.slides} (deep-cleans ${na.deepCleans}) vs compacts ${na.compacts}`
  );
}

// Module-level retry state (process-scoped, not session-scoped)
export interface RetryState {
  attempt: number;
  lastError: string;
  lastReason: string;
  retryTimeout: ReturnType<typeof setTimeout> | null;
  /**
   * True from the moment a retry of this ladder is dispatched (the timer
   * fired and ctx.compact() was called) until that cycle reports its outcome.
   *
   * The dispatch is pi-core's MANUAL compaction entry point, which begins by
   * aborting the in-flight turn and every in-flight compaction controller, so
   * the resulting turn_end lands BEFORE the dispatched cycle's own outcome.
   * The turn-end reset keys on the absence of a pending timer, which the
   * dispatch has already cleared - so without this flag the reset erases the
   * attempt the retry was spending, every later failure restarts at attempt 1,
   * and the exhausted rungs (the ladder's only terminal states) stay
   * unreachable.
   */
  inFlight: boolean;
}

export const compactionRetryState: RetryState = {
  attempt: 0,
  lastError: "",
  lastReason: "",
  retryTimeout: null,
  inFlight: false,
};

export const overflowRetryState: RetryState = {
  attempt: 0,
  lastError: "",
  lastReason: "",
  retryTimeout: null,
  inFlight: false,
};

// Compaction-active state is per-session. The accessor functions here are
// a stable API; the underlying storage is session-scoped via
// getExtensionState (a module-level flag would leak across sessions).

interface CompactionActiveState {
  active: boolean;
}

function getCompactionActiveState(ctx: ExtensionContext): CompactionActiveState {
  return getExtensionState(ctx, "context-manager/compaction-active", () => ({
    active: false,
  }));
}

export function isCompactionActive(ctx?: ExtensionContext): boolean {
  // Module-level call (no ctx) is supported for backward compat; returns
  // the FIRST session's value, which is OK in pi's single-session-per-process.
  if (!ctx) {
    return _fallbackActive;
  }
  return getCompactionActiveState(ctx).active;
}

export function setCompactionActive(value: boolean, ctx: ExtensionContext): void {
  getCompactionActiveState(ctx).active = value;
  // Mirror to module-level fallback for ctx-less callers.
  _fallbackActive = value;
}

// Module-level fallback used when callers don't have ctx. Updated by
// setCompactionActive() with the most recent value. In pi-core's
// single-session-per-process model this is equivalent to per-session.
let _fallbackActive = false;

// Constants
export const COMPACTION_RETRY_MAX_ATTEMPTS = 3;
export const OVERFLOW_RETRY_MAX_ATTEMPTS = 3;
export const OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR = 0.6;
export const COMPACTION_RETRY_CUSTOM_TYPE = "__compaction_retry_trigger";

// Navigation helpers.
// Contract: resolveTarget returns null for any target that does not resolve
// to a real entry in the current session — passing a non-existent target to
// sm.branchWithSummary() fails upstream ("Entry not found"), and aborting on
// it kills the turn with a half-checked-out session. The caller is responsible
// for proposing a recovery via getRecoveryFallback() rather than dead-ending
// the turn.
export function resolveTarget(ctx: ExtensionContext, target?: string): string | null {
  if (!target) return null;
  const sm = getSessionManager(ctx);
  const tree = sm.getTree();
  if (tree.length === 0) return null;

  if (target.toLowerCase() === "root") {
    return tree[0].entry.id;
  }

  // Accept an 8+ hex-char ID only if it actually exists in the current
  // session — a blind accept would let cross-session IDs leak through and
  // fail upstream.
  if (/^[0-9a-f]{8,}$/i.test(target)) {
    for (const node of tree) {
      if (node.entry.id === target) return target;
    }
    return null;
  }

  // Label lookup.
  for (const node of tree) {
    if (sm.getLabel(node.entry.id) === target) return node.entry.id;
  }
  return null;
}

/**
 * Get a recovery target when the requested target is not in the current
 * session. Priority: (1) most recent tag, (2) the most recent non-internal
 * user/assistant message, (3) the session root. Returns null when the
 * session is empty.
 *
 * Used by `context_navigate` checkout to avoid the "Entry not found"
 * dead-end that was corrupting the session.
 */
export function getRecoveryFallback(
  ctx: ExtensionContext,
  _requested: string,
): { id: string; label: string; reason: string } | null {
  const sm = getSessionManager(ctx);
  const branch = sm.getBranch();
  if (branch.length === 0) return null;

  // Priority 1: most recent tag in the current branch.
  for (let i = branch.length - 1; i >= 0; i--) {
    const label = sm.getLabel(branch[i].id);
    if (label) {
      return { id: branch[i].id, label, reason: "most-recent-tag" };
    }
  }

  // Priority 2: session root.
  const tree = sm.getTree();
  if (tree.length > 0) {
    return { id: tree[0].entry.id, label: "root", reason: "session-root" };
  }

  return null;
}

export function findByLabel(ctx: ExtensionContext, label: string): string | null {
  const sm = getSessionManager(ctx);
  const tree = sm.getTree();
  for (const node of tree) {
    if (sm.getLabel(node.entry.id) === label) return node.entry.id;
  }
  return null;
}

export function resolveDefaultTarget(ctx: ExtensionContext): string | null {
  const sm = getSessionManager(ctx);
  const branch = sm.getBranch();
  let targetId: string | null = null;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message") {
      const msg = entry.message;
      if (msg?.role === "toolResult") {
        if (!isInternal(String(msg.toolName ?? ""))) {
          targetId = entry.id;
          break;
        }
      } else if (msg?.role === "assistant") {
        const hasInternal =
          Array.isArray(msg.content) &&
          msg.content.some(
            (c: { type?: string; name?: string }) =>
              c.type === "toolCall" && isInternal(String(c.name ?? "")),
          );
        if (!hasInternal) {
          targetId = entry.id;
          break;
        }
      }
    }
    break;
  }
  if (!targetId && branch.length > 0) targetId = sm.getLeafId();
  return targetId;
}

// Retry helpers
export function resetCompactionRetry(): void {
  if (compactionRetryState.retryTimeout) clearTimeout(compactionRetryState.retryTimeout);
  compactionRetryState.attempt = 0;
  compactionRetryState.lastError = "";
  compactionRetryState.lastReason = "";
  compactionRetryState.retryTimeout = null;
  compactionRetryState.inFlight = false;
}

export function resetOverflowRetry(): void {
  if (overflowRetryState.retryTimeout) clearTimeout(overflowRetryState.retryTimeout);
  overflowRetryState.attempt = 0;
  overflowRetryState.lastError = "";
  overflowRetryState.lastReason = "";
  overflowRetryState.retryTimeout = null;
  overflowRetryState.inFlight = false;
}

/**
 * The dispatched cycle reported an outcome: the dispatch is over. Only the
 * in-flight marker is cleared - the attempt counter is the ladder's progress
 * and survives until the ladder itself settles.
 */
export function settleCompactionRetry(): void {
  compactionRetryState.inFlight = false;
}

export function settleOverflowRetry(): void {
  overflowRetryState.inFlight = false;
}

// Compaction Fail-Safe Ladder
// The ladder above bounds how many times a cycle may fail before it is
// declared exhausted. It cannot bound the case that motivated this state: at
// or above the critical usage band pi-core re-fires threshold compaction on
// every turn, and a cycle that ends with no entry (an aborted cycle carries no
// error text at all) leaves the session exactly as full as it was. Nothing in
// the per-cycle routing can see that repetition, so the repetition itself is
// the signal: N consecutive cycles with no landed entry while the session is
// over the threshold means no summarizer run is going to land, and the next
// cycle must compact deterministically instead.

/**
 * Consecutive no-progress cycles tolerated above the critical band before the
 * deterministic cut is armed. One abort is an operator Escape and two can be a
 * coincidence; three cycles that each leave the session over its threshold is
 * a loop.
 */
export const COMPACTION_NO_PROGRESS_LIMIT = 3;

/** The deterministic cut armed for the next compaction cycle. */
export interface FailsafeCutState {
  /** Why the cut was armed - carried into the landed summary. */
  reason: string;
  /** Epoch ms the cut was armed (diagnostics only). */
  armedAt: number;
}

/**
 * Count one cycle that landed no compaction entry. Returns the running count
 * for this session, so the caller decides on the value it just produced.
 */
export function noteCompactionNoProgress(ctx: ExtensionContext): number {
  const cmState = getCmState(ctx);
  cmState.compactionNoProgress = (cmState.compactionNoProgress ?? 0) + 1;
  return cmState.compactionNoProgress;
}

/**
 * A compaction landed: the no-progress ladder is broken, so neither the count
 * nor an armed cut outlives it.
 */
export function clearCompactionFailsafe(ctx: ExtensionContext): void {
  const cmState = getCmState(ctx);
  cmState.compactionNoProgress = 0;
  cmState.compactionFailsafeCut = undefined;
}

/**
 * Arm the deterministic cut for the next cycle. Idempotent: returns true only
 * for the call that armed it, so one no-progress sequence dispatches exactly
 * one compaction.
 */
export function armCompactionFailsafeCut(ctx: ExtensionContext, reason: string): boolean {
  const cmState = getCmState(ctx);
  if (cmState.compactionFailsafeCut) return false;
  cmState.compactionFailsafeCut = { reason, armedAt: Date.now() };
  return true;
}

/**
 * Take the armed cut, if any, for the cycle that is starting. The cut is
 * one-shot: the consuming cycle owns the outcome, and a landed compaction
 * clears the whole fail-safe state.
 */
export function consumeCompactionFailsafeCut(ctx: ExtensionContext): FailsafeCutState | undefined {
  const cmState = getCmState(ctx);
  const armed = cmState.compactionFailsafeCut;
  cmState.compactionFailsafeCut = undefined;
  return armed;
}

export function getCompactionRetryDelay(attempt: number): number {
  return 3000 * Math.pow(2, attempt - 1); // 3s, 6s, 12s
}

export function getOverflowRetryDelay(attempt: number): number {
  return 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
}

export function isTransientCompactionError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const transientPatterns = [
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
  ];
  return transientPatterns.some((p) => p.test(errorMessage));
}

export function isContextWindowError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const contextWindowPatterns = [
    /context window exceeds limit/i,
    /context length exceeded/i,
    /maximum context length/i,
    /token limit exceeded/i,
    /too many tokens/i,
    /invalid_request_error.*context/i,
  ];
  return contextWindowPatterns.some((p) => p.test(errorMessage));
}

// Rotation utilities (the cyclic-import-free home for the rotation summary).

/**
 * Build a summary of the current session for continuity across rotations.
 */
export function buildContinuationSummary(ctx: ExtensionContext): string {
  try {
    const sm = ctx.sessionManager as {
      getBranch?(): Array<{
        id: string;
        type?: string;
        message?: { role?: string; content?: string | Array<{ text?: string }> };
      }>;
      getLabel?(id: string): string | undefined;
    };
    const branch = sm.getBranch?.() ?? [];
    const tags: string[] = [];

    for (const entry of branch) {
      const label = sm.getLabel?.(entry.id);
      if (label) tags.push(label);
    }

    const lines: string[] = [
      "## Session Continuation",
      "",
      "This session continues from a previous session that was rotated.",
      "",
      `Previous session: ${branch.length} entries, ${tags.length} tags`,
    ];

    if (tags.length > 0) {
      lines.push(`Tags preserved: ${tags.join(", ")}`);
    }

    const recentUserMessages: string[] = [];
    for (let i = branch.length - 1; i >= Math.max(0, branch.length - 5); i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message?.role === "user") {
        const text =
          typeof entry.message.content === "string"
            ? entry.message.content
            : (entry.message.content?.[0]?.text ?? "");
        if (text) recentUserMessages.unshift(text.slice(0, 200));
      }
    }

    if (recentUserMessages.length > 0) {
      lines.push("", "Recent context:");
      for (const msg of recentUserMessages.slice(-3)) {
        lines.push(`- ${msg}`);
      }
    }

    lines.push("", "Use the `memory` tool to retrieve cross-session knowledge.");

    return lines.join("\n");
  } catch {
    return "Session continuation from rotated session. Use the `memory` tool for context.";
  }
}

/**
 * Emergency rotation trigger - called when context overflow is imminent.
 */
export function triggerEmergencyRotation(pi: ExtensionAPI, ctx: ExtensionContext): void {
  try {
    const state = getRotationState();
    if (state.pendingRotation) {
      log.info("[Emergency] Rotation already pending, skipping duplicate trigger");
      return;
    }

    state.pendingRotation = true;
    state.emergencyRotation = true;
    state.continuationSummary = buildContinuationSummary(ctx);

    sendTrackedMessage(
      pi,
      {
        customType: "context",
        content: [
          {
            type: "text" as const,
            text: [
              "## Session Rotation Required",
              "",
              "Context overflow detected. Automatic rotation triggered to prevent data loss.",
              "",
              "Please call `finalize()` to complete this task and start fresh.",
              "",
              "Rotation will happen automatically on next `finalize()`.",
            ].join("\n"),
          },
        ],
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
      { type: "context", source: "context-manager/rotation" },
    );

    log.info("[Emergency] Rotation triggered due to context overflow risk");
  } catch (err) {
    log.error("[Emergency] Rotation trigger failed:", err);
  }
}

// Compaction Health Metrics
// Tracks compaction outcomes across sessions for analytics and retry tuning.

export interface CompactionHealth {
  totalCompactions: number;
  totalFailures: number;
  /** Total aborted (user-cancelled) compactions, counted distinctly from failures. */
  totalAborted: number;
  /** Aborted compactions where another compaction was in-flight when the aborted cycle began. */
  inFlightAborted: number;
  totalTokensBefore: number;
  totalTokensAfter: number;
  totalEntriesRemoved: number;
  /** Verify-stage rejections (rollback count): a compaction the coherence/budget verify rejected. */
  totalVerifyFailures: number;
  /** Option B always-on originals archives actually appended to disk (coverage, NOT loss). */
  totalArchivesWritten: number;
  /**
   * Last successful compaction (surface): raw summarization-input
   * message count from the cycle's originals capture. Absent = never measured
   * (degrade-to-absent telemetry, never wrong).
   */
  lastCompactedMessages?: number;
  /** Last successful compaction: live messages kept from the first-kept anchor. Absent = never measured. */
  lastKeptMessages?: number;
  lastOutcome: "success" | "failure" | "partial" | "aborted" | null;
  lastErrorMessage?: string;
}

const compactionHealth: CompactionHealth = {
  totalCompactions: 0,
  totalFailures: 0,
  totalAborted: 0,
  inFlightAborted: 0,
  totalTokensBefore: 0,
  totalTokensAfter: 0,
  totalEntriesRemoved: 0,
  totalVerifyFailures: 0,
  totalArchivesWritten: 0,
  lastOutcome: null,
};

export function getCompactionHealth(): CompactionHealth {
  return compactionHealth;
}

/** Reset all compaction-health counters. Used by tests and session-start resets. */
export function resetCompactionHealth(): void {
  compactionHealth.totalCompactions = 0;
  compactionHealth.totalFailures = 0;
  compactionHealth.totalAborted = 0;
  compactionHealth.inFlightAborted = 0;
  compactionHealth.totalTokensBefore = 0;
  compactionHealth.totalTokensAfter = 0;
  compactionHealth.totalEntriesRemoved = 0;
  compactionHealth.totalVerifyFailures = 0;
  compactionHealth.totalArchivesWritten = 0;
  compactionHealth.lastOutcome = null;
  delete compactionHealth.lastCompactedMessages;
  delete compactionHealth.lastKeptMessages;
  delete compactionHealth.lastErrorMessage;
}

/**
 * One-line compaction summary for context_inspect / heartbeat analytics.
 * Returns null only when there is nothing worth reporting: no loss signals
 * AND no originals archives written (i.e. no compaction activity at all).
 *
 * Loss gate: ONLY loss signals (aborts, generic failures, verify rollbacks)
 * keep the loss portion alive. Archives-written is COVERAGE, not loss — it
 * never contributes to the gate, but is reported as non-loss telemetry
 * whenever compaction activity happened (even with zero failures), so the
 * always-on archive surface is measurable.
 */
export function formatCompactionLossLine(): string | null {
  const bad =
    compactionHealth.totalAborted +
    compactionHealth.totalFailures +
    compactionHealth.inFlightAborted +
    compactionHealth.totalVerifyFailures;
  const archives = compactionHealth.totalArchivesWritten;
  const lastCompacted = compactionHealth.lastCompactedMessages;
  // A last-compaction measurement is compaction activity worth surfacing —
  // include it in the gate alongside loss signals and archive coverage.
  if (bad === 0 && archives === 0 && lastCompacted === undefined) return null;
  const parts: string[] = [];
  if (bad > 0) {
    parts.push(
      `compaction loss: ${compactionHealth.inFlightAborted} in-flight aborts, ` +
        `${compactionHealth.totalFailures} failures, ${compactionHealth.totalCompactions} compacts`,
    );
  }
  // A verify rejection is a loss signal (a rollback happened) — report it
  // next to the failure counts.
  if (compactionHealth.totalVerifyFailures > 0) {
    parts.push(`verify rollbacks: ${compactionHealth.totalVerifyFailures}`);
  }
  // Coverage telemetry, NOT loss: emitted only when archives actually exist —
  // still reported when failures are zero, so a bare abort/loss with no
  // archives never gains an `archives: 0` suffix.
  if (archives > 0) {
    parts.push(`archives: ${archives}`);
  }
  // The compacted-vs-kept counters of the last successful
  // compaction (kept side degrades to "?" when its source was absent).
  if (lastCompacted !== undefined) {
    parts.push(
      `last compaction: ${lastCompacted} compacted → ${compactionHealth.lastKeptMessages ?? "?"} kept`,
    );
  }
  return parts.join(" · ");
}

export function recordCompactionOutcome(
  outcome: CompactionHealth["lastOutcome"],
  details?: {
    tokensBefore?: number;
    tokensAfter?: number;
    entriesRemoved?: number;
    errorMessage?: string;
    /** Whether another compaction was in-flight when this cycle began (abort tagging, P2a). */
    inFlight?: boolean;
    /** Surface: this cycle's raw summarization-input count (absent = not measured). */
    compactedMessages?: number;
    /** Surface: live messages kept from the first-kept anchor (absent = not measured). */
    keptMessages?: number;
  },
): void {
  compactionHealth.lastOutcome = outcome;
  if (outcome === "success") {
    compactionHealth.totalCompactions++;
    if (details?.tokensBefore) compactionHealth.totalTokensBefore += details.tokensBefore;
    if (details?.tokensAfter) compactionHealth.totalTokensAfter += details.tokensAfter;
    if (details?.entriesRemoved) compactionHealth.totalEntriesRemoved += details.entriesRemoved;
    // Last-compaction counters (reassigned every success so a
    // stale value from an earlier cycle can never masquerade as current).
    compactionHealth.lastCompactedMessages = details?.compactedMessages;
    compactionHealth.lastKeptMessages = details?.keptMessages;
  } else if (outcome === "aborted") {
    // P2a: aborts are counted distinctly from failures and successes.
    compactionHealth.totalAborted++;
    if (details?.inFlight) compactionHealth.inFlightAborted++;
    compactionHealth.lastErrorMessage = details?.errorMessage;
  } else {
    compactionHealth.totalFailures++;
    compactionHealth.lastErrorMessage = details?.errorMessage;
  }
}

/**
 * Increment a non-outcome CompactionHealth counter.
 * Distinct from recordCompactionOutcome (which encodes the cycle outcome as a
 * whole): these two counters measure the real state — every verify
 * rejection is a rollback (loss), every originals archive append is coverage
 * (not loss). Callers only bump the archive counter AFTER a successful
 * appendFileSync so a failed write never inflates coverage.
 */
export function recordCompactionHealth(
  counter: "totalVerifyFailures" | "totalArchivesWritten",
): void {
  compactionHealth[counter]++;
}

// Formatting helpers

export function formatPruneCandidates(candidates: any[], count?: number): string {
  const lines: string[] = [];
  for (let i = 0; i < (count ?? candidates.length); i++) {
    const c = candidates[i];
    if (!c) break;
    const role = c.role || "?";
    const preview = (c.preview || "").slice(0, 60);
    const reason = c.reason || "unknown";
    const age = c.age !== undefined ? `${c.age} turns` : "?";
    const score = c.score !== undefined ? `${(c.score * 100).toFixed(0)}%` : "?";
    lines.push(`${i + 1}. [${role}] ${preview} (age: ${age}, score: ${score})`);
    lines.push(`   Reason: ${reason}`);
  }
  return lines.join("\n");
}
