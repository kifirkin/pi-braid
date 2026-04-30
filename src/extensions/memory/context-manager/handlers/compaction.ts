// ── Compaction Handler ────────────────────────────────────────────────────────
// Handles session_before_compact, session_compact, compaction_end, and retry logic.
// This is the core of context management — compaction quality directly affects
// agent performance on long sessions.
//
// Key improvements over v0.7:
// - Task-state-aware compaction instructions
// - Semantic preservation of tool call/result pairs
// - Better summarization guidance for the LLM

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { addEvidence } from "../../../../lib/evidence-pool.js";
import { sendTrackedMessage } from "../../../../lib/injection-tracker.js";
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
// compactionQueuedMessages array (not in sessionManager yet).
//
// On compaction_end, the TUI calls rebuildChatFromMessages() BEFORE
// flushCompactionQueue delivers the user's message. This means the user's
// message is NOT in the rebuilt chat snapshot.
//
// Fix: Capture the user's queued message in the `input` event, then persist
// it to sessionManager in session_compact (fires BEFORE compaction_end).
// This way rebuildChatFromMessages() captures the user's message in its
// session state snapshot, and it appears in the TUI after compaction.
//
// The TUI's flushCompactionQueue is patched to skip sending the pre-appended
// message (to avoid double-persistence in sessionManager).

/** Text of the user's message queued during compaction. Cleared after session_compact. */
let _queuedDuringCompaction: string | undefined;

/** Entry ID of the message pre-appended to sessionManager. TUI skips re-sending. */
let _preAppendedEntryId: string | undefined;

/** Patch TUI's flushCompactionQueue to skip the pre-appended message. */
function patchTuiFlushQueue(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { InteractiveMode } = require(
      "/Users/kifir/.local/share/mise/installs/node/22.22.0/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode",
    ) as any;
    if (!(InteractiveMode.prototype as any)._braidFlushPatched) {
      const orig = InteractiveMode.prototype.flushCompactionQueue as (this: any, options: any) => Promise<void>;
      InteractiveMode.prototype.flushCompactionQueue = async function (this: any, options: any) {
        // If the first non-extension message was pre-appended, skip it
        // to avoid double-persistence in sessionManager (pre-appended in session_compact
        // + sent again via session.prompt in flushCompactionQueue).
        if (_preAppendedEntryId !== undefined) {
          const queued = this.compactionQueuedMessages;
          const firstNonExt = queued.find((m: any) => !this.isExtensionCommand(m.text));
          if (firstNonExt) {
            const idx = queued.indexOf(firstNonExt);
            if (idx >= 0) queued.splice(idx, 1);
          }
        }
        return orig.call(this, options);
      };
      (InteractiveMode.prototype as any)._braidFlushPatched = true;
    }
  } catch {
    // Patch is best-effort — TUI not available in RPC/print mode
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
  pi.on("input", (event: any, ctx: ExtensionContext) => {
    if (!event?.text) return;
    // Only capture if the agent is currently compacting (message queued, not yet sent)
    const sm = (ctx as any).sessionManager;
    if (!sm) return;
    // Check if this message will be queued (session is compacting) or sent normally
    // We detect compaction-queuing by: session is compacting AND text is not an extension command
    // The input event fires BEFORE the TUI's isCompacting check, so we can't use
    // session.isCompacting here. Instead, we check if _queuedDuringCompaction is already set
    // (meaning compaction started after user started typing).
    //
    // Actually, the simplest approach: just capture the text. If compaction hasn't
    // started yet, session.prompt() will handle persistence normally. If compaction
    // IS active, the text will be used in session_compact.
    // We use a module variable so session_compact can access it.
    // Only overwrite if not already set (handles rapid inputs).
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

      // STEP 2: Inject smart summarization instructions.
      // pi core passes these to the LLM summarization call. The LLM handles all
      // chunking — we just tell it WHAT to preserve.
      const audit = analyzeSession(ctx);
      const instructions = buildCompactionInstructions(audit);
      if (instructions.length > 0) {
        event.customInstructions = instructions.join(" ");
      }
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
      // Without this, the user's message is queued in TUI's compactionQueuedMessages
      // and only delivered via flushCompactionQueue AFTER rebuildChatFromMessages
      // runs. The TUI's snapshot misses the user's message, making it look
      // "invisible" or "lost" even though it IS in the session tree.
      //
      // By persisting here (session_compact fires before compaction_end), we
      // ensure rebuildChatFromMessages() captures the user's message in its
      // session state snapshot.
      if (_queuedDuringCompaction) {
        patchTuiFlushQueue(); // Best-effort — only runs once
        const sm = (ctx as any).sessionManager;
        if (sm) {
          try {
            const messageObj = {
              role: "user" as const,
              content: [{ type: "text" as const, text: _queuedDuringCompaction }],
              timestamp: Date.now(),
            };
            _preAppendedEntryId = sm.appendMessage(messageObj);
            log.info(`[context-manager] Pre-appended queued message to session (entry: ${_preAppendedEntryId})`);
          } catch (e) {
            log.warn("[context-manager] Failed to pre-append queued message:", e);
          }
        }
        // Clear the captured text so it doesn't leak to the next compaction
        _queuedDuringCompaction = undefined;
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

        // Aborted — user cancelled. Clear dedup guard so next compaction can run.
        if (aborted) {
          clearProcessedCompacts(
            (_ctx as any).sessionManager?.getSessionId?.() ?? "?",
            (_ctx as any).sessionManager?.getLeafId?.() ?? "?",
          );
          // Clear pre-append tracking — message will be sent via normal flow
          _queuedDuringCompaction = undefined;
          _preAppendedEntryId = undefined;
          return;
        }

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
      { deliverAs: "hint" },
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
    { deliverAs: "hint" },
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
      { deliverAs: "hint" },
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
    { deliverAs: "hint" },
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
    { deliverAs: "hint" },
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
      { deliverAs: "hint" },
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
    { deliverAs: "hint" },
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
    pi.compact();
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
    pi.compact({ keep: reducedKeep });
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
    // Clear pre-append tracking after the turn following compaction completes.
    // This prevents stale state from leaking to the next turn.
    _preAppendedEntryId = undefined;
    _queuedDuringCompaction = undefined;
  });
}
