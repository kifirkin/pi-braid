/**
 * Tool tracking - centralized tracking logic for all tool usage patterns
 */
import { recordCodeChange } from "../detection/verification.js";
import { PROGRESS_TOOLS } from "../substate/tool-tracking-state.js";
import type { ReadRange } from "../substate/tool-tracking-state.js";
import {
  getState,
  recordToolChainCall,
  recordMemoryAccess,
  recordContextTool,
  resetScratchpadNudge,
} from "../state.js";
import type { EnforcementState } from "../state.js";

/**
 * Lines a read brings into context when it names no `limit`: the read tool
 * truncates to its own DEFAULT_MAX_LINES (2000) from the offset. Without the
 * cap a read with no limit would look like it covered the whole file and every
 * later line the tool never returned would read as already in context.
 */
const READ_DEFAULT_LIMIT = 2000;

/**
 * Windows kept per path, the oldest dropped past this. A dropped window only
 * shrinks what counts as in context, so the bound can hide a repeat but can
 * never invent one.
 */
const READ_RANGES_PER_PATH = 8;

/** The line window a read asks for, `[start, end)`, from its own bounds and the tool's defaults. */
function readWindow(input: Record<string, unknown>): { start: number; end: number } {
  const offset =
    typeof input.offset === "number" && Number.isFinite(input.offset) ? input.offset : 0;
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
      ? input.limit
      : READ_DEFAULT_LIMIT;
  const start = offset > 0 ? offset : 0;
  return { start, end: start + limit };
}

/**
 * Whether these windows leave no line of `[start, end)` out. They are merged
 * and ascending, so one pass over this path's own windows settles it.
 */
function coversWindow(windows: ReadRange[], start: number, end: number): boolean {
  let coveredTo = start;
  for (const w of windows) {
    if (w.start > coveredTo) return false;
    if (w.end > coveredTo) coveredTo = w.end;
    if (coveredTo >= end) return true;
  }
  return coveredTo >= end;
}

/** The newest position among a path's windows, for the path-population prune. */
function newestReadAt(windows: ReadRange[]): number {
  let newest = 0;
  for (const w of windows) if (w.at > newest) newest = w.at;
  return newest;
}

/**
 * Record one `read` call: flag the path when every line it asks for is already
 * in context, then keep the window for the reads that follow.
 */
function recordRead(s: EnforcementState, path: string, input: Record<string, unknown>): void {
  const { start, end } = readWindow(input);

  // A window recorded before the last progress tool describes context an
  // edit, write or command has since replaced: stale, not waste.
  const windows = (s.recentlyReadFiles.get(path) ?? []).filter(
    (w) => w.at >= s.lastProgressToolCall,
  );

  if (coversWindow(windows, start, end) && !s.turnReReadWastePaths.includes(path)) {
    s.turnReReadWastePaths.push(path);
  }

  windows.push({ start, end, at: s.totalToolCalls });
  windows.sort((a, b) => a.start - b.start);

  // Keep a disjoint ascending set: reading one slice again then costs one
  // window instead of consuming the per-path bound.
  const merged: ReadRange[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
      last.at = Math.max(last.at, w.at);
    } else {
      merged.push({ ...w });
    }
  }
  while (merged.length > READ_RANGES_PER_PATH) {
    let oldest = 0;
    for (let i = 1; i < merged.length; i++) {
      if (merged[i].at < merged[oldest].at) oldest = i;
    }
    merged.splice(oldest, 1);
  }
  s.recentlyReadFiles.set(path, merged);

  // Prune old entries (keep only last 50 files)
  if (s.recentlyReadFiles.size > 50) {
    const oldest = [...s.recentlyReadFiles.entries()]
      .sort((a, b) => newestReadAt(a[1]) - newestReadAt(b[1]))
      .slice(0, 10);
    for (const [k] of oldest) s.recentlyReadFiles.delete(k);
  }
}

/**
 * Record the window each read asks for, so turn validation can name only the
 * reads whose lines are already in context.
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
    recordRead(s, path, input);
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
