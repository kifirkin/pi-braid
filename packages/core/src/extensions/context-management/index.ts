/**
 * Context Management Extension — Tool Profile Switching.
 *
 * A profile is a named narrowing of the active tool set, taken through
 * `pi.setActiveTools()` when the session asks for one.
 *
 * Profiles:
 *   lean      — general-purpose coding & reasoning (~12 tools)
 *   research  — information gathering: search, web fetch, memory
 *   debugging — bug finding & fixing: hypothesize, explore_paths, conflict_qa
 *   browser   — web browsing & UI testing: browser automation, describe_image
 *   deep      — deep code analysis: codebase, file_diff, full workspace tools
 *
 * Usage:
 *   The agent calls `set_tool_profile` to narrow the set at runtime; the
 *   chosen profile is re-asserted before a run if the active set drifted from
 *   it.
 *
 * This extension holds the other end of the active set too: braid registers
 * some of its tools deferred, and a session without `tool_search` cannot reach
 * them at all. `ensureDiscoveryTool` adds it at session start (see the
 * Discovery Guard section).
 *
 * A session is born with pi-core's default tool selection plus every tool the
 * extensions register; this extension narrows the set only when the session
 * asks. A list applied at session start guesses what the session was started
 * to do, and a wrong guess is a silent loss: a curated dozen cannot hold the
 * families a dispatch session needs (orchestration, Telegram), which then
 * cannot follow its own boot contract. Nothing readable at session start
 * separates the sessions a narrowing suits from the ones it breaks (same
 * registry, same install, same settings), so narrowing stays a request, made
 * by the layer that knows the session's role.
 *
 * The tool name is `set_tool_profile` (not `tool_profile` or `profile`) to
 * keep it discoverable and unambiguous in the active tool list.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../../lib/core/logger.js";
import { registerSessionStartHandler, SessionPhase } from "../../lib/state/session-start-queue.js";
import { readGlobalEnabledTools } from "../../lib/config/per-tool-settings.js";

const log = createLogger("context-management");

/**
 * Each profile is a named set of tool names.
 * Tools not in the set are deactivated until the profile is switched.
 *
 * Design principle: each profile includes ~12 tools that are essential for
 * the task category. Tools outside the profile are still registered but
 * hidden from the agent's system prompt until re-enabled.
 */
const PROFILES: Record<string, string[]> = {
  /**
   * lean — general-purpose coding with reasoning support.
   * Covers file ops, search, shell, reasoning, verification, and memory.
   */
  lean: [
    // Must be in every profile: the switch itself (a profile without it locks
    // the agent out of switching) and the discovery tool the deferred tools
    // are unreachable without.
    "set_tool_profile",
    "tool_search",
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
    // Must be in every profile: the switch itself (a profile without it locks
    // the agent out of switching) and the discovery tool the deferred tools
    // are unreachable without.
    "set_tool_profile",
    "tool_search",
    "read",
    "fetch_content",
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
    // Must be in every profile: the switch itself (a profile without it locks
    // the agent out of switching) and the discovery tool the deferred tools
    // are unreachable without.
    "set_tool_profile",
    "tool_search",
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
   * Includes browser automation tools, describe_image for screenshots,
   * and fetch_content for page source inspection.
   */
  browser: [
    // Must be in every profile: the switch itself (a profile without it locks
    // the agent out of switching) and the discovery tool the deferred tools
    // are unreachable without.
    "set_tool_profile",
    "tool_search",
    "browser_navigate",
    "browser_snapshot",
    "browser_eval",
    "browser_screenshot",
    "read",
    "bash",
    "think",
    "describe_image",
    "fetch_content",
    "verify",
  ],

  /**
   * deep — deep code analysis and modification.
   * Adds codebase (dependency graph), file_diff (comparison),
   * and workspace_snapshot for working with complex code changes.
   */
  deep: [
    // Must be in every profile: the switch itself (a profile without it locks
    // the agent out of switching) and the discovery tool the deferred tools
    // are unreachable without.
    "set_tool_profile",
    "tool_search",
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

/**
 * The profile this session asked for, or null while it has asked for none.
 *
 * null is the born state, not a profile: the active set is left as pi-core,
 * the operator's `/tools` list and the other extensions built it. Only
 * `set_tool_profile` moves this off null.
 */
let _currentProfile: string | null = null;

/**
 * The tools of `profileName` that the registry currently holds.
 *
 * A profile may name a tool whose extension is not loaded in this install;
 * pi-core drops unknown names from setActiveTools() silently, so resolving
 * here keeps the applied set and the reported set the same thing.
 */
function resolveProfile(pi: ExtensionAPI, profileName: string): string[] {
  const tools = PROFILES[profileName];
  if (!tools) {
    throw new Error(
      `Unknown tool profile: "${profileName}". Available: ${PROFILE_NAMES.join(", ")}`,
    );
  }
  const registered = new Set(pi.getAllTools().map((t) => t.name));
  return tools.filter((name) => registered.has(name));
}

/**
 * Apply a tool profile by calling pi.setActiveTools().
 * Returns the list of tools that were activated.
 */
function applyProfile(pi: ExtensionAPI, profileName: string): string[] {
  const tools = resolveProfile(pi, profileName);

  pi.setActiveTools(tools);
  _currentProfile = profileName;
  log.info(`[context-management] switched to profile "${profileName}" (${tools.length} tools)`);
  log.debug(`[context-management] active tools: ${tools.join(", ")}`);

  return tools;
}

/**
 * Whether the operator picked the tool set by hand (/tools persists an
 * explicit list). That choice outranks a profile asserted in the background:
 * this extension owns the narrowing requests, not the operator's
 * configuration. A live `set_tool_profile` call still applies - the agent is
 * the one asking.
 */
function operatorChoseTools(): boolean {
  return Array.isArray(readGlobalEnabledTools());
}

/**
 * Put the active set back on the profile this session asked for, when it has
 * drifted.
 *
 * Nothing is asserted while no profile was asked for: with none, the active
 * set belongs to pi-core, to the operator's `--tools`/`/tools` choice and to
 * the sibling extensions, and this extension has no claim on it. Restoration
 * exists for the narrowed case - pi-core's runtime build and sibling
 * extensions rewrite the active set (a /reload re-activates the whole
 * registry), and the agent's own narrowing has to survive that.
 *
 * The profile cannot be applied from the factory: pi-core binds the extension
 * runtime after the factory returns, so setActiveTools() there throws
 * "Extension runtime not initialized" and the call is lost. Asserting it
 * here, where the active set is readable, is cheap in the steady state: a
 * name comparison only, no write, unless something actually widened the set.
 */
function assertProfile(pi: ExtensionAPI, reason: string): void {
  if (_currentProfile === null) return;
  const profileName = _currentProfile;
  const wanted = resolveProfile(pi, profileName);
  const active = pi.getActiveTools() ?? [];
  const activeSet = new Set(active);
  if (active.length === wanted.length && wanted.every((name) => activeSet.has(name))) return;
  if (operatorChoseTools()) return;

  log.info(`[context-management] active set drifted from "${profileName}" (${reason}) - restoring`);
  applyProfile(pi, profileName);
}

/**
 * The tool that finds the tools braid does not declare.
 *
 * braid registers its cold tools with `exposure: "deferred"`: pi declares one
 * to the model only once something activates it, and `tool_search` is the only
 * thing that can (it is a pi built-in extension that registers the tool
 * inactive). The deferral is braid's decision, so keeping the discovery path
 * open is braid's job - not a setting the operator has to remember.
 */
const DISCOVERY_TOOL = "tool_search";

/**
 * Activate the discovery tool when the session does not hold it.
 *
 * Additive by construction: the current set is the input, so whatever a
 * profile, the operator's `--tools`/`/tools` list or a sibling extension
 * activated stays active, and pi drops pending tools only when a set removes a
 * name - which this never does. Returns the names it added.
 *
 * Nothing is written when the registry does not hold the tool (an install with
 * the built-in tool-search extension disabled has nothing to activate) or when
 * the active set is unreadable: treating `getActiveTools()` returning nothing
 * as an empty set would replace the whole set with this one tool.
 */
function ensureDiscoveryTool(pi: ExtensionAPI): string[] {
  const active = pi.getActiveTools();
  if (!active || active.includes(DISCOVERY_TOOL)) return [];
  if (!pi.getAllTools().some((t) => t.name === DISCOVERY_TOOL)) return [];

  pi.setActiveTools([...active, DISCOVERY_TOOL]);
  log.info(`[context-management] activated "${DISCOVERY_TOOL}" (deferred tools need it)`);
  return [DISCOVERY_TOOL];
}

function createSetToolProfileTool(pi: ExtensionAPI): ToolDefinition<any, any, any> {
  return {
    name: "set_tool_profile",
    label: "Set Tool Profile",
    promptSnippet: "Switch tool profiles: lean, research, debugging, browser, deep",
    description:
      "Switch between curated tool profiles that cut the active tool set to ~12; takes effect immediately, prompt rebuilt.",
    parameters: Type.Object({
      profile: Type.Union(
        [
          Type.Literal("lean"),
          Type.Literal("research"),
          Type.Literal("debugging"),
          Type.Literal("browser"),
          Type.Literal("deep"),
        ],
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

export default function contextManagementExtension(pi: ExtensionAPI): void {
  // Register the profile-switching tool (pi is captured in closure for execute handler)
  pi.registerTool(createSetToolProfileTool(pi));
  log.info("[context-management] registered set_tool_profile tool");

  // A fresh session is born un-narrowed and keeps the profile it later asks
  // for; resume/fork/reload continue with that profile. The factory itself
  // cannot apply one: see assertProfile.
  registerSessionStartHandler(
    pi,
    SessionPhase.CoreInit,
    async (event: { reason?: string }) => {
      if (event?.reason === "startup" || event?.reason === "new") _currentProfile = null;
      assertProfile(pi, `session_start:${event?.reason ?? "unknown"}`);
      // After the profile assertion, so the discovery tool survives whatever
      // profile was applied. The tool-config restore runs in a later handler
      // and unions the tool into its own applies (it replaces the set).
      ensureDiscoveryTool(pi);
    },
    "tool-profile",
  );

  pi.on("before_agent_start", async () => {
    assertProfile(pi, "before_agent_start");
  });
}

// Exports (for testing / programmatic access)

export { PROFILES, PROFILE_NAMES, applyProfile, ensureDiscoveryTool, _currentProfile };
