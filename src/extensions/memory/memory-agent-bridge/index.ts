/**
 * Cognitive Systems Extension
 *
 * Unified cognitive memory with semantic search:
 * - memory_store/recall/list/get: Semantic memory management
 * - explore_paths: Parallel sub-agent exploration of hypotheses
 *
 * Tools are extracted into sibling modules; this file owns the session
 * lifecycle (MemoryBridgeStats, SESSION_SHUTDOWN summary) and wires
 * the 4 tool factories together.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCognitiveMemory } from "../../../lib/memory/index.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { createLogger } from "../../../lib/core/logger.js";
import { SESSION_SHUTDOWN } from "../../../lib/core/event-names.js";

// explore-paths tool - parallel hypothesis investigation
// Extracted to ./explore-paths.ts
import { createExplorePathsTool } from "./explore-paths.js";

// memory_store tool - persist insights to long-term memory
// Extracted to ./memory-store-tool.ts
import { createMemoryStoreTool } from "./memory-store-tool.js";

// memory tool - unified memory access across three domains
// Extracted to ./memory-tool.ts
import { createMemoryTool } from "./memory-tool.js";

// conflict_qa tool - view and resolve knowledge conflicts
// Extracted to ./conflict-qa-tool.ts
import { createConflictQATool } from "./conflict-qa-tool.js";

const log = createLogger("memory-agent-bridge");

// ── Memory tool usage tracking (2026-06-22) ────────────────────────────────
//
// An audit of 246 sessions found 0.84% of tool calls hit a memory_* tool,
// and 8 of the last 10 sessions used zero memory tools. The fix has three
// parts:
//   1. Behavioral: a new MEMORY_AWARENESS directive in
//      src/extensions/core/prompt-builder/identity.ts.
//   2. Discoverability: pointer-block rendering in
//      src/extensions/core/prompt-builder/memory-section.ts.
//   3. Measurement (this block): a per-session counter, logged at
//      session_end, so the next 100 sessions can show whether (1) and
//      (2) actually move the needle.
//
// The audit baseline (0.84%) is included in the zero-call log line so
// the contrast is visible at a glance.
export interface MemoryBridgeStats {
  memoryToolCalls: number;
  firstCallAt: number | null;
  lastCallAt: number | null;
  /** Per-tool counts. For the unified `memory` tool, the key includes
   *  the action, e.g. "memory:recall_search". */
  perToolCounts: Record<string, number>;
}

function createMemoryBridgeStats(): MemoryBridgeStats {
  return {
    memoryToolCalls: 0,
    firstCallAt: null,
    lastCallAt: null,
    perToolCounts: {},
  };
}

export { createMemoryBridgeStats };

function getMemoryBridgeStats(ctx: ExtensionContext | undefined): MemoryBridgeStats | null {
  if (!ctx) return null;
  return getExtensionState<MemoryBridgeStats>(
    ctx,
    "memory-bridge-stats",
    createMemoryBridgeStats,
  );
}

/** Record one memory_* tool invocation. Safe to call with no ctx. */
function recordMemoryToolCall(ctx: ExtensionContext | undefined, tool: string): void {
  const stats = getMemoryBridgeStats(ctx);
  if (!stats) return;
  const now = Date.now();
  stats.memoryToolCalls++;
  stats.perToolCounts[tool] = (stats.perToolCounts[tool] ?? 0) + 1;
  if (stats.firstCallAt === null) stats.firstCallAt = now;
  stats.lastCallAt = now;
}

export { getMemoryBridgeStats, recordMemoryToolCall };

export default function cognitiveMemoryExtension(pi: ExtensionAPI) {
  const memory = getCognitiveMemory();
  // Initialize async - tools will await before first use
  const initPromise: Promise<void> | null = memory.init();

  // ── Session-end memory usage summary ────────────────────────────────────
  // See the MemoryBridgeStats block above for the rationale (audit
  // baseline 0.84%, MEMORY_AWARENESS directive is the fix, this log is
  // the measurement). The log line includes the audit baseline so the
  // contrast is visible at a glance.
  //
  // Note: we use SESSION_SHUTDOWN (the actual end-of-session hook on
  // ExtensionAPI), not the SESSION_END constant from
  // lib/core/event-names.ts (which is for the internal event-bus, not
  // pi.on). The event-names SESSION_END is a misnomer; pi's real
  // end-of-session event is session_shutdown.
  pi.on(SESSION_SHUTDOWN, async (_event: unknown, ctx: ExtensionContext) => {
    const stats = getMemoryBridgeStats(ctx);
    if (!stats) return;
    if (stats.memoryToolCalls === 0) {
      log.info(
        "[memory-agent-bridge] Session memory tool usage: 0 calls " +
          "(audit baseline 0.84% - MEMORY_AWARENESS directive not landing)",
      );
    } else {
      const breakdown = Object.entries(stats.perToolCounts)
        .sort(([, a], [, b]) => b - a)
        .map(([t, c]) => `${t}=${c}`)
        .join(", ");
      log.info(
        `[memory-agent-bridge] Session memory tool usage: ${stats.memoryToolCalls} calls (${breakdown}) ` +
          `(audit baseline 0.84% - check whether MEMORY_AWARENESS is moving the needle)`,
      );
    }
  });

  // ── Tool registrations ──────────────────────────────────────────────────

  // memory_store tool - persist insights to long-term memory
  const memoryStoreTool = createMemoryStoreTool(memory, initPromise, recordMemoryToolCall);
  pi.registerTool({
    name: memoryStoreTool.name,
    label: memoryStoreTool.label,
    promptSnippet: memoryStoreTool.promptSnippet,
    description: memoryStoreTool.description,
    parameters: memoryStoreTool.parameters,
    execute: memoryStoreTool.execute,
  });

  // memory tool - unified memory access across three domains
  const memoryTool = createMemoryTool(memory, initPromise, recordMemoryToolCall);
  pi.registerTool({
    name: memoryTool.name,
    label: memoryTool.label,
    promptSnippet: memoryTool.promptSnippet,
    description: memoryTool.description,
    parameters: memoryTool.parameters,
    execute: memoryTool.execute,
  });

  // explore_paths tool - parallel hypothesis investigation
  const explorePathsTool = createExplorePathsTool();
  pi.registerTool({
    name: explorePathsTool.name,
    label: explorePathsTool.label,
    promptSnippet: explorePathsTool.promptSnippet,
    description: explorePathsTool.description,
    parameters: explorePathsTool.parameters,
    execute: explorePathsTool.execute,
  });

  // conflict_qa tool - view and resolve knowledge conflicts
  const conflictQATool = createConflictQATool();
  pi.registerTool({
    name: conflictQATool.name,
    label: conflictQATool.label,
    promptSnippet: conflictQATool.promptSnippet,
    description: conflictQATool.description,
    parameters: conflictQATool.parameters,
    execute: conflictQATool.execute,
  });
}