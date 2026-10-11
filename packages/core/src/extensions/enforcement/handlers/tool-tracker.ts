/**
 * Tool tracking - centralized tracking logic for all tool usage patterns
 */
import { recordCodeChange } from "../detection/verification.js";
import { PROGRESS_TOOLS } from "../substate/tool-tracking-state.js";
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
    // Map value: the tool-call position of the last read of this path. A path
    // that is already mapped with no progress tool since was read before and
    // is being read again without anything changing in between; the list is
    // consumed by turn validation.
    const priorRead = s.recentlyReadFiles.get(path);
    if (
      priorRead !== undefined &&
      priorRead >= s.lastProgressToolCall &&
      !s.turnReReadWastePaths.includes(path)
    ) {
      s.turnReReadWastePaths.push(path);
    }
    s.recentlyReadFiles.set(path, s.totalToolCalls);
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

  recordToolChainCall(s, toolName);

  // Remember where progress landed: a read that predates the latest edit,
  // write, or command is stale context, not waste.
  if (PROGRESS_TOOLS.has(toolName)) {
    s.lastProgressToolCall = s.totalToolCalls;
  }

  if (toolName === "plan") {
    s.toolChain.lastPlanCall = s.currentTurn;
  }

  const memoryTools = ["memory_store", "memory"];
  if (memoryTools.includes(toolName)) {
    recordMemoryAccess(s, s.currentTurn);
    if (toolName === "memory" && !s.hasRecalledOnStart) {
      s.hasRecalledOnStart = true;
    }
  }

  // Context-management tools: the names registered by context-manager plus
  // context_proposals (context-lifecycle).
  const contextTools = new Set([
    "context_inspect",
    "context_compress",
    "context_navigate",
    "context_proposals",
  ]);
  if (contextTools.has(toolName)) {
    recordContextTool(s, s.currentTurn);
  }

  // Track scratchpad usage as part of memory hygiene
  if (toolName === "scratchpad") {
    resetScratchpadNudge(s);
  }

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
