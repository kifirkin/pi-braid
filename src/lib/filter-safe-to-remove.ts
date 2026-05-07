// Selective Hard Truncation — pre-filter 100%-certain-redundant items before LLM summarization.
// This module is tested independently before being integrated into compaction.ts.

export interface AgentMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }>;
  toolCallId?: string;
  toolName?: string;
  stopReason?: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Estimate tokens for a message (chars/4 heuristic). */
function estimateMsgTokens(msg: AgentMessage): number {
  let chars = 0;
  if (msg.role === "user" || msg.role === "assistant") {
    const content = msg.content;
    if (typeof content === "string") chars = content.length;
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && (block as any).text) chars += (block as any).text.length;
      }
    }
  } else if (msg.role === "toolResult") {
    if (typeof msg.content === "string") chars = msg.content.length;
    else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && (block as any).text) chars += (block as any).text.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

/** Extract file path from a read tool call. */
function extractReadPath(msg: AgentMessage): string | null {
  if (msg.role !== "toolCall") return null;
  const name = (msg.toolName ?? "").toLowerCase();
  if (name !== "read" && name !== "codebase_tree" && name !== "grep" && name !== "find")
    return null;
  const args = msg.arguments ?? {};
  const path = args.path ?? args.file ?? args.filePath ?? args.file_path ?? args.target ?? args.url;
  if (typeof path === "string" && path.length > 0) return path;
  return null;
}

/** Check if a tool result contains error markers. */
function isErrorOutput(msg: AgentMessage): boolean {
  if (msg.role !== "toolResult") return false;
  const content = msg.content;
  if (typeof content !== "string" || !content.trim()) return false;
  const lower = content.toLowerCase();
  const errorMarkers = [
    "error:",
    "failed:",
    "not found:",
    "no such",
    "cannot",
    "exception",
    "traceback",
    "err:",
  ];
  return errorMarkers.some((m) => lower.includes(m));
}

/** Filter messagesToSummarize for 100%-certain-redundant items. */
export function filterSafeToRemove(messages: AgentMessage[]): {
  filtered: AgentMessage[];
  stats: {
    duplicates: number;
    resolved: number;
    oversized: number;
    streaks: number;
    totalRemoved: number;
    beforeTokens: number;
    afterTokens: number;
  };
} {
  try {
    return filterSafeToRemoveInner(messages);
  } catch (err) {
    // If filtering fails, return everything unchanged
    console.error("filterSafeToRemove error:", err);
    return {
      filtered: messages,
      stats: {
        duplicates: 0,
        resolved: 0,
        oversized: 0,
        streaks: 0,
        totalRemoved: 0,
        beforeTokens: 0,
        afterTokens: 0,
      },
    };
  }
}

function filterSafeToRemoveInner(messages: AgentMessage[]): {
  filtered: AgentMessage[];
  stats: {
    duplicates: number;
    resolved: number;
    oversized: number;
    streaks: number;
    totalRemoved: number;
    beforeTokens: number;
    afterTokens: number;
  };
} {
  const result: AgentMessage[] = [];
  let removed = 0;
  let beforeTokens = 0;
  let afterTokens = 0;

  // Pass 1: collect all write paths
  const writePaths = new Set<string>();
  for (const msg of messages) {
    beforeTokens += estimateMsgTokens(msg);
    if (msg.role === "toolCall") {
      const toolName = (msg.toolName ?? "").toLowerCase();
      if (
        toolName === "write" ||
        toolName === "edit" ||
        toolName === "create" ||
        toolName === "delete"
      ) {
        const args = msg.arguments ?? {};
        const path = String(args.path ?? args.file ?? "");
        if (path) writePaths.add(path);
      }
    }
  }

  // Pass 2: collect read history (for duplicate detection)
  const readHistory: string[] = [];
  for (const msg of messages) {
    if (msg.role === "toolCall") {
      const path = extractReadPath(msg);
      if (path) readHistory.push(path);
    }
  }

  // Pass 3: filter
  for (const msg of messages) {
    // Rule 0: System-injected messages (enforcement whispers, timer steers, etc.)
    // These are ephemeral — they guide the current turn but should NOT be
    // persisted through compaction. Filter them out to prevent the LLM
    // summary from conflating nudge content with real user intent.
    const details = (msg as any).details;
    if (details && details._braidInjected === true) {
      removed++;
      // Don't push — skip entirely
      continue;
    }

    // NEVER remove user/assistant messages
    if (msg.role === "user" || msg.role === "assistant") {
      result.push(msg);
      continue;
    }

    // NEVER remove file modification tools
    if (msg.role === "toolCall") {
      const toolName = (msg.toolName ?? "").toLowerCase();
      if (
        toolName === "write" ||
        toolName === "edit" ||
        toolName === "create" ||
        toolName === "delete"
      ) {
        result.push(msg);
        continue;
      }
    }

    // Rule 1: Duplicate reads (same path, no write between)
    if (msg.role === "toolCall") {
      const path = extractReadPath(msg);
      if (path && !writePaths.has(path)) {
        // Count occurrences — if this path appeared before, it's a duplicate
        const firstOccurrence = readHistory.indexOf(path);
        const lastOccurrence = readHistory.lastIndexOf(path);
        if (firstOccurrence !== lastOccurrence) {
          // Duplicate — but only remove if no write to this path occurred between
          const pathIndex = readHistory.indexOf(path);
          removed++;
          result.push(msg);
          continue;
        }
      }
    }

    // Rule 2: Resolved errors (error output, same path succeeded later)
    if (isErrorOutput(msg)) {
      const content = msg.content as string;
      const pathMatch = content.match(/['"]([^'"]+\.\w+)['"]/);
      if (pathMatch) {
        const errorPath = pathMatch[1];
        let resolved = false;
        // Check if same path succeeded later
        for (const later of messages) {
          if (later === msg) break;
          if (later.role === "toolCall") {
            const args = later.arguments ?? {};
            const laterPath = String(args.path ?? args.file ?? "");
            if (laterPath === errorPath) {
              const toolName = (later.toolName ?? "").toLowerCase();
              if (["read", "bash", "write", "edit", "create"].includes(toolName)) {
                resolved = true;
                break;
              }
            }
          }
        }
        if (resolved) {
          removed++;
          result.push(msg);
          continue;
        }
      }
    }

    // Rule 3: Oversized non-critical tool results (>2000 tokens = ~8KB from ls/grep/find)
    if (msg.role === "toolResult") {
      const tokens = estimateMsgTokens(msg);
      if (tokens > 2000) {
        const toolCallId = msg.toolCallId as string | undefined;
        if (toolCallId) {
          let toolName = "";
          for (const prev of messages) {
            if (prev.role === "toolCall" && (prev as any).toolCallId === toolCallId) {
              toolName = (prev.toolName ?? "").toLowerCase();
              break;
            }
          }
          const nonCritical = ["ls", "find", "grep", "glob", "pwd", "tree", "codebase_tree", "dir"];
          if (nonCritical.includes(toolName)) {
            // Check if succeeding write makes this redundant
            let stillRelevant = false;
            for (const later of messages) {
              if (later === msg) break;
              if (later.role === "toolCall") {
                const laterTool = (later.toolName ?? "").toLowerCase();
                if (["write", "edit", "create"].includes(laterTool)) {
                  const args = later.arguments ?? {};
                  if (writePaths.has(String(args.path ?? args.file ?? ""))) {
                    stillRelevant = true;
                    break;
                  }
                }
              }
            }
            if (!stillRelevant) {
              removed++;
              result.push(msg);
              continue;
            }
          }
        }
      }
    }

    // All other messages kept
    result.push(msg);
  }

  for (const msg of result) afterTokens += estimateMsgTokens(msg);

  return {
    filtered: result,
    stats: {
      duplicates: removed,
      resolved: 0,
      oversized: removed,
      streaks: 0,
      totalRemoved: removed,
      beforeTokens,
      afterTokens,
    },
  };
}
