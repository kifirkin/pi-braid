import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("enforcement");
/**
 * Tool tracking - centralized tracking logic for all tool usage patterns
 */
import { recordCodeChange } from "../detection/verification.js";
import {
  getState,
  recordToolChainCall,
  recordMemoryAccess,
  recordContextTool,
  resetScratchpadNudge,
} from "../state.js";
import type { EnforcementState } from "../state.js";

/**
 * Record file paths from read/edit operations for re-read detection.
 * Called from tool_call event handler which has access to event.input.
 */
export function recordToolInput(
  toolName: string,
  input: Record<string, unknown> | undefined,
  s: EnforcementState,
): void {
  if (!input) return;

  const path = (input.path as string) ?? (input.target as string) ?? "";
  if (!path) return;

  if (toolName === "read") {
    // Normalize path for comparison: resolve relative paths
    const normalized = path.startsWith("/") ? path : path;
    s.recentlyReadFiles.set(normalized, s.currentTurn);
    // Prune old entries (keep only last 50 files)
    if (s.recentlyReadFiles.size > 50) {
      const oldest = [...s.recentlyReadFiles.entries()].sort((a, b) => a[1] - b[1]).slice(0, 10);
      for (const [k] of oldest) s.recentlyReadFiles.delete(k);
    }
  }
}

export function recordToolCall(toolName: string, ctx: any): void {
  const s = getState(ctx);

  // Track code changes (edit/write) for verification context
  if (toolName === "edit" || toolName === "write") {
    s.hasCodeChanges = true;
    recordCodeChange(s.currentTurn, ctx);
  }

  // Record general tool call (handles totals, unique tools, exploration)
  recordToolChainCall(s, toolName);

  // Track plan
  if (toolName === "plan") {
    s.toolChain.lastPlanCall = s.currentTurn;
  }

  // Track memory tool usage
  const memoryTools = ["memory_store", "memory_recall"];
  if (memoryTools.includes(toolName)) {
    recordMemoryAccess(s, s.currentTurn);
    if (toolName === "memory_recall" && !s.hasRecalledOnStart) {
      s.hasRecalledOnStart = true;
    }
  }

  // Track context management tools usage
  const contextTools = [
    "context_tag",
    "context_log",
    "context_checkout",
    "context_prune",
    "context_audit",
  ];
  if (contextTools.includes(toolName)) {
    recordContextTool(s, s.currentTurn);
  }

  // Track scratchpad usage as part of memory hygiene
  if (toolName === "scratchpad") {
    resetScratchpadNudge(s);
  }

  // Track tool sequence patterns
  const seqKey = toolName;
  const existing = s.toolSequencePatterns.get(seqKey);
  if (existing) {
    existing.count++;
    existing.lastSeen = 0;
  } else {
    s.toolSequencePatterns.set(seqKey, { sequence: [toolName], count: 1, lastSeen: 0 });
  }
  for (const [, pattern] of s.toolSequencePatterns) {
    pattern.lastSeen++;
  }
  for (const [key, pattern] of s.toolSequencePatterns) {
    if (pattern.lastSeen > 20) {
      s.toolSequencePatterns.delete(key);
    }
  }
}

export function recordBashDetails(command: string, s: EnforcementState): void {
  s.bashCalls = (s.bashCalls || 0) + 1;
  const cmd = command.toLowerCase();

  // bash with directory exploration also counts as exploration
  if (cmd.includes("ls ") || cmd === "ls" || cmd.startsWith("cd ") || cmd.includes("pwd")) {
    s.hasExplored = true;
    s.exploreCalledInSession = true;
  }

  // Record verification when tests are run
  const testPatterns = [
    "pytest",
    "python -m pytest",
    "python -m unittest",
    "vitest",
    "jest",
    "npm test",
    "npx tsx",
    "npx vitest",
    "npx jest",
    "tsx",
    "mocha",
    "cargo test",
    "go test",
    "rspec",
    "phpunit",
  ];
  if (testPatterns.some((p) => cmd.includes(p))) {
    s.verificationsDone++;
  }
}
