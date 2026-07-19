/**
 * Rule-based context pruning engine.
 * Applies deduplication, superseded writes, error purging, recency, and batch collapse.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createLogger } from "../../../lib/core/logger.js";
import { hashForDedup } from "../../../lib/utils/dedup.js";

const log = createLogger("context-manager:pruning");

// ── Types ────────────────────────────────────────────────────────────────────

export interface MessageWithMetadata {
  message: AgentMessage;
  metadata: PruneMetadata;
}

export interface PruneMetadata {
  hash?: string;
  filePath?: string;
  fileVersion?: string;
  isError?: boolean;
  errorResolved?: boolean;
  recencyScore?: number;
  shouldPrune?: boolean;
  pruneReason?: string;
  [key: string]: unknown;
}

export interface PruneContext {
  messages: MessageWithMetadata[];
  index: number;
}

export interface PruneRule {
  /** Internal rule identifier (not a tool name) */
  id: string;
  description?: string;
  enabled?: boolean;
  prepare?: (msg: MessageWithMetadata, ctx: PruneContext) => void;
  process?: (msg: MessageWithMetadata, ctx: PruneContext) => void;
}

// Pruning State

export interface PruningState {
  enabled: boolean;
  rules: PruneRule[];
  keepRecentCount: number;
  protectedTools: Set<string>;
  stats: {
    totalPruned: number;
    totalProcessed: number;
    pruneReasons: Record<string, number>;
  };
}

// ── Utility Functions ────────────────────────────────────────────────────────

function hashMessage(msg: AgentMessage): string {
  return hashForDedup(extractMessageContent(msg));
}

function extractMessageContent(msg: AgentMessage): string {
  if (!msg) return "";
  if (msg.role === "user" || msg.role === "assistant") {
    const content = msg.content;
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((p) => {
          if (typeof p === "object" && p !== null) {
            if ("text" in p) return (p as { text: string }).text;
            if ("thinking" in p) return (p as { thinking: string }).thinking;
          }
          return "";
        })
        .join(" ");
    }
  }
  return "";
}

function extractFilePath(msg: AgentMessage): string | undefined {
  if (msg.role !== "toolResult") return undefined;
  const details = (msg as { details?: { path?: string } }).details;
  if (
    details &&
    typeof details === "object" &&
    "path" in details &&
    typeof details.path === "string"
  ) {
    return details.path;
  }
  return undefined;
}

function isErrorMessage(msg: AgentMessage): boolean {
  return msg.role === "toolResult" && (msg as { isError?: boolean }).isError === true;
}

function isSameOperation(msg1: AgentMessage, msg2: AgentMessage): boolean {
  const tool1 = (msg1 as { toolName?: string }).toolName;
  const tool2 = (msg2 as { toolName?: string }).toolName;
  if (tool1 !== tool2) return false;

  const args1 = (msg1 as { toolCallId?: string }).toolCallId;
  const args2 = (msg2 as { toolCallId?: string }).toolCallId;
  return args1 === args2;
}

function hasToolUse(msg: AgentMessage): boolean {
  if (msg.role !== "assistant") return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((c: any) => c.type === "toolCall");
}

export function hasToolResult(msg: AgentMessage): boolean {
  return msg.role === "toolResult" || msg.role === "bashExecution";
}

function extractToolUseIds(msg: AgentMessage): string[] {
  if (msg.role !== "assistant") return [];
  if (!Array.isArray(msg.content)) return [];
  return msg.content
    .filter((c: any) => c.type === "toolCall" && typeof c.id === "string")
    .map((c: any) => c.id as string);
}

function extractResultIds(msg: AgentMessage): string[] {
  if (!hasToolResult(msg)) return [];
  return [(msg as { toolCallId?: string }).toolCallId].filter((id): id is string => Boolean(id));
}

// ── Built-in Prune Rules ─────────────────────────────────────────────────────

const deduplicationRule: PruneRule = {
  id: "deduplication",
  description: "Remove duplicate tool outputs based on content hash",
  enabled: true,

  prepare(msg: MessageWithMetadata) {
    msg.metadata.hash = hashMessage(msg.message);
  },

  process(msg: MessageWithMetadata, ctx: PruneContext) {
    if (msg.metadata.shouldPrune) return;
    if (msg.message.role === "user") return;
    if (hasToolUse(msg.message)) return;

    const currentHash = msg.metadata.hash;
    if (!currentHash) return;

    const seenBefore = ctx.messages
      .slice(0, ctx.index)
      .some((m) => m.metadata.hash === currentHash);

    if (seenBefore) {
      msg.metadata.shouldPrune = true;
      msg.metadata.pruneReason = "duplicate content";
    }
  },
};

const supersededWritesRule: PruneRule = {
  id: "superseded_writes",
  description: "Remove older file writes when newer versions exist",
  enabled: true,

  prepare(msg: MessageWithMetadata) {
    const filePath = extractFilePath(msg.message);
    if (filePath) {
      msg.metadata.filePath = filePath;
      msg.metadata.fileVersion = hashMessage(msg.message);
    }
  },

  process(msg: MessageWithMetadata, ctx: PruneContext) {
    if (msg.metadata.shouldPrune) return;
    if (!msg.metadata.filePath) return;
    if (msg.message.role === "user") return;

    const laterWrite = ctx.messages
      .slice(ctx.index + 1)
      .find((m) => m.metadata.filePath === msg.metadata.filePath);

    if (laterWrite) {
      msg.metadata.shouldPrune = true;
      msg.metadata.pruneReason = `superseded by later write to ${msg.metadata.filePath}`;
    }
  },
};

const errorPurgingRule: PruneRule = {
  id: "error_purging",
  description: "Remove resolved errors from context",
  enabled: true,

  prepare(msg: MessageWithMetadata, ctx: PruneContext) {
    const isError = isErrorMessage(msg.message);
    msg.metadata.isError = isError;

    if (isError) {
      const laterSuccess = ctx.messages
        .slice(ctx.index + 1)
        .find(
          (m: MessageWithMetadata) =>
            isSameOperation(m.message, msg.message) && !isErrorMessage(m.message),
        );
      msg.metadata.errorResolved = !!laterSuccess;
    }
  },

  process(msg: MessageWithMetadata) {
    if (msg.metadata.shouldPrune) return;
    if (msg.message.role === "user") return;

    if (msg.metadata.isError && msg.metadata.errorResolved) {
      msg.metadata.shouldPrune = true;
      msg.metadata.pruneReason = "error resolved by later success";
    }
  },
};

// ── Tool Result Volume Rule ──────────────────────────────────────────────
// Limits accumulated tool results. Prevents infinite growth on long sessions.
// When tool result count exceeds MAX, the OLDEST excess results are pruned,
// keeping the KEEP_RECENT most recent ones. This runs before recencyRule so
// each rule has a clear concern: volume limits tool results, recency protects
// the last N messages generally.

const TOOL_RESULT_MAX = 25;
const TOOL_RESULT_KEEP_RECENT = 10;

const toolResultVolumeRule: PruneRule = {
  id: "tool_result_volume",
  description: `Limit total tool results — prune oldest when count > ${TOOL_RESULT_MAX}, keep ${TOOL_RESULT_KEEP_RECENT} recent`,
  enabled: true,

  process(msg: MessageWithMetadata, ctx: PruneContext) {
    if (msg.metadata.shouldPrune) return;
    if (!hasToolResult(msg.message)) return;

    // Count tool results and find this message's index among them
    let totalResults = 0;
    let thisResultIndex = -1;
    for (let i = 0; i < ctx.messages.length; i++) {
      if (hasToolResult(ctx.messages[i].message)) {
        if (ctx.messages[i] === msg) {
          thisResultIndex = totalResults;
        }
        totalResults++;
      }
    }

    if (totalResults <= TOOL_RESULT_MAX) return;

    // Prune oldest excess: keep TOOL_RESULT_KEEP_RECENT most recent
    const excess = totalResults - TOOL_RESULT_KEEP_RECENT;
    if (thisResultIndex < excess) {
      msg.metadata.shouldPrune = true;
      msg.metadata.pruneReason = `excess_tool_result (${totalResults} total, keeping ${TOOL_RESULT_KEEP_RECENT})`;
    }
  },
};

function createRecencyRule(keepRecentCount: number): PruneRule {
  return {
    id: "recency",
    description: "Protect recent messages from pruning",
    enabled: true,

    prepare(msg: MessageWithMetadata, ctx: PruneContext) {
      msg.metadata.recencyScore = ctx.messages.length - 1 - ctx.index;
    },

    process(msg: MessageWithMetadata) {
      if (msg.metadata.recencyScore !== undefined && msg.metadata.recencyScore < keepRecentCount) {
        msg.metadata.shouldPrune = false;
      }
    },
  };
}

// Batch Context Reduction (BCR) - P4
// Collapse consecutive repeated tool call sequences into single entries with count.
// E.g., three `read` calls on same file -> one entry with count=3.






// Batch Context Reduction (BCR) - P4
// Collapses consecutive repeated tool calls. Extended with failure awareness
// (2604.15877): 3+ failures -> collapse + summarize error pattern.

/** @deprecated - kept for backward compat */








const batchCollapseRule: PruneRule = {
  id: "batch_collapse",
  description: "Collapse repeated tool calls + failure spiral detection (2604.15877)",
  enabled: true,

  prepare(msg: MessageWithMetadata) {
    if (msg.message.role !== "assistant") return;
    if (!Array.isArray(msg.message.content)) return;

    const toolCalls = msg.message.content.filter((c: any) => c.type === "toolCall");
    if (toolCalls.length !== 1) return;

    const toolCall = toolCalls[0] as { name?: string; arguments?: Record<string, unknown> };
    const toolName = toolCall.name ?? "";
    const toolArgs = JSON.stringify(toolCall.arguments ?? {});
    msg.metadata.bcrKey = `${toolName}:${toolArgs}`;
  },

  process(msg: MessageWithMetadata, ctx: PruneContext) {
    if (!msg.metadata.bcrKey) return;

    let count = 1;
    let prevIndex = ctx.index - 1;

    while (prevIndex >= 0) {
      const prev = ctx.messages[prevIndex];
      if (prev.metadata.bcrKey !== msg.metadata.bcrKey) break;
      if (prev.metadata.bcrCollapsed) {
        count += (prev.metadata.bcrCount as number) ?? 1;
      } else {
        count += 1;
      }
      prevIndex--;
    }

    if (count > 1) {
      msg.metadata.bcrCount = count;
      msg.metadata.bcrCollapsed = true;
      msg.metadata.shouldPrune = true;
      msg.metadata.pruneReason = `collapsed ${count}x repeated tool call`;
    }
  },
};

// ── Orphaned Tool Pair Repair ────────────────────────────────────────────────

function repairOrphanedToolPairs(messages: MessageWithMetadata[]): void {
  // Collect tool_use IDs from kept assistant messages
  const keptToolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.metadata.shouldPrune) continue;
    if (!hasToolUse(msg.message)) continue;
    for (const id of extractToolUseIds(msg.message)) {
      keptToolUseIds.add(id);
    }
  }

  // Find orphaned tool_results and resurrect their assistants
  const resurrected: MessageWithMetadata[] = [];
  for (const msg of messages) {
    if (msg.metadata.shouldPrune) continue;
    if (!hasToolResult(msg.message)) continue;

    const resultIds = extractResultIds(msg.message);
    for (const id of resultIds) {
      if (keptToolUseIds.has(id)) continue;

      // Orphaned - find and resurrect the matching assistant
      for (const candidate of messages) {
        if (!candidate.metadata.shouldPrune) continue;
        if (!hasToolUse(candidate.message)) continue;
        const candidateIds = extractToolUseIds(candidate.message);
        if (candidateIds.includes(id)) {
          candidate.metadata.shouldPrune = false;
          candidate.metadata.pruneReason = undefined;
          resurrected.push(candidate);
          for (const cid of candidateIds) keptToolUseIds.add(cid);
          break;
        }
      }
    }
  }

  // Second pass: un-prune tool_results paired with resurrected assistants
  for (const assistant of resurrected) {
    const assistantIds = extractToolUseIds(assistant.message);
    for (const msg of messages) {
      if (!msg.metadata.shouldPrune) continue;
      if (!hasToolResult(msg.message)) continue;
      const resultIds = extractResultIds(msg.message);
      if (resultIds.some((id) => assistantIds.includes(id))) {
        msg.metadata.shouldPrune = false;
        msg.metadata.pruneReason = undefined;
      }
    }
  }

  // Third pass: mark orphaned tool_results for pruning (their assistants were compacted)
  // This prevents "tool result's tool id not found" errors after compaction
  for (const msg of messages) {
    if (msg.metadata.shouldPrune) continue;
    if (!hasToolResult(msg.message)) continue;

    const resultIds = extractResultIds(msg.message);
    for (const id of resultIds) {
      if (keptToolUseIds.has(id)) continue;

      // This tool_result's tool_call was compacted away
      // Mark for pruning to prevent validation errors
      msg.metadata.shouldPrune = true;
      msg.metadata.pruneReason = "orphaned_tool_result";
      log.debug(`Marking orphaned tool_result for pruning: ${id}`);
      break;
    }
  }
}

// ── Pruning Workflow ─────────────────────────────────────────────────────────

export function createPruningState(keepRecentCount = 10): PruningState {
  const state: PruningState = {
    enabled: true,
    rules: [],
    keepRecentCount,
    protectedTools: new Set(["write", "edit"]),
    stats: {
      totalPruned: 0,
      totalProcessed: 0,
      pruneReasons: {},
    },
  };
  state.rules = [
    batchCollapseRule,
    deduplicationRule,
    supersededWritesRule,
    errorPurgingRule,
    toolResultVolumeRule,
    createRecencyRule(keepRecentCount),
  ];
  return state;
}

export function applyPruningWorkflow(
  state: PruningState,
  messages: AgentMessage[],
): AgentMessage[] {
  if (!state.enabled || messages.length === 0) {
    return messages;
  }

  // Phase 1: Wrap messages with metadata
  const withMetadata: MessageWithMetadata[] = messages.map((message) => ({
    message,
    metadata: {} as PruneMetadata,
  }));

  // Phase 2: Prepare - annotate metadata
  for (const rule of state.rules) {
    if (!rule.enabled) continue;
    if (!rule.prepare) continue;

    withMetadata.forEach((msg, index) => {
      try {
        rule.prepare!(msg, { messages: withMetadata, index });
      } catch (err) {
        log.error(`Rule "${rule.id}" prepare error:`, err);
      }
    });
  }

  // Phase 3: Process - make pruning decisions
  for (const rule of state.rules) {
    if (!rule.enabled) continue;
    if (!rule.process) continue;

    withMetadata.forEach((msg, index) => {
      try {
        rule.process!(msg, { messages: withMetadata, index });
      } catch (err) {
        log.error(`Rule "${rule.id}" process error:`, err);
      }
    });
  }

  // Phase 3.5: Repair orphaned tool pairs
  repairOrphanedToolPairs(withMetadata);

  // Phase 4: Filter
  const filtered = withMetadata.filter((m) => !m.metadata.shouldPrune).map((m) => m.message);

  // Update stats
  const prunedCount = messages.length - filtered.length;
  if (prunedCount > 0) {
    state.stats.totalPruned += prunedCount;
    state.stats.totalProcessed += messages.length;

    withMetadata
      .filter((m) => m.metadata.shouldPrune && m.metadata.pruneReason)
      .forEach((m) => {
        const reason = m.metadata.pruneReason!;
        state.stats.pruneReasons[reason] = (state.stats.pruneReasons[reason] || 0) + 1;
      });
  }

  return filtered;
}
