/**
 * Compaction Retry & Overflow Handlers.
 *
 * Handles: overflow failures, transient errors, context-window errors,
 * threshold failures, retry triggers, and cleanup.
 */

import type {
  CompactOptions,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { analyzeSession } from "../analysis.js";
import { TURN_END } from "../../../../lib/core/event-names.js";
import {
  log,
  getCmState,
  isCompactionActive,
  compactionRetryState,
  overflowRetryState,
  triggerEmergencyRotation,
  COMPACTION_RETRY_MAX_ATTEMPTS,
  OVERFLOW_RETRY_MAX_ATTEMPTS,
  OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR,
  resetCompactionRetry,
  resetOverflowRetry,
  getCompactionRetryDelay,
  getOverflowRetryDelay,
  isContextWindowError,
} from "./shared.js";

// Summary Token-Cap Failure Handler
// A summarization generation that hit its output token cap (class
// "summary-cap") is not a context emergency: the live context is fine and
// the REQUEST fit the window — the OUTPUT budget was burned before the
// summary completed. Emergency rotation would destroy a healthy branch.
// Recovery instead arms the bounded chunked summarizer (compaction-chunked.ts)
// for the retry cycle's session_before_compact, and re-arms a stashed range
// declaration so the retry honors it instead of silently dropping to pi-core's
// default span.

// Summary Cap Failure Handler
export async function handleSummaryCapFailure(
  pi: ExtensionAPI,
  event: any,
  ctx: ExtensionContext,
  errorMessage?: string,
): Promise<void> {
  const errMsg = errorMessage ?? "Summarization failed: generation hit the token cap.";

  if (compactionRetryState.attempt < COMPACTION_RETRY_MAX_ATTEMPTS) {
    compactionRetryState.attempt++;
    compactionRetryState.lastError = errMsg;
    compactionRetryState.lastReason = event.reason ?? "";

    // Arm the bounded recovery the retry cycle consumes. A stashed range
    // declaration is folded into the recovery anchor and re-armed as range
    // mode, so the retry cycle re-enters the range branch (chunked, anchored)
    // instead of compacting pi-core's default span.
    try {
      const cmState = getCmState(ctx);
      const stashedRange = cmState.pendingRangeArchive;
      cmState.pendingSummaryCapRecovery = {
        attempt: compactionRetryState.attempt,
        armedAt: Date.now(),
        anchor: stashedRange
          ? { topic: stashedRange.topic, summary: stashedRange.summary }
          : undefined,
      };
      if (stashedRange) {
        cmState.rangeMode = stashedRange;
        cmState.pendingRangeArchive = undefined;
      }
    } catch {
      /* state unavailable - retry degrades to a plain re-compaction */
    }

    sendTrackedMessage(
      pi,
      {
        customType: "context",
        content: [
          {
            type: "text" as const,
            text: `[warn] Summarization hit the token cap (${errMsg}). Auto-retrying with a bounded chunked summary, reasoning off... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
          },
        ],
        display: true,
      },
      { delivery: "park", deliverAs: "steer" },
      { type: "context", source: "context-manager/compaction/summary-cap" },
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
            "## [warn] Summary token-cap recovery exhausted",
            errMsg,
            "",
            `After ${COMPACTION_RETRY_MAX_ATTEMPTS} bounded retries the summary still did not complete.`,
            "The context is not compacted; consider `context_compress` with a smaller archive range, action=slide, or a model switch.",
          ].join("\n"),
        },
      ],
      display: true,
    },
    // triggerTurn: true - retries exhausted; the agent must pick the next move.
    { deliverAs: "steer", triggerTurn: true },
    { type: "context", source: "context-manager/compaction/summary-cap-exhausted" },
  );
  resetCompactionRetry();
}

// Overflow Failure Handler
export async function handleOverflowFailure(
  pi: ExtensionAPI,
  event: any,
  ctx: ExtensionContext,
  errorMessage?: string,
): Promise<void> {
  const errMsg = errorMessage ?? "Compaction succeeded but the retry overflowed.";

  try {
    const analysis = await analyzeSession(ctx);
    if (analysis.usage.percent >= 75) {
      log.warn(
        `[Critical] Context at ${analysis.usage.percent.toFixed(1)}% ${analysis.usageSourceKind} - triggering emergency rotation (overflow)`,
      );
      triggerEmergencyRotation(pi, ctx);
      return;
    }
  } catch {
    if (isContextWindowError(errMsg)) {
      triggerEmergencyRotation(pi, ctx);
      return;
    }
  }

  if (overflowRetryState.attempt < OVERFLOW_RETRY_MAX_ATTEMPTS) {
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
              `## [warn] Context overflow recovery failed (attempt ${overflowRetryState.attempt + 1}/${OVERFLOW_RETRY_MAX_ATTEMPTS})`,
              errMsg,
              "",
              overflowRetryState.attempt === 0
                ? "Retrying with more aggressive compaction..."
                : `Retrying with keep <=${reducedKeep} tokens...`,
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
      { delivery: "park", deliverAs: "steer" },
      { type: "context", source: "context-manager/compaction/overflow" },
    );

    triggerOverflowRetry(pi, ctx, overflowRetryState.attempt + 1, errMsg);
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
            "## [warn] Context overflow recovery exhausted",
            errMsg,
            "",
            `After ${OVERFLOW_RETRY_MAX_ATTEMPTS} attempts, compaction cannot reduce context enough.`,
            "Consider switching models, starting a new session, or storing learnings in memory.",
          ].join("\n"),
        },
      ],
      display: true,
    },
    // triggerTurn: true - retries are exhausted; agent must act (switch model,
    // rotate, store learnings). Wakes the agent so it can take action.
    { deliverAs: "steer", triggerTurn: true },
    { type: "context", source: "context-manager/compaction/overflow-exhausted" },
  );
  resetOverflowRetry();
}

// Transient Error Handler
export async function handleTransientError(
  pi: ExtensionAPI,
  event: any,
  ctx: ExtensionContext,
  errorMessage?: string,
): Promise<void> {
  const errMsg = errorMessage ?? "Compaction threw an error.";

  try {
    const analysis = await analyzeSession(ctx);
    if (analysis.usage.percent >= 75) {
      log.warn(
        `[Critical] Context at ${analysis.usage.percent.toFixed(1)}% ${analysis.usageSourceKind} - triggering emergency rotation (transient)`,
      );
      triggerEmergencyRotation(pi, ctx);
      return;
    }
  } catch {
    // analyzeSession needs live session state; if unavailable, the retry
    // decision below falls back to attempt-count heuristics alone.
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
            text: `[warn] Server overload (${errMsg}). Auto-retrying... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
          },
        ],
        display: true,
      },
      { delivery: "park", deliverAs: "steer" },
      { type: "context", source: "context-manager/compaction/transient" },
    );

    triggerCompactionRetry(pi, ctx, compactionRetryState.attempt, errMsg);
    return;
  }

  log.error(
    `[Compaction] Retry ladder exhausted after ${COMPACTION_RETRY_MAX_ATTEMPTS} attempts: ${errMsg}`,
  );
  sendTrackedMessage(
    pi,
    {
      customType: "context",
      content: [
        {
          type: "text" as const,
          text: `[warn] Auto-compaction failed after retries (server overload): ${errMsg}`,
        },
      ],
      display: true,
    },
    // triggerTurn: true - retries exhausted; agent must decide whether to
    // wait for the server to recover, switch model, or rotate.
    { deliverAs: "steer", triggerTurn: true },
    { type: "context", source: "context-manager/compaction/transient-exhausted" },
  );
  // The ladder is bounded, not spent: the exhausted rung is terminal for THIS
  // sequence only, so the next failure starts a fresh sequence instead of
  // finding the counter pinned at the ceiling for the rest of the session.
  resetCompactionRetry();
}

// Context Window Error Handler
export async function handleContextWindowError(
  pi: ExtensionAPI,
  _event: any,
  ctx: ExtensionContext,
  errorMessage?: string,
): Promise<void> {
  const errMsg = errorMessage ?? "Context window limit exceeded during compaction.";
  log.warn(`[Critical] ${errMsg}`);

  // emergency size-driven offload BEFORE rotation
  // The deterministic shrink (largest toolResults → disk + stubs) runs
  // FIRST because it is instant, lossless, and exactly-once cheap; rotation
  // destroys the session tree and is irreversible. If anything was offloaded,
  // the context now fits → trigger EXACTLY ONE compaction retry instead of
  // killing the branch. If nothing shrank (or the emergency runner is not
  // published), fall through to the pre-existing emergency-rotation path.
  try {
    const { runContextEmergencyOffload } = await import("./context-emergency.js");
    const offload = await runContextEmergencyOffload(ctx, "compaction-413");
    if (offload.offloaded > 0) {
      log.warn(
        `[ContextWindow] emergency offload freed ${offload.charsSaved} chars ` +
          `(${offload.offloaded} oversized toolResult(s) stubbed) — retrying compaction once`,
      );
      triggerCompactionRetry(pi, ctx, compactionRetryState.attempt + 1, errMsg);
      return;
    }
  } catch (e) {
    log.warn("[ContextWindow] emergency offload failed — falling back to rotation:", e);
  }

  try {
    triggerEmergencyRotation(pi, ctx);
    log.info("[ContextWindow] Emergency rotation triggered");
    return;
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
            "## [warn] Session too large",
            errMsg,
            "",
            "The session cannot be compacted because it exceeds the model's context limit.",
            "Please use `finalize()` to rotate the session, or `context_compress(action='archive')` to archive older work.",
          ].join("\n"),
        },
      ],
      display: true,
    },
    // triggerTurn: true - session is dead in the water, agent must rotate.
    { deliverAs: "steer", triggerTurn: true },
    { type: "context", source: "context-manager/compaction/context-window" },
  );
}

// Threshold Failure Handler
export async function handleThresholdFailure(
  pi: ExtensionAPI,
  event: any,
  ctx: ExtensionContext,
  errorMessage?: string,
): Promise<void> {
  const errMsg = errorMessage ?? "Compaction failed.";

  try {
    const analysis = await analyzeSession(ctx);
    if (analysis.usage.percent >= 75) {
      log.warn(
        `[Critical] Context at ${analysis.usage.percent.toFixed(1)}% ${analysis.usageSourceKind} - triggering emergency rotation (threshold)`,
      );
      triggerEmergencyRotation(pi, ctx);
      return;
    }
  } catch {
    // analyzeSession needs live session state; if unavailable, the retry
    // decision below falls back to attempt-count heuristics alone.
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
            text: `[warn] Compaction failed (${errMsg}). Auto-retrying... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
          },
        ],
        display: true,
      },
      { delivery: "park", deliverAs: "steer" },
      { type: "context", source: "context-manager/compaction/threshold" },
    );

    triggerCompactionRetry(pi, ctx, compactionRetryState.attempt, errMsg);
    return;
  }

  log.error(
    `[Compaction] Retry ladder exhausted after ${COMPACTION_RETRY_MAX_ATTEMPTS} attempts: ${errMsg}`,
  );
  sendTrackedMessage(
    pi,
    {
      customType: "context",
      content: [
        {
          type: "text" as const,
          text: [
            "## [warn] Auto-compaction failed permanently",
            errMsg,
            "",
            "Consider: `compact` manually, `context_navigate(action='checkout')` with backup, or storing learnings in memory.",
          ].join("\n"),
        },
      ],
      display: true,
    },
    // triggerTurn: true - retries exhausted; agent must pick the next move.
    { deliverAs: "steer", triggerTurn: true },
    { type: "context", source: "context-manager/compaction/threshold-exhausted" },
  );
  // Same as the transient rung: bounded ladder, not a spent one.
  resetCompactionRetry();
}

// Retry Trigger Functions
export function triggerCompactionRetry(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  attempt: number,
  _errorMessage: string,
): void {
  clearCompactionRetryInternal();
  const delayMs = getCompactionRetryDelay(attempt);

  compactionRetryState.retryTimeout = setTimeout(() => {
    compactionRetryState.retryTimeout = null;
    const cmState = getCmState(ctx);
    if (cmState.compactionRetryActive && isCompactionActive(ctx)) {
      // A real cycle is in flight and will report its own outcome; this retry
      // is a genuine duplicate.
      log.info("[Compaction] Retry skipped - already active");
      resetCompactionRetry();
      return;
    }
    if (cmState.compactionRetryActive) {
      // The guard outlived the cycle it guarded: a cancelled cycle can end
      // without ever firing session_compact, so the flag it set is never
      // cleared (a summary-cap cancel is the observed case, and every later
      // retry then logged "Retry skipped - already active"). A stale guard
      // must never be the
      // terminal state of the summary-cap class: clear it and dispatch, so
      // the armed bounded recovery gets its cycle instead of starving.
      log.warn(
        "[Compaction] Retry guard was stale (no compaction in flight) - clearing it and dispatching",
      );
    }
    cmState.compactionRetryActive = true;
    // Mark the dispatch in flight before the call, and release it at the
    // cycle's outcome: see RetryState.inFlight for why the turn_end this
    // dispatch itself causes must not settle the ladder.
    compactionRetryState.inFlight = true;
    ctx.compact();
  }, delayMs);
}

export function triggerOverflowRetry(
  _pi: ExtensionAPI,
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
      log.info("[Overflow] Retry skipped - already active");
      resetOverflowRetry();
      return;
    }
    cmState.overflowRetryActive = true;
    overflowRetryState.inFlight = true;
    const options: CompactOptions = {};
    if (reducedKeep != null) {
      options.customInstructions = `Keep the most recent ${reducedKeep} messages.`;
    }
    ctx.compact(options);
  }, delayMs);
}

/**
 * Dispatch the cycle that consumes an armed fail-safe cut. Deferred to a
 * macrotask so the handler that armed it returns first: pi-core's manual
 * compact() aborts the in-flight turn, and calling it synchronously from a
 * failure handler would abort the very turn that is reporting the failure.
 *
 * The deferral is also what makes the dispatch safe to schedule blindly: by
 * the time this runs, the failure routing below the arming site has finished,
 * so a retry it armed (a summary-cap recovery, a transient backoff) is visible
 * here and owns this session's next cycle - that cycle consumes the armed cut
 * instead. One no-progress sequence therefore dispatches exactly one cycle.
 */
export function triggerFailsafeCompaction(ctx: ExtensionContext): void {
  setTimeout(() => {
    try {
      const cmState = getCmState(ctx);
      if (compactionRetryState.retryTimeout !== null || cmState.compactionRetryActive) {
        log.info(
          "[Compaction] Fail-safe dispatch deferred - an armed retry cycle owns the next compaction",
        );
        return;
      }
      ctx.compact();
    } catch (e) {
      log.error("[Compaction] Fail-safe dispatch failed - the armed cut stays armed:", e);
    }
  }, 0);
}

function clearCompactionRetryInternal(): void {
  if (compactionRetryState.retryTimeout) clearTimeout(compactionRetryState.retryTimeout);
  compactionRetryState.retryTimeout = null;
}

function clearOverflowRetryInternal(): void {
  if (overflowRetryState.retryTimeout) clearTimeout(overflowRetryState.retryTimeout);
  overflowRetryState.retryTimeout = null;
}

// Turn End Retry Reset
export function registerTurnEndRetryReset(pi: ExtensionAPI): void {
  pi.on(TURN_END, async () => {
    // A dispatched retry's cycle has not reported yet: the ladder is mid-flight
    // and its attempt is progress, not staleness. See RetryState.inFlight.
    if (
      compactionRetryState.attempt > 0 &&
      !compactionRetryState.retryTimeout &&
      !compactionRetryState.inFlight
    ) {
      resetCompactionRetry();
      log.debug("[Compaction] Retry state reset (turn_end)");
    }
    if (
      overflowRetryState.attempt > 0 &&
      !overflowRetryState.retryTimeout &&
      !overflowRetryState.inFlight
    ) {
      resetOverflowRetry();
      log.debug("[Overflow] Retry state reset (turn_end)");
    }
  });
}
