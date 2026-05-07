// ── Compaction Handler ────────────────────────────────────────────────────────
// Handles session_before_compact, session_compact, compaction_end, and retry logic.
// This is the core of context management — compaction quality directly affects
// agent performance on long sessions.
//
// Key improvements over v0.7:
// - Task-state-aware compaction instructions
// - Semantic preservation of tool call/result pairs
// - Better summarization guidance for the LLM

import type { CompactOptions, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { addEvidence } from "../../../../lib/evidence-pool.js";
import { sendTrackedMessage } from "../../../../lib/injection-tracker.js";
import { eventBus } from "../../../../lib/event-bus.js";
import { appendFileSync } from "node:fs";
import { analyzeSession } from "../analysis.js";
import {
  log,
  getCmState,
  compactionRetryState,
  overflowRetryState,
  _compactedEntries,
  COMPACTION_RETRY_MAX_ATTEMPTS,
  OVERFLOW_RETRY_MAX_ATTEMPTS,
  OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR,
  COMPACTION_RETRY_CUSTOM_TYPE,
  resetCompactionRetry,
  resetOverflowRetry,
  getCompactionRetryDelay,
  getOverflowRetryDelay,
  isTransientCompactionError,
  isContextWindowError,
} from "./shared.js";
import { getRotationState } from "../../../../lib/global-state.js";
import { filterSafeToRemove } from "../../../../lib/filter-safe-to-remove.js";
import { determineCompressionLevel } from "../../../../lib/compression-strategy.js";
import { getPeakUsagePercent } from "../../../../lib/event-consumers.js";
import { semanticCompress } from "../semantic-compress.js";

// ── Deduplication Guard ────────────────────────────────────────────────────────
// session_before_compact fires from TWO call sites in pi core:
// (1) compact() — manual /pi compact command
// (2) _runAutoCompaction() — auto-compaction triggered by context pressure
// Without a guard, our handler fires twice per compaction cycle.
const _processedCompacts = new Set<string>();

function markCompactProcessed(sessionId: string, leafId: string): boolean {
  const key = `${sessionId}::${leafId}`;
  if (_processedCompacts.has(key)) return false;
  _processedCompacts.add(key);
  return true;
}

function clearProcessedCompacts(sessionId: string, leafId: string): void {
  _processedCompacts.delete(`${sessionId}::${leafId}`);
}

// ── Pre-append Queued Message Fix ──────────────────────────────────────────────
// When a user sends a message during compaction, it is queued in the TUI's
// compactionQueuedMessages (not in sessionManager yet).
//
// On compaction_end, the TUI calls rebuildChatFromMessages() BEFORE
// flushCompactionQueue delivers the user's message. This means the user's
// message is NOT in the rebuilt chat snapshot.
//
// Fix:
//  1. input event → capture user's message text (TUI queues it after)
//  2. session_compact → pre-append to sessionManager + intercept appendMessage
//  3. compaction_end → rebuildChatFromMessages() sees user's message in session ✅
//  4. flushCompactionQueue → session.prompt() → appendMessage intercept SKIPS duplicate
//  5. Agent turn fires ✅ (session.prompt() triggers agent-loop normally)
//
// The intercept works by wrapping sessionManager.appendMessage to detect when
// flushCompactionQueue's session.prompt() fires (it calls appendMessage via the
// message_end handler). We skip the duplicate by returning the pre-appended
// entry ID instead of creating a new one.

/** Text of the user's message queued during compaction. */
let _queuedDuringCompaction: string | undefined;

/** Entry ID of the message pre-appended to sessionManager. */
let _preAppendedEntryId: string | undefined;

/** Original sessionManager.appendMessage — restored after intercept window. */
let _origAppendMessage: ((msg: any) => string) | undefined;

/** Whether the intercept is currently active. Guard against stale intercepts after session replacement. */
let _interceptActive = false;

/** SessionManager reference at time of intercept setup. Used to validate on restore. */
let _interceptedSmRef: any = undefined;

/**
 * Intercept sessionManager.appendMessage to skip the duplicate when
 * flushCompactionQueue's session.prompt() fires after our pre-append.
 * Returns the pre-appended entry ID to avoid creating a duplicate entry.
 */
function skipDuplicateAppend(sessionManager: any): (msg: any) => string {
  return (msg: any) => {
    // Only messages with content[] can be the duplicate user message.
    // BashExecutionMessage has NO `content` field — must pass through.
    const content = msg?.content;
    if (Array.isArray(content)) {
      const text = content[0]?.text;
      if (typeof text === "string" && text === _queuedDuringCompaction) {
        // Skip — this is the duplicate from session.prompt()'s message_end handler.
        // The original from session_compact is already in sessionManager.
        // Return the pre-appended entry ID so the caller gets a valid ID.
        return _preAppendedEntryId ?? "";
      }
    }
    // Intercept is active — delegate to real appendMessage.
    // Use _origAppendMessage which is non-null when intercept is active.
    return _origAppendMessage?.call(sessionManager, msg) ?? sessionManager.appendMessage(msg);
  };
}

/**
 * Attempt to restore sessionManager.appendMessage from intercept.
 * Called from both turn_end and message_end handlers to handle edge cases
 * where one event might not fire (e.g., session replacement mid-turn).
 */
export function tryRestoreAppendMessage(pi: any): void {
  if (!_interceptActive || !_origAppendMessage) return;
  const sm = (pi as any).sessionManager;
  // Only restore if the sessionManager is the same one we intercepted.
  // After session replacement (reload/newSession), sm is a new instance
  // and the old _origAppendMessage is stale — DO NOT restore.
  if (sm !== _interceptedSmRef) {
    log.debug("[context-manager] Skipped intercept restore — sessionManager replaced");
    _interceptActive = false;
    _origAppendMessage = undefined;
    _interceptedSmRef = undefined;
    return;
  }
  // Verify appendMessage is still our wrapper (not further mutated).
  // If it's no longer the wrapper, someone else already restored it.
  if (typeof sm.appendMessage !== "function" || sm.appendMessage === _origAppendMessage) {
    // Not wrapped or already restored — nothing to do.
    _interceptActive = false;
    _origAppendMessage = undefined;
    _interceptedSmRef = undefined;
    return;
  }
  sm.appendMessage = _origAppendMessage;
  _origAppendMessage = undefined;
  _interceptActive = false;
  _interceptedSmRef = undefined;
  log.debug("[context-manager] AppendMessage intercept restored");
}

export function clearInterceptState(): void {
  _queuedDuringCompaction = undefined;
  _preAppendedEntryId = undefined;
  _origAppendMessage = undefined;
  _interceptActive = false;
  _interceptedSmRef = undefined;
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
    const flushed = (sm as any).flushed;
    const entries = (sm as any).fileEntries ?? [];
    if (!flushed && entries.length > 0) {
      // Write all entries to establish the session file with all content
      for (const entry of entries) {
        appendFileSync(sm.sessionFile, `${JSON.stringify(entry)}\n`);
      }
      (sm as any).flushed = true;
      log.debug(`[context-manager] Force-persisted ${entries.length} entries to ${sm.sessionFile}`);
    }
  } catch (e) {
    log.error("[context-manager] Force-persist failed:", e);
  }
}

// ── Compaction Instructions Builder ───────────────────────────────────────────
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

  // 2. Prune candidates — tell model what to cut
  const highPriorityPrune = audit.candidates?.filter((c: any) => c.score >= 0.6) ?? [];
  if (highPriorityPrune.length > 3) {
    instructions.push(
      `${highPriorityPrune.length} entries are prune candidates with low semantic value — summarize briefly.`,
    );
  }

  // 3. Context pressure — tell model how aggressive to be
  if (audit.usage.percent > 85) {
    instructions.push(
      `CRITICAL: Context at ${audit.usage.percent.toFixed(0)}% — aggressively summarize. ` +
        `Preserve: (1) active task/goals, (2) key file paths and edits, (3) error states. ` +
        `Discard: verbose tool outputs, repeated reads, exploration logs.`,
    );
  } else if (audit.usage.percent > 70) {
    instructions.push(
      `Context at ${audit.usage.percent.toFixed(0)}% — moderate summarization. ` +
        `Keep: task context, recent decisions, pending work. Summarize: older tool outputs.`,
    );
  }

  // 4. Semantic preservation rules
  instructions.push(
    "Preserve tool-call/result pairs together — never split a tool call from its result. " +
      "If a tool call produced an error, keep both the call and the error.",
  );

  // 5. Memory hint
  instructions.push(
    "After compaction: consider storing key learnings in memory for cross-session continuity.",
  );

  return instructions;
}

// ── Session Before Compact ────────────────────────────────────────────────────
// Provides custom instructions before compaction for smarter LLM summarization.
//
// KEY INSIGHT: We ALWAYS use LLM summarization — it's fast (a few seconds) and
// produces better summaries than hard truncation. The hard truncation bypass has been
// removed. pi core handles its own last-resort safety net.
//
// Flow:
//  1. Deduplicate — prevent two compaction entries from manual+auto call sites
//  2. Pre-filter — remove 100%-safe-to-remove items (STEP 1)
//  3. Instruct — inject smart summarization instructions (STEP 2)
//     pi core then calls LLM summarization with our instructions
//
// Previously (v0.22): hard truncation bypass at 70% threshold.
// Fix (v0.23): always let LLM summarize. pi core handles overflow safety net.

export function registerBeforeCompactHandler(pi: any): void {
  // ── Input hook: capture user's queued message during compaction ─────────────
  // When the user sends a message while compaction is running, it is queued in
  // TUI's compactionQueuedMessages (not persisted to sessionManager yet).
  // We capture the text here so we can pre-append it to sessionManager in
  // session_compact (before TUI's rebuildChatFromMessages runs).
  pi.on("input", (event: any) => {
    if (!event?.text) return;
    // Guard: only set if not already set (handles rapid double-Enter).
    if (_queuedDuringCompaction === undefined) {
      _queuedDuringCompaction = event.text;
    }
  });

  pi.on("session_before_compact", async (event: any, ctx: ExtensionContext) => {
    try {
      // STEP 0: Deduplicate — prevent two entries from manual+auto call sites
      const sessionId = (ctx as any).sessionManager?.getSessionId?.() ?? "?";
      const leafId = (ctx as any).sessionManager?.getLeafId?.() ?? "?";
      if (!markCompactProcessed(sessionId, leafId)) {
        log.info("[context-manager] session_before_compact duplicate — skipping");
        return;
      }
      const prep = event.preparation;

      // STEP 1: Pre-filter 100%-certain-redundant items.
      // Removes duplicate reads, resolved errors, oversized non-critical outputs.
      // Reduces context before LLM call so LLM summarization has an easier job.
      if (prep?.messagesToSummarize?.length) {
        const { filtered, stats } = filterSafeToRemove(prep.messagesToSummarize as any[]);
        if (stats.totalRemoved > 0) {
          const pct = Math.round((1 - stats.afterTokens / stats.beforeTokens) * 100);
          log.info(
            `[context-manager] Pre-filter: removed ${stats.totalRemoved} messages ` +
              `(from ${stats.beforeTokens} to ${stats.afterTokens} tokens, saved ~${pct}%)`,
          );
          (prep as any).messagesToSummarize = filtered;
        }
      }

      // STEP 1.5: Semantic compression pass.
      // Compresses semantic units (redundant tool results, bloated reasoning chains,
      // low-value exchanges) before LLM summarization.
      // Uses adaptive compression level based on session state (turn count,
      // context usage %) to control how aggressively we compress.
      if (prep?.messagesToSummarize?.length) {
        try {
          // Determine adaptive compression level from session metrics
          const audit = analyzeSession(ctx);
          const peakUsage = getPeakUsagePercent();
          const baseLevel = determineCompressionLevel(ctx, {
            turnCount: (ctx as any)?.turnCount ?? audit.branchLength ?? 0,
            turnsSinceCompression:
              ((ctx as any)?.turnCount ?? audit.branchLength ?? 0) -
                (getCmState(ctx).lastCompressionStats?.turnRange?.to ?? 0),
            consecutiveFailures: 0,
            reasoningChainDepth: audit.recommendations.length > 3 ? 4 : 1,
            messageCount: prep.messagesToSummarize.length,
          }).level;
          // Escalate compression level when context has been near-full
          const compressionLevel =
            peakUsage > 85
              ? (baseLevel === "short-term" ? "medium-term" : "long-term")
              : baseLevel;

          const { compressed, stats: scStats } = semanticCompress(
            (prep as any).messagesToSummarize as any[],
            compressionLevel,
          );
          if (scStats.messagesOut < scStats.messagesIn) {
            const saved = scStats.messagesIn - scStats.messagesOut;
            log.info(
              `[context-manager] Semantic compress[${compressionLevel}]: ` +
                `${scStats.messagesIn}→${scStats.messagesOut} msgs ` +
                `(${scStats.unitsCollapsed} collapsed, ${scStats.unitsDropped} dropped)`,
            );
            (prep as any).messagesToSummarize = compressed;

            // Store compression metadata for retrieval quality scoring
            try {
              const state = getCmState(ctx);
              state.lastCompressionStats = {
                ...scStats,
                turnRange: {
                  from: (ctx as any)?.turnCount ?? 0,
                  to: (ctx as any)?.turnCount ?? 0,
                },
                timestamp: Date.now(),
              };
            } catch {} // non-fatal
          }
        } catch (err) {
          log.error("session_before_compact semantic compression error:", err);
        }
      }

      // STEP 2: Inject smart summarization instructions.
      // pi core passes these to the LLM summarization call. The LLM handles all
      // chunking — we just tell it WHAT to preserve.
      const audit = analyzeSession(ctx);
      const instructions = buildCompactionInstructions(audit);
      if (instructions.length > 0) {
        event.customInstructions = instructions.join(" ");
      }

      // Emit memory_evict event via bus
      try {
        eventBus.emit({
          type: "memory_evict",
          reason: "context compaction",
          count: prep?.messagesToSummarize?.length ?? 0,
        });
      } catch {} // non-fatal
    } catch (err) {
      log.error("session_before_compact error:", err);
    }
  });
}

// ── Session Compact (success only) ────────────────────────────────────────────
// session_compact fires ONLY on successful compaction.

export function registerSessionCompactHandler(pi: any): void {
  pi.on("session_compact", async (event: any, ctx: ExtensionContext) => {
    try {
      const entry = event.compactionEntry;
      if (entry?.id) _compactedEntries.add(entry.id);

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
      // session.prompt() → message_end → appendMessage call.
      if (_queuedDuringCompaction) {
        const sm = (ctx as any).sessionManager;
        if (sm && typeof sm.appendMessage === "function") {
          try {
            const messageObj = {
              role: "user" as const,
              content: [{ type: "text" as const, text: _queuedDuringCompaction }],
              timestamp: Date.now(),
            };
            _preAppendedEntryId = sm.appendMessage(messageObj);
            _origAppendMessage = sm.appendMessage.bind(sm);
            sm.appendMessage = skipDuplicateAppend(sm);
            // Track the sessionManager instance to detect replacement.
            // If session reload/newSession happens, sm changes — we must NOT
            // restore the old wrapper to the new sm.
            _interceptedSmRef = sm;
            _interceptActive = true;
            // CRITICAL: Force-persist immediately after pre-append.
            // sessionManager._persist() has a no-assistant guard that returns early,
            // so our pre-appended user message won't be written to disk automatically.
            // This causes the message to be lost on session reload.
            forcePersistSession(sm);
            log.info(
              `[context-manager] Pre-appended queued message (entry: ${_preAppendedEntryId})`,
            );
          } catch (e) {
            log.error("[context-manager] Failed to setup pre-append intercept:", e);
            // Critical: if intercept setup fails, clear ALL state to prevent
            // stale intercept on subsequent turns. Without this, appendMessage
            // calls go through without being intercepted, causing the flushCompactionQueue
            // message to create a DUPLICATE entry in sessionManager (logged to file,
            // but TUI rebuilds from a snapshot taken before session_compact → message
            // missing from TUI → "lost" message despite being in file).
            clearInterceptState();
          }
        }
        // NOTE: _queuedDuringCompaction stays set after intercept setup.
        // It must survive until flushCompactionQueue's session.prompt()
        // fires AFTER session_compact returns, so skipDuplicateAppend can
        // detect the duplicate user message. Cleared on turn_end or abort.
      }

      // NOTE: Do NOT inject a resume steer here.
      // The user's queued message (from flushCompactionQueue → session.prompt())
      // IS the resume mechanism. It triggers message_start events, gets persisted
      // in sessionManager, and renders in the TUI. The steer from agent.steer()
      // is delivered via agent-loop _steeringMessages, never emits message_start/
      // message_end events, never reaches sessionManager.appendMessage(), and is
      // invisible in both the TUI and session tree. Adding it would only add noise
      // to agent context without any user-visible benefit.

      // Clear overflow notification flag, retry guards, AND dedup guard on success
      const cmState = getCmState(ctx);
      cmState.overflowNotified = false;
      cmState.compactionRetryActive = false;
      cmState.overflowRetryActive = false;
      clearProcessedCompacts(
        (ctx as any).sessionManager?.getSessionId?.() ?? "?",
        (ctx as any).sessionManager?.getLeafId?.() ?? "?",
      );
    } catch (err) {
      log.error("session_compact error:", err);
    }
  });
}

// ── Compaction End (all outcomes) ─────────────────────────────────────────────
// Handles ALL compaction outcomes including failures.
// Key insight: pi core handles retry internally (willRetry flag). We only step in
// for cases where pi does NOT retry (permanent failure, user needs guidance).

export function registerCompactionEndHandler(pi: any): void {
  pi.on(
    "compaction_end" as never,
    async (
      event: {
        reason?: string;
        willRetry?: boolean;
        aborted?: boolean;
        errorMessage?: string;
        result?: unknown;
        compactionEntry?: { id?: string; summary?: string };
        firstKeptEntryId?: string;
      },
      _ctx: ExtensionContext,
    ) => {
      try {
        const { reason, willRetry, aborted, errorMessage, result } = event;

        // pi core is retrying — nothing to do, let pi handle it
        if (willRetry) return;

        // CRITICAL: Always clear intercept state on compaction_end, regardless of outcome.
        // The intercept was set in session_compact to skip the duplicate from
        // flushCompactionQueue's session.prompt() → message_end → appendMessage call.
        // If we don't clear it, future appendMessage calls get intercepted incorrectly,
        // breaking session persistence for all subsequent messages.
        tryRestoreAppendMessage(pi);
        clearInterceptState();

        // Aborted — user cancelled. Clear dedup guard so next compaction can run.
        if (aborted) {
          clearProcessedCompacts(
            (_ctx as any).sessionManager?.getSessionId?.() ?? "?",
            (_ctx as any).sessionManager?.getLeafId?.() ?? "?",
          );
          return;
        }

        // On success (result exists), compaction completed successfully.
        // The intercept has been handled above. Nothing more to do.
        if (result) {
          log.info("[context-manager] Compaction completed successfully");
          return;
        }

        // Handle failures below — intercept state already cleared above.
        // Context window error — context too large even for LLM summarization
        if (isContextWindowError(errorMessage)) {
          handleContextWindowError(pi, event, _ctx, errorMessage);
          return;
        }

        // Threshold/manual compaction failure
        if ((reason === "threshold" || reason === "manual") && !result) {
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
      } catch (err) {
        log.error("compaction_end error:", err);
      }
    },
  );
}

// ── Overflow Failure Handler ──────────────────────────────────────────────────
async function handleOverflowFailure(
  pi: any,
  event: any,
  ctx: ExtensionContext,
  errorMessage?: string,
): Promise<void> {
  const entryId = event.result?.firstKeptEntryId ?? event.compactionEntry?.id;
  const errMsg = errorMessage ?? "Compaction succeeded but the retry overflowed.";

  try {
    const analysis = await analyzeSession(ctx);
    if (analysis.usage.percent >= 75) {
      log.warn(
        `[Critical] Context at ${analysis.usage.percent.toFixed(1)}% — triggering emergency rotation (overflow)`,
      );
      const rotationModule = await import("./rotation.js");
      const triggerEmergencyRotation = rotationModule?.triggerEmergencyRotation;
      if (triggerEmergencyRotation) triggerEmergencyRotation(pi, ctx);
      return;
    }
  } catch {
    if (isContextWindowError(errMsg)) {
      const rotationModule = await import("./rotation.js");
      const triggerEmergencyRotation = rotationModule?.triggerEmergencyRotation;
      if (triggerEmergencyRotation) triggerEmergencyRotation(pi, ctx);
      return;
    }
  }

  if (overflowRetryState.attempt < OVERFLOW_RETRY_MAX_ATTEMPTS) {
    _compactedEntries.add(entryId ?? "overflow-" + Date.now());
    const reducedKeep = Math.floor(
      20000 * Math.pow(OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR, overflowRetryState.attempt),
    );

    sendTrackedMessage(
      pi,
      {
        customType: "context",
        content: [
          {
            type: "text" as const,
            text: [
              `## ⚠️ Context overflow recovery failed (attempt ${overflowRetryState.attempt + 1}/${OVERFLOW_RETRY_MAX_ATTEMPTS})`,
              errMsg,
              "",
              overflowRetryState.attempt === 0
                ? "Retrying with more aggressive compaction..."
                : `Retrying with keep ≤${reducedKeep} tokens...`,
              "",
              "If this persists:",
              "1. Switch to a larger-context model",
              "2. Run `/model` to verify settings",
              "3. Store learnings in memory and start a new session",
            ].join("\n"),
          },
        ],
        display: true,
      },
      { deliverAs: "hint", triggerTurn: false },
      { type: "context", source: "context-manager/compaction/overflow" },
    );

    triggerOverflowRetry(pi, ctx, overflowRetryState.attempt + 1, errMsg);
    return;
  }

  _compactedEntries.add(entryId ?? "overflow-" + Date.now());
  sendTrackedMessage(
    pi,
    {
      customType: "context",
      content: [
        {
          type: "text" as const,
          text: [
            "## ⚠️ Context overflow recovery exhausted",
            errMsg,
            "",
            `After ${OVERFLOW_RETRY_MAX_ATTEMPTS} attempts, compaction cannot reduce context enough.`,
            "Consider switching models, starting a new session, or storing learnings in memory.",
          ].join("\n"),
        },
      ],
      display: true,
    },
    { deliverAs: "hint", triggerTurn: true },
    { type: "context", source: "context-manager/compaction/overflow-exhausted" },
  );
  resetOverflowRetry();
}

// ── Transient Error Handler ───────────────────────────────────────────────────
async function handleTransientError(
  pi: any,
  event: any,
  ctx: ExtensionContext,
  errorMessage?: string,
): Promise<void> {
  const errMsg = errorMessage ?? "Compaction threw an error.";

  try {
    const analysis = await analyzeSession(ctx);
    if (analysis.usage.percent >= 75) {
      log.warn(
        `[Critical] Context at ${analysis.usage.percent.toFixed(1)}% — triggering emergency rotation (transient)`,
      );
      const rotationModule = await import("./rotation.js");
      const triggerEmergencyRotation = rotationModule?.triggerEmergencyRotation;
      if (triggerEmergencyRotation) triggerEmergencyRotation(pi, ctx);
      return;
    }
  } catch {
    /* analysis skipped */
  }

  if (compactionRetryState.attempt < COMPACTION_RETRY_MAX_ATTEMPTS) {
    compactionRetryState.attempt++;
    compactionRetryState.lastError = errMsg;
    compactionRetryState.lastReason = event.reason ?? "";

    sendTrackedMessage(
      pi,
      {
        customType: "context",
        content: [
          {
            type: "text" as const,
            text: `⚠️ Server overload (${errMsg}). Auto-retrying... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
          },
        ],
        display: true,
      },
      { deliverAs: "hint", triggerTurn: false },
      { type: "context", source: "context-manager/compaction/transient" },
    );

    triggerCompactionRetry(pi, ctx, compactionRetryState.attempt, errMsg);
    return;
  }

  sendTrackedMessage(
    pi,
    {
      customType: "context",
      content: [
        {
          type: "text" as const,
          text: `⚠️ Auto-compaction failed after retries (server overload): ${errMsg}`,
        },
      ],
      display: true,
    },
    { deliverAs: "hint", triggerTurn: true },
    { type: "context", source: "context-manager/compaction/transient-exhausted" },
  );
}

// ── Context Window Error Handler ──────────────────────────────────────────────
async function handleContextWindowError(
  pi: any,
  _event: any,
  ctx: ExtensionContext,
  errorMessage?: string,
): Promise<void> {
  const errMsg = errorMessage ?? "Context window limit exceeded during compaction.";
  log.warn(`[Critical] ${errMsg}`);

  try {
    const rotationModule = await import("./rotation.js");
    const triggerEmergencyRotation = rotationModule?.triggerEmergencyRotation;
    if (triggerEmergencyRotation) {
      triggerEmergencyRotation(pi, ctx);
      log.info("[ContextWindow] Emergency rotation triggered");
      return;
    }
  } catch (e) {
    log.error("[ContextWindow] Failed to trigger emergency rotation:", e);
  }

  sendTrackedMessage(
    pi,
    {
      customType: "context",
      content: [
        {
          type: "text" as const,
          text: [
            "## ⚠️ Session too large",
            errMsg,
            "",
            "The session cannot be compacted because it exceeds the model's context limit.",
            "Please use `finalize()` to rotate the session, or `context_archive` to archive older work.",
          ].join("\n"),
        },
      ],
      display: true,
    },
    { deliverAs: "hint", triggerTurn: true },
    { type: "context", source: "context-manager/compaction/context-window" },
  );
}

// ── Threshold Failure Handler ─────────────────────────────────────────────────
async function handleThresholdFailure(
  pi: any,
  event: any,
  ctx: ExtensionContext,
  errorMessage?: string,
): Promise<void> {
  const errMsg = errorMessage ?? "Compaction failed.";

  try {
    const analysis = await analyzeSession(ctx);
    if (analysis.usage.percent >= 75) {
      log.warn(
        `[Critical] Context at ${analysis.usage.percent.toFixed(1)}% — triggering emergency rotation (threshold)`,
      );
      const rotationModule = await import("./rotation.js");
      const triggerEmergencyRotation = rotationModule?.triggerEmergencyRotation;
      if (triggerEmergencyRotation) triggerEmergencyRotation(pi, ctx);
      return;
    }
  } catch {
    /* analysis skipped */
  }

  if (compactionRetryState.attempt < COMPACTION_RETRY_MAX_ATTEMPTS) {
    compactionRetryState.attempt++;
    compactionRetryState.lastError = errMsg;
    compactionRetryState.lastReason = event.reason ?? "";

    sendTrackedMessage(
      pi,
      {
        customType: "context",
        content: [
          {
            type: "text" as const,
            text: `⚠️ Compaction failed (${errMsg}). Auto-retrying... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
          },
        ],
        display: true,
      },
      { deliverAs: "hint", triggerTurn: false },
      { type: "context", source: "context-manager/compaction/threshold" },
    );

    triggerCompactionRetry(pi, ctx, compactionRetryState.attempt, errMsg);
    return;
  }

  sendTrackedMessage(
    pi,
    {
      customType: "context",
      content: [
        {
          type: "text" as const,
          text: [
            "## ⚠️ Auto-compaction failed permanently",
            errMsg,
            "",
            "Consider: `/compact` manually, `context_checkout` with backup, or storing learnings in memory.",
          ].join("\n"),
        },
      ],
      display: true,
    },
    { deliverAs: "hint", triggerTurn: true },
    { type: "context", source: "context-manager/compaction/threshold-exhausted" },
  );
}

// ── Retry Trigger Functions ───────────────────────────────────────────────────
function triggerCompactionRetry(
  pi: any,
  ctx: ExtensionContext,
  attempt: number,
  _errorMessage: string,
): void {
  clearCompactionRetry();
  const delayMs = getCompactionRetryDelay(attempt);

  compactionRetryState.retryTimeout = setTimeout(() => {
    compactionRetryState.retryTimeout = null;
    const cmState = getCmState(ctx);
    if (cmState.compactionRetryActive) {
      log.info("[Compaction] Retry skipped — already active");
      resetCompactionRetry();
      return;
    }
    cmState.compactionRetryActive = true;
    ctx.compact();
  }, delayMs);
}

function triggerOverflowRetry(
  pi: any,
  ctx: ExtensionContext,
  attempt: number,
  _errorMessage: string,
  reducedKeep?: number,
): void {
  clearOverflowRetryInternal();
  const delayMs = getOverflowRetryDelay(attempt);

  overflowRetryState.retryTimeout = setTimeout(() => {
    overflowRetryState.retryTimeout = null;
    const cmState = getCmState(ctx);
    if (cmState.overflowRetryActive) {
      log.info("[Overflow] Retry skipped — already active");
      resetOverflowRetry();
      return;
    }
    cmState.overflowRetryActive = true;
    const options: CompactOptions = {};
    if (reducedKeep != null) {
      options.customInstructions = `Keep the most recent ${reducedKeep} messages.`;
    }
    ctx.compact(options);
  }, delayMs);
}

function clearCompactionRetry(): void {
  if (compactionRetryState.retryTimeout) clearTimeout(compactionRetryState.retryTimeout);
  compactionRetryState.retryTimeout = null;
}

function clearOverflowRetryInternal(): void {
  if (overflowRetryState.retryTimeout) clearTimeout(overflowRetryState.retryTimeout);
  overflowRetryState.retryTimeout = null;
}

// ── Context Cleanup Retry Reset ────────────────────────────────────────────────
export function registerContextCleanupHandler(pi: any): void {
  pi.on("context_cleanup", async (_event: any, ctx: ExtensionContext) => {
    const cmState = getCmState(ctx);
    cmState.compactionRetryActive = false;
    cmState.overflowRetryActive = false;
    log.debug("[Cleanup] Retry guards reset on context cleanup");
  });
}

// ── Turn End Retry Reset ────────────────────────────────────────────────────────
export function registerTurnEndRetryReset(pi: any): void {
  pi.on("turn_end", async () => {
    if (compactionRetryState.attempt > 0 && !compactionRetryState.retryTimeout) {
      resetCompactionRetry();
    }
    // Restore sessionManager.appendMessage after the pre-append window closes.
    // The intercept was set in session_compact to skip the duplicate from
    // flushCompactionQueue's session.prompt() → message_end → appendMessage call.
    // Check _interceptActive to avoid restoring to a replaced sessionManager.
    tryRestoreAppendMessage(pi);
    // Clear all intercept state — including the queued message text.
    // This ensures the next compaction cycle starts clean.
    _queuedDuringCompaction = undefined;
    _preAppendedEntryId = undefined;
  });

  // Also listen for message_end — handles edge case where turn_end might not
  // fire after session replacement (reload/newSession mid-turn). This gives us
  // a second chance to clear intercept state before the next compaction cycle.
  pi.on("message_end", async () => {
    if (!_interceptActive) return;
    tryRestoreAppendMessage(pi);
  });
}
