/**
 * Module definitions for pi-braid.
 *
 * Each module groups extensions by **actual coupling** (shared events, tools,
 * state, or research paper) rather than just conceptual similarity.
 *
 * Architecture:
 *   Most extensions provide either TOOLS (agent-facing) or EVENT HANDLERS
 *   (infrastructure). The module system groups them by shared state and
 *   event coupling, not by conceptual similarity alone.
 *
 * Extension role key (from structural audit):
 *   TOOL-PROVIDER  = registers tools the agent can call
 *   EVENT-HANDLER  = listens to pi events for infrastructure
 *   COMMAND-PROVIDER = registers /commands
 *   PURE-IMPORT    = applies side-effect patches at load time
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── Extension imports ────────────────────────────────────────────────────────

// core (always on, no dependencies)
import coreAgentPatchFn from "../extensions/core/agent-patch/index.js";
import corePolyfillFn from "../extensions/core/polyfill/index.js";
import coreMetacognitionFn from "../extensions/core/metacognition/index.js";
import coreScratchpadFn from "../extensions/core/scratchpad/index.js";
import inputPolisherFn from "../extensions/core/input-polisher/index.js";
import corePromptBuilderFn from "../extensions/core/prompt-builder/index.js";
import coreAgentEnvFn from "../extensions/core/agent-environment/index.js";
import contribRateLimiterFn from "../contrib/rate-limiter/index.js";

// cognitive-quality (reasoning tools, verification, topic control, turn-outcome)
import reasoningFn from "../extensions/cognitive/reasoning/index.js";
import verificationFn from "../extensions/cognitive/verification/index.js";
import topicDriftFn from "../extensions/cognitive/topic-drift/index.js";
import sycophancyDetectorFn from "../extensions/cognitive/sycophancy-detector/index.js";
import turnOutcomeFn from "../extensions/cognitive/turn-outcome/index.js";
import toolSafetyFn from "../extensions/cognitive/tool-safety/index.js";

// enforcement (heavy event handling, split from cognitive-quality)
import enforcementFn from "../extensions/enforcement/index.js";

// memory (three-store memory + context lifecycle + agent-facing bridge)
import memoryStoresFn from "../extensions/memory/three-memory-stores/index.js";
import sessionRecallFn from "../extensions/memory/session-recall/index.js";
import contextManagerFn from "../extensions/memory/context-manager/index.js";
import contextLifecycleFn from "../extensions/memory/context-lifecycle/index.js";
import memoryAgentBridgeFn from "../extensions/memory/memory-agent-bridge/index.js";

// heartbeat (proactive cognitive scheduling)
import heartbeatSchedulerFn from "../extensions/heartbeat/heartbeat-scheduler/index.js";
import analyticsFn from "../extensions/heartbeat/analytics/index.js";

// tools (utility tools, pure tool-providers)
import timerFn from "../extensions/tools/timer/index.js";
import latentActivatorFn from "../extensions/tools/latent-activator/index.js";
import autoSingletonFn from "../extensions/tools/auto-singleton/index.js";
import autoRecoveryFn from "../extensions/tools/auto-recovery/index.js";

// contrib (out-of-scope utilities, not cognitive architecture)
import diffFn from "../contrib/diff/index.js";
import healthcheckFn from "../contrib/healthcheck/index.js";
import observatoryFn from "../contrib/observatory/index.js";
import pathSecurityFn from "../contrib/path-security/index.js";
import researchFn from "../contrib/research/index.js";
import systemMonitorFn from "../contrib/system-monitor/index.js";
import toolConfigFn from "../contrib/tool-config/index.js";
import sleepFn from "../contrib/sleep/index.js";

// nudge (feedback/nudge injection — from assistant/feedback)
import feedbackFn from "../extensions/nudge/index.js";



// watchdog (session monitoring, opt-in)
import watchdogFn from "../extensions/watchdog/index.js";

// health-maintenance (degradation detection + checkpointing, opt-in)
import healthMaintenanceFn from "../extensions/health-maintenance/index.js";

// error-tracking (error logging tools, opt-in, new from retry/error-capture)
import errorCaptureFn from "../extensions/error-tracking/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SubExtension {
  name: string;
  fn: (pi: ExtensionAPI) => Promise<void> | void;
}

export interface ModuleDef {
  /** Unique identifier (used in config, env var, and subagent API) */
  name: string;
  /** Human-readable label */
  label: string;
  /** Short description */
  description: string;
  /** Research paper reference (if any) */
  paper?: string;
  /** Core modules that cannot be disabled */
  alwaysOn?: boolean;
  /** Disabled by default (opt-in only) */
  disabledByDefault?: boolean;
  /** Module names this depends on (loaded first) */
  dependencies?: string[];
  /** Sub-extensions belonging to this module */
  extensions: SubExtension[];
  /** Key events this module listens to (for coupling documentation) */
  listensTo?: string[];
  /** Extensions outside this module that share events or state (documentation) */
  coupledWith?: { module: string; via: string }[];
}

// ──── Module Definitions (grouped by actual coupling) ──────────────────────

export const MODULE_DEFINITIONS: ModuleDef[] = [
  // ═════════════════════════════════════════════════════════════════════
  // CORE — Foundation layer (always on, no dependencies)
  //   agent-patch:    PURE-IMPORT — monkey-patches pi's handleRunFailure
  //   polyfill:       EVENT-HANDLER + COMMAND — pi API polyfills, vision model config
  //   metacognition:  TOOL-PROVIDER — think, hypothesize, finalize, verify
  //   scratchpad:     TOOL-PROVIDER — scratchpad tool
  //   input-polisher:   EVENT-HANDLER — input proofreading & translation
  //   prompt-builder: EVENT-HANDLER — system prompt assembly (moved from prompt/)
  //   agent-environment: TOOL-PROVIDER — time_status, L1 context injection
  // ═════════════════════════════════════════════════════════════════════
  {
    name: "core",
    label: "Core",
    description: "Foundation: polyfill, metacognition, scratchpad, input-polisher, prompt-builder, agent-environment",
    alwaysOn: true,
    extensions: [
      { name: "agent-patch", fn: coreAgentPatchFn },
      { name: "polyfill", fn: corePolyfillFn },
      { name: "metacognition", fn: coreMetacognitionFn },
      { name: "scratchpad", fn: coreScratchpadFn },
      { name: "input-polisher", fn: inputPolisherFn },
      { name: "prompt-builder", fn: corePromptBuilderFn },
      { name: "agent-environment", fn: coreAgentEnvFn },
    ],
    listensTo: [
      "session_start", "before_agent_start", "agent_end", "input",
      "message_end", "turn_end", "session_shutdown", "context",
    ],
    coupledWith: [
      { module: "enforcement", via: "input event" },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════
  // COGNITIVE-QUALITY — Reasoning quality tools
  //   All are TOOL-PROVIDER (no event listeners except sycophancy-detector).
  //   reasoning:      2 events — think tool cadence tracking
  //   verification:   0 events — verify_claim, verify_decomposition tools
  //   topic-drift:    0 events — check/reset topic drift tools
  //   sycophancy-detector: 1 event — message_end, contrast-based detection
  // Paper: RepE Contrast / Silicon Mirror (2604.19117)
  // ═════════════════════════════════════════════════════════════════════
  {
    name: "cognitive-quality",
    label: "Cognitive Quality",
    description: "Structured reasoning, verification, topic-drift, sycophancy detection, turn-outcome loop detection",
    paper: "RepE Contrast / Silicon Mirror (2604.19117)",
    dependencies: ["core"],
    extensions: [
      { name: "reasoning", fn: reasoningFn },
      { name: "verification", fn: verificationFn },
      { name: "topic-drift", fn: topicDriftFn },
      { name: "sycophancy-detector", fn: sycophancyDetectorFn },
      { name: "turn-outcome", fn: turnOutcomeFn },
      { name: "tool-safety", fn: toolSafetyFn },
    ],
    listensTo: [
      "before_agent_start", "message_end", "turn_end", "tool_call",
    ],
    coupledWith: [
      { module: "enforcement", via: "message_end" },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════
  // ENFORCEMENT — RepE contrast enforcement (split from cognitive-quality)
  //   EVENT-HANDLER — heavy: 10+ event listeners across session lifecycle.
  //   Registered separately so it can be disabled without losing other tools.
  //   This is the most event-coupled module in the system.
  // Paper: Representation Engineering (RepE)
  // ═════════════════════════════════════════════════════════════════════
  {
    name: "enforcement",
    label: "Behavioral Enforcement",
    description: "RepE-based behavioral enforcement, turn validation, contrast detection",
    paper: "Representation Engineering (RepE)",
    dependencies: ["core"],
    extensions: [
      { name: "enforcement", fn: enforcementFn },
    ],
    listensTo: [
      "session_start", "session_shutdown", "input", "agent_end",
      "message_end", "tool_call", "tool_result", "turn_end",
      "session_compact", "auto_retry_end",
    ],
    coupledWith: [
      { module: "cognitive-quality", via: "message_end" },
      { module: "memory", via: "tool_end, turn_end" },
      { module: "heartbeat", via: "turn_end" },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════
  // MEMORY — Three-store memory + session recall + context lifecycle
  //   three-memory-stores: EVENT-HANDLER + TOOL — core memory infrastructure
  //   session-recall:     TOOL-PROVIDER — session_search, session_query
  //   context-lifecycle:  TOOL-PROVIDER + EVENT — proposals, signal
  //   context-manager:    TOOL-PROVIDER — compaction/pruning tools
  //   memory-agent-bridge: TOOL-PROVIDER — agent-facing memory tools
  //     (memory_store/recall/list/get, explore_paths, conflict_qa)
  //     Renamed from cognitive-systems, moved from cognitive module.
  // Paper: 2604.14475 (Three Memory Stores)
  // ═════════════════════════════════════════════════════════════════════
  {
    name: "memory",
    label: "Memory Stores",
    description: "Three memory stores, session recall, context compaction + lifecycle, agent-facing memory tools",
    paper: "Three Memory Stores (2604.14475)",
    dependencies: ["core"],
    extensions: [
      { name: "three-memory-stores", fn: memoryStoresFn },
      { name: "session-recall", fn: sessionRecallFn },
      { name: "context-manager", fn: contextManagerFn },
      { name: "context-lifecycle", fn: contextLifecycleFn },
      { name: "memory-agent-bridge", fn: memoryAgentBridgeFn },
    ],
    listensTo: [
      "session_start", "session_shutdown", "agent_end", "tool_result",
      "turn_end", "model_select", "before_agent_start", "tool_call",
    ],
    coupledWith: [
      { module: "enforcement", via: "turn_end, tool_end" },
      { module: "heartbeat", via: "session_shutdown" },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════
  // HEARTBEAT — Proactive cognitive scheduling
  //   heartbeat-scheduler: EVENT-HANDLER — cognitive scheduling engine
  //   analytics:          TOOL-PROVIDER + EVENT — session metrics tools
  // Paper: 2604.14178 (Cognitive Heartbeat)
  // ═════════════════════════════════════════════════════════════════════
  {
    name: "heartbeat",
    label: "Cognitive Scheduler (Heartbeat)",
    description: "Proactive cognitive scheduling with policy engine + analytics",
    paper: "Cognitive Heartbeat (2604.14178)",
    dependencies: ["core", "memory"],
    extensions: [
      { name: "heartbeat-scheduler", fn: heartbeatSchedulerFn },
      { name: "analytics", fn: analyticsFn },
    ],
    listensTo: [
      "session_start", "session_shutdown", "agent_end", "turn_end",
      "tool_call", "tool_execution_start", "tool_execution_end",
    ],
    coupledWith: [
      { module: "enforcement", via: "turn_end" },
      { module: "memory", via: "session_shutdown" },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════
  // TOOLS — Workspace utility tools (pure TOOL-PROVIDERs)
  //   All tools are self-contained with no shared state or event coupling.
  // ═════════════════════════════════════════════════════════════════════
  {
    name: "tools",
    label: "Utility Tools",
    description: "Timer, auto-singleton watchdog, auto-recovery, latent-activator",
    dependencies: ["core"],
    extensions: [
      { name: "timer", fn: timerFn },
      { name: "auto-singleton", fn: autoSingletonFn },
      { name: "auto-recovery", fn: autoRecoveryFn },
      { name: "latent-activator", fn: latentActivatorFn },
    ],
    listensTo: ["turn_end", "tool_call", "tool_result", "turn_start", "session_start", "session_shutdown"],
    coupledWith: [],
  },

  // ═════════════════════════════════════════════════════════════════════
  // NUDGE — Feedback/nudge injection (from assistant/feedback)
  //   EVENT-HANDLER — 7 event listeners. Injects behavioral nudges
  //   and feedback via the whisper pattern (before_agent_start).
  //   Renamed from "assistant/feedback" for clarity.
  // ═════════════════════════════════════════════════════════════════════
  {
    name: "nudge",
    label: "Nudge & Feedback",
    description: "Behavioral nudge injection, feedback whispers, turn-quality monitoring",
    dependencies: ["core"],
    extensions: [
      { name: "feedback", fn: feedbackFn },
    ],
    listensTo: [
      "session_start", "session_shutdown", "turn_start",
      "message_end", "tool_call", "turn_end", "before_agent_start",
    ],
    coupledWith: [{ module: "cognitive-quality", via: "message_end, tool_call" }],
  },

  // ═════════════════════════════════════════════════════════════════════
  // CONTRIB — Out-of-scope utilities (not cognitive architecture)
  //   These are single-tool/command extensions that could be extracted
  //   as standalone pi packages. Kept here for convenience but physically
  //   separated under src/contrib/ to signal they're not core braid.
  // ═════════════════════════════════════════════════════════════════════
  {
    name: "contrib",
    label: "Contrib Utilities",
    description: "Peripheral utilities: diff, healthcheck, observatory, research, system-monitor, rate-limiter, tool-config",
    dependencies: ["core"],
    extensions: [
      { name: "diff", fn: diffFn },
      { name: "healthcheck", fn: healthcheckFn },
      { name: "observatory", fn: observatoryFn },
      { name: "path-security", fn: pathSecurityFn },
      { name: "research", fn: researchFn },
      { name: "system-monitor", fn: systemMonitorFn },
      { name: "rate-limiter", fn: contribRateLimiterFn },
      { name: "tool-config", fn: toolConfigFn },
      // { name: "sleep", fn: sleepFn },
    ],
    listensTo: ["session_tree", "session_shutdown", "context"],
    coupledWith: [],
  },

  // ═════════════════════════════════════════════════════════════════════
  // WATCHDOG — Error monitoring (opt-in, verbose)
  //   EVENT-HANDLER — session_start, agent_end, message_end
  // ═════════════════════════════════════════════════════════════════════
  {
    name: "watchdog",
    label: "Watchdog",
    description: "Session monitoring and error alerting",
    disabledByDefault: true,
    dependencies: ["core"],
    extensions: [{ name: "watchdog", fn: watchdogFn }],
    listensTo: ["session_start", "agent_end", "message_end"],
    coupledWith: [],
  },

  // ═════════════════════════════════════════════════════════════════════
  // HEALTH-MAINTENANCE — Degradation recovery (opt-in)
  //   Renamed from "evolve" for clarity. Health-based checkpointing,
  //   degradation detection, and rollback.
  // ═════════════════════════════════════════════════════════════════════
  {
    name: "health-maintenance",
    label: "Health Maintenance",
    description: "Health-based checkpointing, degradation detection, rollback",
    disabledByDefault: true,
    dependencies: ["core"],
    extensions: [{ name: "health-maintenance", fn: healthMaintenanceFn }],
    listensTo: ["session_shutdown"],
    coupledWith: [],
  },

  // ═════════════════════════════════════════════════════════════════════
  // ERROR-TRACKING — Error logging tools (opt-in)
  //   TOOL-PROVIDER — error_list, error_get, error_clear, error_stats.
  //   Promoted from retry/error-capture to its own module.
  // ═════════════════════════════════════════════════════════════════════
  {
    name: "error-tracking",
    label: "Error Tracking",
    description: "Error logging tools: error_list, error_get, error_clear, error_stats",
    disabledByDefault: true,
    dependencies: ["core"],
    extensions: [{ name: "error-capture", fn: errorCaptureFn }],
    listensTo: ["turn_end"],
    coupledWith: [],
  },
];

// ── Lookup helpers ──────────────────────────────────────────────────────────

const _byName = new Map(MODULE_DEFINITIONS.map((m) => [m.name, m]));

export function getModuleDef(name: string): ModuleDef | undefined {
  return _byName.get(name);
}

export function getAllModuleNames(): string[] {
  return MODULE_DEFINITIONS.map((m) => m.name);
}

export function getDefaultEnabledModules(): string[] {
  return MODULE_DEFINITIONS.filter((m) => !m.disabledByDefault).map((m) => m.name);
}
