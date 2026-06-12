// ── Context-Manager Shared State & Helpers ────────────────────────────────────
// Shared across all handler modules. Module-level singletons + session-scoped factories.

import { getExtensionState } from "../../../../lib/state/extension-state.js";
import { createLogger } from "../../../../lib/core/logger.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPruningState } from "../pruning.js";
import { getSessionManager } from "../../../../lib/state/session-manager.js";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { getRotationState } from "../../../../lib/state/global-state.js";

export const log = createLogger("context-manager");

// ── Internal tool detection ───────────────────────────────────────────────────
export const INTERNAL_TOOLS = new Set([
  "context_tag",
  "context_log",
  "context_checkout",
  "context_archive",
  "context_prune",
  "context_audit",
  "context_proposals",
  "context_signal",
  "think",
  "hypothesize",
  "finalize",
  "heuristics_evaluate",
  "cognition_evaluate",
  "memory_store",
  "memory_recall",
  "memory_episodes",
  "memory_heuristics",
  "goal",
  "plan",
  "scratchpad",
  "health_maintenance",
]);

export function isInternal(toolName: string): boolean {
  return INTERNAL_TOOLS.has(toolName);
}

// ── Session-scoped state ──────────────────────────────────────────────────────
import type { CompressionStats } from "../semantic-compress.js";

interface CmState {
  checkoutParams: { target: string; newId: string; targetId: string; backupTag?: string } | null;
  pruningState: any;
  overflowNotified?: boolean;
  // H5: Retry guards for compaction/overflow (prevents double-trigger)
  compactionRetryActive?: boolean;
  overflowRetryActive?: boolean;
  /** Compression metadata from the last semantic compression pass. */
  lastCompressionStats?: CompressionStats & {
    turnRange: { from: number; to: number };
    timestamp: number;
  };
}

export function getCmState(ctx: ExtensionContext): CmState {
  return getExtensionState<CmState>(ctx, "context-manager", () => ({
    checkoutParams: null,
    pruningState: createPruningState(),
    overflowNotified: false,
    // H5: Retry guards initialized to false (prevents double-trigger)
    compactionRetryActive: false,
    overflowRetryActive: false,
  }));
}

// ── Module-level retry state (process-scoped, not session-scoped) ─────────────
export interface RetryState {
  attempt: number;
  lastError: string;
  lastReason: string;
  retryTimeout: ReturnType<typeof setTimeout> | null;
}

export const compactionRetryState: RetryState = {
  attempt: 0,
  lastError: "",
  lastReason: "",
  retryTimeout: null,
};

export const overflowRetryState: RetryState = {
  attempt: 0,
  lastError: "",
  lastReason: "",
  retryTimeout: null,
};

export const _compactedEntries = new Set<string>();

/** Whether compaction is currently in progress. Guards input capture to only
 * capture messages typed DURING compaction, not messages that triggered it.
 * Exported for read+write access by compaction.ts and input-polisher. */
export let _compactionActive = false;

export function isCompactionActive(): boolean {
  return _compactionActive;
}

export function setCompactionActive(value: boolean): void {
  _compactionActive = value;
}

// ── Constants ─────────────────────────────────────────────────────────────────
export const COMPACTION_RETRY_MAX_ATTEMPTS = 3;
export const OVERFLOW_RETRY_MAX_ATTEMPTS = 3;
export const OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR = 0.6;
export const COMPACTION_RETRY_CUSTOM_TYPE = "__compaction_retry_trigger";

// ── Navigation helpers ────────────────────────────────────────────────────────
export function resolveTarget(ctx: ExtensionContext, target?: string): string | null {
  if (!target) return null;
  const sm = getSessionManager(ctx);
  if (target.toLowerCase() === "root") {
    const tree = sm.getTree();
    return tree.length > 0 ? tree[0].entry.id : target;
  }
  if (/^[0-9a-f]{8,}$/i.test(target)) return target;
  const tree = sm.getTree();
  for (const node of tree) {
    if (sm.getLabel(node.entry.id) === target) return node.entry.id;
  }
  return target;
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

// ── Retry helpers ─────────────────────────────────────────────────────────────
export function resetCompactionRetry(): void {
  if (compactionRetryState.retryTimeout) clearTimeout(compactionRetryState.retryTimeout);
  compactionRetryState.attempt = 0;
  compactionRetryState.lastError = "";
  compactionRetryState.lastReason = "";
  compactionRetryState.retryTimeout = null;
}

export function resetOverflowRetry(): void {
  if (overflowRetryState.retryTimeout) clearTimeout(overflowRetryState.retryTimeout);
  overflowRetryState.attempt = 0;
  overflowRetryState.lastError = "";
  overflowRetryState.lastReason = "";
  overflowRetryState.retryTimeout = null;
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

// ── Rotation Utilities (moved from rotation.ts to break cyclic deps) ─────────

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

    lines.push("", "Use `memory_recall` to retrieve cross-session knowledge.");

    return lines.join("\n");
  } catch {
    return "Session continuation from rotated session. Use memory_recall for context.";
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

// ── Compaction Health Metrics ──────────────────────────────────────────────
// Tracks compaction outcomes across sessions for analytics and retry tuning.

export interface CompactionHealth {
  totalCompactions: number;
  totalFailures: number;
  totalTokensBefore: number;
  totalTokensAfter: number;
  totalEntriesRemoved: number;
  lastOutcome: "success" | "failure" | "partial" | null;
  lastErrorMessage?: string;
}

const compactionHealth: CompactionHealth = {
  totalCompactions: 0,
  totalFailures: 0,
  totalTokensBefore: 0,
  totalTokensAfter: 0,
  totalEntriesRemoved: 0,
  lastOutcome: null,
};

export function getCompactionHealth(): CompactionHealth {
  return compactionHealth;
}

export function recordCompactionOutcome(
  outcome: CompactionHealth["lastOutcome"],
  details?: {
    tokensBefore?: number;
    tokensAfter?: number;
    entriesRemoved?: number;
    errorMessage?: string;
  },
): void {
  compactionHealth.lastOutcome = outcome;
  if (outcome === "success") {
    compactionHealth.totalCompactions++;
    if (details?.tokensBefore) compactionHealth.totalTokensBefore += details.tokensBefore;
    if (details?.tokensAfter) compactionHealth.totalTokensAfter += details.tokensAfter;
    if (details?.entriesRemoved) compactionHealth.totalEntriesRemoved += details.entriesRemoved;
  } else {
    compactionHealth.totalFailures++;
    compactionHealth.lastErrorMessage = details?.errorMessage;
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

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
