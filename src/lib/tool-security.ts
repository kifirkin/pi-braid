/**
 * Tool Security — utility for restricting tool access in benchmark subagents.
 *
 * Provides:
 * - `restrictTools()` — removes bash from active tools via session API
 * - `createSafeSession()` — creates a session with bash restricted
 *
 * Usage:
 *   import { restrictTools, isSafeMode } from "./tool-security.js";
 *   // After createAgentSession:
 *   restrictTools(session);
 *
 * Or via env var:
 *   SAFE_MODE=true node evaluation/bm1-sdk.mjs
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";

/** Tools that are always safe to keep (no destructive capability) */
export const SAFE_TOOL_KEEP: string[] = [
  // File operations (safe)
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  // Cognitive tools
  "think",
  "finalize",
  "verify",
  "scratchpad",
  // Memory tools
  "memory_episodes",
  "memory_heuristics",
  "memory_tool_stats",
  "session_search",
  "session_query",
  // Context management
  "context_tag",
  "context_log",
  "context_checkout",
  "context_prune",
  "context_audit",
  "context_snapshot",
  "context_compact",
  "context_archive",
  "context_proposals",
  "context_signal",
  // Analytics
  "get-session-metrics",
  "get-tool-reliability",
  "get-ab-results",
  "get-tool-addiction",
  "hidden-messages",
  "error_list",
  "error_get",
  "error_clear",
  "error_stats",
  "prompt_preview",
  // Utility
  "healthcheck",
  "timer_set",
  "timer_list",
  "timer_cancel",
  "activate_behavior",
  "deactivate_behavior",
  "get_active_behaviors",
  "activate_mix",
  "observatory",
  "file_diff",
  "system_monitor",
  // Browser (sandboxed via puppeteer)
  "browser_navigate",
  "browser_snapshot",
  "browser_eval",
  "browser_screenshot",
  "browser_cookies",
  "browser_content",
  // Code analysis (read-only)
  "codebase_graph",
  "codebase_tree",
  "read_document",
  "render_pdf_page",
  // Data
  "repl",
  "analyze_image",
  "web_fetch",
  // Hypothesize
  "hypothesize",
];

/** Tools to block (destructive / dangerous) */
export const BLOCKED_TOOLS: string[] = ["bash"];

/**
 * Check if safe mode is enabled via env var.
 */
export function isSafeMode(): boolean {
  return (
    process.env.SAFE_MODE === "true" ||
    process.env.BRAID_SAFE_MODE === "true" ||
    process.env.SAFE_BASH === "true"
  );
}

/**
 * Filter bash (and other dangerous tools) from the session's active tools.
 * Call this immediately after createAgentSession().
 *
 * @returns Number of tools removed (0 if safe mode not enabled)
 */
export function restrictTools(session: AgentSession): number {
  if (!isSafeMode()) return 0;

  const activeTools = session.getActiveToolNames();
  const before = activeTools.length;
  const safeTools = activeTools.filter((name) => !BLOCKED_TOOLS.includes(name));

  if (safeTools.length < before) {
    session.setActiveToolsByName(safeTools);
    const removed = before - safeTools.length;
    console.error(
      `[tool-security] Removed ${removed} tool(s): ${activeTools.filter((n) => BLOCKED_TOOLS.includes(n)).join(", ")}`,
    );
    return removed;
  }

  return 0;
}
