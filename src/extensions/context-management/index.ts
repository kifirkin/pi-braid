/**
 * Context Management Extension — Tool Profile Switching.
 *
 * Reduces the active tool set from ~45 to ~10 by default using
 * `pi.setActiveTools()`, with context-appropriate profiles.
 *
 * Profiles:
 *   lean      — default (~10 tools): general-purpose coding & reasoning
 *   research  — information gathering: search, web fetch, memory
 *   debugging — bug finding & fixing: hypothesize, explore_paths, conflict_qa
 *   browser   — web browsing & UI testing: browser automation, analyze_image
 *   deep      — deep code analysis: codebase, file_diff, full workspace tools
 *
 * Usage:
 *   The agent calls `set_tool_profile` to switch profiles at runtime.
 *   On extension load, the `lean` profile is applied automatically.
 *
 * The tool name is `set_tool_profile` (not `tool_profile` or `profile`) to
 * keep it discoverable and unambiguous in the active tool list.
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../../lib/core/logger.js";

const log = createLogger("context-management");

// ── Profile Definitions ──────────────────────────────────────────────────────

/**
 * Each profile is a named set of tool names.
 * Tools not in the set are deactivated until the profile is switched.
 *
 * Design principle: each profile includes ~10 tools that are essential for
 * the task category. Tools outside the profile are still registered but
 * hidden from the agent's system prompt until re-enabled.
 */
const PROFILES: Record<string, string[]> = {
  /**
   * lean — default profile. General-purpose coding with reasoning support.
   * Covers file ops, search, shell, reasoning, verification, and memory.
   */
  lean: [
    // profile switch (must be in every profile to avoid lock-out)
    "set_tool_profile",
    // file ops
    "read",
    "edit",
    "write",
    // search & shell
    "bash",
    "grep",
    "find",
    "ls",
    // reasoning & verification
    "think",
    "verify",
    "finalize",
    // session state
    "scratchpad",
    "memory",
  ],

  /**
   * research — information gathering and exploration.
   * Adds web fetch, batch fetch, and memory retrieval while keeping
   * file search and reasoning core.
   */
  research: [
    // profile switch (must be in every profile to avoid lock-out)
    "set_tool_profile",
    "read",
    "web_fetch",
    "batch_web_fetch",
    "grep",
    "find",
    "ls",
    "bash",
    "think",
    "memory",
    "scratchpad",
    "verify",
  ],

  /**
   * debugging — finding and fixing bugs.
   * Adds hypothesize, explore_paths, conflict_qa for diagnostic workflows.
   * Keeps write/edit for fixes.
   */
  debugging: [
    // profile switch (must be in every profile to avoid lock-out)
    "set_tool_profile",
    "read",
    "edit",
    "write",
    "bash",
    "grep",
    "find",
    "ls",
    "think",
    "hypothesize",
    "explore_paths",
    "verify",
    "conflict_qa",
  ],

  /**
   * browser — web browsing and UI testing.
   * Includes browser automation tools, analyze_image for screenshots,
   * and web_fetch for page source inspection.
   */
  browser: [
    // profile switch (must be in every profile to avoid lock-out)
    "set_tool_profile",
    "browser_navigate",
    "browser_snapshot",
    "browser_eval",
    "browser_screenshot",
    "read",
    "bash",
    "think",
    "analyze_image",
    "web_fetch",
    "verify",
  ],

  /**
   * deep — deep code analysis and modification.
   * Adds codebase (dependency graph), file_diff (comparison),
   * and workspace_snapshot for working with complex code changes.
   */
  deep: [
    // profile switch (must be in every profile to avoid lock-out)
    "set_tool_profile",
    "read",
    "edit",
    "write",
    "bash",
    "grep",
    "find",
    "ls",
    "think",
    "verify",
    "codebase",
    "file_diff",
    "scratchpad",
  ],
};

const PROFILE_NAMES = Object.keys(PROFILES);
const DEFAULT_PROFILE = "lean";

// ── Profile Application ──────────────────────────────────────────────────────

let _currentProfile: string | null = null;

/**
 * Apply a tool profile by calling pi.setActiveTools().
 * Returns the list of tools that were activated.
 */
function applyProfile(pi: ExtensionAPI, profileName: string): string[] {
  const tools = PROFILES[profileName];
  if (!tools) {
    throw new Error(`Unknown tool profile: "${profileName}". Available: ${PROFILE_NAMES.join(", ")}`);
  }

  pi.setActiveTools(tools);
  _currentProfile = profileName;
  log.info(`[context-management] switched to profile "${profileName}" (${tools.length} tools)`);
  log.debug(`[context-management] active tools: ${tools.join(", ")}`);

  return tools;
}

// ── Tool Definition ──────────────────────────────────────────────────────────

function createSetToolProfileTool(pi: ExtensionAPI): ToolDefinition<any, any, any> {
  return {
    name: "set_tool_profile",
    label: "Set Tool Profile",
    promptSnippet:
      "Switch tool profiles: lean (general), research (info gathering), debugging (bug fixing), browser (web/UI), deep (code analysis)",
    description: `Switch between curated tool profiles that reduce the active tool set from ~45 to ~10.

Each profile is optimized for a specific task category:

  lean      — General-purpose coding & reasoning (default, ~10 tools)
  research  — Information gathering: web search, browsing, memory recall (~10 tools)
  debugging — Bug finding & fixing: hypothesize, explore_paths, conflict_qa (~10 tools)
  browser   — Web browsing & UI testing: browser automation, screenshot analysis (~10 tools)
  deep      — Deep code analysis: dependency graph, file diff, workspace snapshots (~10 tools)

Call this tool at any time to switch profiles. The new profile takes effect immediately
and the system prompt is rebuilt to reflect the active tool set.`,
    parameters: Type.Object({
      profile: Type.Union(
        [Type.Literal("lean"), Type.Literal("research"), Type.Literal("debugging"), Type.Literal("browser"), Type.Literal("deep")],
        {
          description: "Tool profile to activate",
        },
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: unknown,
      _onUpdate: unknown,
      _ctx: ExtensionContext | undefined,
    ) => {
      const profile = params.profile as string;
      const tools = applyProfile(pi, profile);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                profile,
                activeTools: tools.length,
                tools,
              },
              null,
              2,
            ),
          },
        ],
        details: { profile, activeTools: tools.length },
      };
    },
  };
}

// ── Extension Factory ────────────────────────────────────────────────────────

export default function contextManagementExtension(pi: ExtensionAPI): void {
  // Register the profile-switching tool (pi is captured in closure for execute handler)
  pi.registerTool(createSetToolProfileTool(pi));
  log.info("[context-management] registered set_tool_profile tool");

  // Apply the default profile on load so the agent starts with a lean tool set
  applyProfile(pi, DEFAULT_PROFILE);
}

// ── Exports (for testing / programmatic access) ──────────────────────────────

export { PROFILES, PROFILE_NAMES, DEFAULT_PROFILE, applyProfile, _currentProfile };