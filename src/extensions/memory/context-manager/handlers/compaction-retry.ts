/**
 * Compaction Retry & Overflow Handlers - extracted from compaction.ts
 * to reduce that file from 929L to ~580L.
 *
 * Handles: overflow failures, transient errors, context-window errors,
 * threshold failures, retry triggers, and cleanup.
 */

import type { CompactOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { analyzeSession } from "../analysis.js";
import { onEvent } from "../../../../lib/events/event-types.js";
import { TURN_END } from "../../../../lib/core/event-names.js";
import {
  log,
  getCmState,
  compactionRetryState,
  overflowRetryState,
  _compactedEntries,
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

// ── Overflow Failure Handler ──────────────────────────────────────────────────
export async function handleOverflowFailure(
  pi: ExtensionAPI,
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
        `[Critical] Context at ${analysis.usage.percent.toFixed(1)}% - triggering emergency rotation (overflow)`,
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
      { deliverAs: "steer", triggerTurn: false },
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

// ── Transient Error Handler ───────────────────────────────────────────────────
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
        `[Critical] Context at ${analysis.usage.percent.toFixed(1)}% - triggering emergency rotation (transient)`,
      );
      triggerEmergencyRotation(pi, ctx);
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
            text: `[warn] Server overload (${errMsg}). Auto-retrying... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
          },
        ],
        display: true,
      },
      { deliverAs: "steer", triggerTurn: false },
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
}

// ── Context Window Error Handler ──────────────────────────────────────────────
export async function handleContextWindowError(
  pi: ExtensionAPI,
  _event: any,
  ctx: ExtensionContext,
  errorMessage?: string,
): Promise<void> {
  const errMsg = errorMessage ?? "Context window limit exceeded during compaction.";
  log.warn(`[Critical] ${errMsg}`);

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
            "Please use `finalize()` to rotate the session, or `context_archive` to archive older work.",
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

// ── Threshold Failure Handler ─────────────────────────────────────────────────
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
        `[Critical] Context at ${analysis.usage.percent.toFixed(1)}% - triggering emergency rotation (threshold)`,
      );
      triggerEmergencyRotation(pi, ctx);
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
            text: `[warn] Compaction failed (${errMsg}). Auto-retrying... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
          },
        ],
        display: true,
      },
      { deliverAs: "steer", triggerTurn: false },
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
            "## [warn] Auto-compaction failed permanently",
            errMsg,
            "",
            "Consider: `compact` manually, `context_checkout` with backup, or storing learnings in memory.",
          ].join("\n"),
        },
      ],
      display: true,
    },
    { deliverAs: "steer", triggerTurn: true },
    { type: "context", source: "context-manager/compaction/threshold-exhausted" },
  );
}

// ── Retry Trigger Functions ───────────────────────────────────────────────────
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
    if (cmState.compactionRetryActive) {
      log.info("[Compaction] Retry skipped - already active");
      resetCompactionRetry();
      return;
    }
    cmState.compactionRetryActive = true;
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
    const options: CompactOptions = {};
    if (reducedKeep != null) {
      options.customInstructions = `Keep the most recent ${reducedKeep} messages.`;
    }
    ctx.compact(options);
  }, delayMs);
}

function clearCompactionRetryInternal(): void {
  if (compactionRetryState.retryTimeout) clearTimeout(compactionRetryState.retryTimeout);
  compactionRetryState.retryTimeout = null;
}

function clearOverflowRetryInternal(): void {
  if (overflowRetryState.retryTimeout) clearTimeout(overflowRetryState.retryTimeout);
  overflowRetryState.retryTimeout = null;
}

// ── Context Cleanup Retry Reset ────────────────────────────────────────────────
export function registerContextCleanupHandler(pi: ExtensionAPI): void {
  onEvent(pi, "context_cleanup", async (_event: any, ctx: ExtensionContext) => {
    const cmState = getCmState(ctx);
    cmState.compactionRetryActive = false;
    cmState.overflowRetryActive = false;
    log.debug("[Cleanup] Retry guards reset on context cleanup");
  });
}

// ── Turn End Retry Reset ────────────────────────────────────────────────────────
export function registerTurnEndRetryReset(pi: ExtensionAPI): void {
  pi.on(TURN_END, async () => {
    if (compactionRetryState.attempt > 0 && !compactionRetryState.retryTimeout) {
      resetCompactionRetry();
      log.debug("[Compaction] Retry state reset (turn_end)");
    }
    if (overflowRetryState.attempt > 0 && !overflowRetryState.retryTimeout) {
      resetOverflowRetry();
      log.debug("[Overflow] Retry state reset (turn_end)");
    }
  });
}
