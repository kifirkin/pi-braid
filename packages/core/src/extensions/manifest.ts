/**
 * Flat extension manifest - replaces src/modules/definitions.ts.
 *
 * Each extension registers itself here with its factory function and metadata.
 * There is no module grouping abstraction - just a flat list. The `module`
 * tag on each entry is a convenience label for the subagent API commands
 * (e.g. "disable enforcement") but has no structural role.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// core (input/output shaping: platform, env, prompt)
import corePolyfillFn from "./core/polyfill/index.js";

// orchestrator (multi-agent coordination)
import orchestratorFn from "./orchestrator/index.js";

// context-management (tool profile switching)
import contextManagementFn from "./context-management/index.js";
import coreAgentEnvFn from "./core/agent-environment/index.js";
import corePromptBuilderFn from "./core/prompt-builder/index.js";

// cognitive (reasoning tools + detectors: think, verify, topic-drift, MARS reflection, ...)
import metacognitionFn from "./cognitive/metacognition/index.js";
import reasoningFn from "./cognitive/reasoning/index.js";
import topicDriftFn from "./cognitive/topic-drift/index.js";
import sycophancyDetectorFn from "./cognitive/sycophancy-detector/index.js";
import turnOutcomeFn from "./cognitive/turn-outcome/index.js";
import marsReflectorFn from "./cognitive/mars-reflector/index.js";

// memory (persistent state: three stores, bridge, session recall, working memory, file state)
import memoryStoresFn from "./memory/three-memory-stores/index.js";
import memoryAgentBridgeFn from "./memory/memory-agent-bridge/index.js";
import sessionRecallFn from "./memory/session-recall/index.js";
import contextManagerFn from "./memory/context-manager/index.js";
import contextLifecycleFn from "./memory/context-lifecycle/index.js";
import scratchpadFn from "./memory/scratchpad/index.js";
import workspaceSnapshotFn from "./memory/workspace-snapshot/index.js";

// scheduling (time-based events: reminders)
import timerFn from "./scheduling/timer/index.js";

// tools (on-demand utilities)
import skillsToolFn from "./core/skills-tool/index.js";

// self (self-management: health, errors, recovery, behavior, session monitor)
import healthMaintenanceFn from "./self/health-maintenance/index.js";
import errorCaptureFn from "./self/error-tracking/index.js";
import watchdogFn from "./self/watchdog/index.js";
import autoRecoveryFn from "./self/auto-recovery/index.js";
import latentActivatorFn from "./self/latent-activator/index.js";
import pathMissFn from "./self/path-miss/index.js";

// enforcement (turn pipeline: handlers, detection, substate)
import enforcementFn from "./enforcement/index.js";

// heartbeat (proactive background services: scheduler, analytics)
import heartbeatSchedulerFn from "./heartbeat/heartbeat-scheduler/index.js";
import analyticsFn from "./heartbeat/analytics/index.js";

export interface ManifestEntry {
  /** Unique extension identifier (e.g. "enforcement", "core/metacognition"). */
  id: string;
  /** Factory function called with pi API to register tools + event handlers. */
  fn: (pi: ExtensionAPI) => Promise<void> | void;
  /** Human-readable description. */
  desc: string;
  /** Core - cannot be disabled, always loaded. */
  alwaysOn?: boolean;
  /** Opt-in - disabled by default unless explicitly enabled. */
  disabledByDefault?: boolean;
  /** Extension IDs this depends on (loaded first). */
  dependencies?: string[];
  /** Convenience module label for subagent API commands (no structural role). */
  module?: string;
}

export const MANIFEST: ManifestEntry[] = [
  {
    id: "polyfill",
    fn: corePolyfillFn,
    alwaysOn: true,
    desc: "pi API polyfills, vision model config",
  },
  {
    id: "metacognition",
    fn: metacognitionFn,
    alwaysOn: true,
    desc: "think, hypothesize, finalize, verify tools",
  },
  {
    id: "scratchpad",
    fn: scratchpadFn,
    alwaysOn: true,
    desc: "scratchpad tool",
  },
  {
    id: "prompt-builder",
    fn: corePromptBuilderFn,
    alwaysOn: true,
    desc: "System prompt assembly",
  },
  {
    id: "agent-environment",
    fn: coreAgentEnvFn,
    alwaysOn: true,
    desc: "time_status, L1 context injection",
  },
  {
    id: "workspace-snapshot",
    fn: workspaceSnapshotFn,
    alwaysOn: true,
    desc: "workspace_snapshot tool - capture/list/diff/restore file snapshots",
  },

  {
    id: "reasoning",
    fn: reasoningFn,
    desc: "Reasoning quality detector (stability analysis + verify-before-done nudge)",
  },
  {
    id: "topic-drift",
    fn: topicDriftFn,
    dependencies: ["agent-environment"],
    desc: "check/reset topic drift tools",
  },
  {
    id: "sycophancy-detector",
    fn: sycophancyDetectorFn,
    dependencies: ["agent-environment"],
    desc: "Contrast-based sycophancy detection",
  },
  {
    id: "turn-outcome",
    fn: turnOutcomeFn,
    dependencies: ["agent-environment"],
    desc: "Turn outcome loop detection",
  },
  {
    id: "mars-reflector",
    fn: marsReflectorFn,
    desc: "MARS principle + procedure reflection on task completion",
  },

  {
    id: "enforcement",
    fn: enforcementFn,
    dependencies: ["agent-environment"],
    desc: "RepE-based behavioral enforcement, turn validation",
  },

  {
    id: "three-memory-stores",
    fn: memoryStoresFn,
    dependencies: ["agent-environment"],
    desc: "Core memory infrastructure",
    module: "memory",
  },
  {
    id: "session-recall",
    fn: sessionRecallFn,
    dependencies: ["three-memory-stores"],
    desc: "Session recall tool (session)",
    module: "memory",
  },
  {
    id: "context-manager",
    fn: contextManagerFn,
    dependencies: ["three-memory-stores"],
    desc: "Context compaction/pruning tools",
    module: "memory",
  },
  {
    id: "context-lifecycle",
    fn: contextLifecycleFn,
    dependencies: ["three-memory-stores"],
    desc: "Context proposals, signal, lifecycle",
    module: "memory",
  },
  {
    id: "memory-agent-bridge",
    fn: memoryAgentBridgeFn,
    dependencies: ["three-memory-stores"],
    desc: "Agent-facing memory tools (store/recall/list/get)",
    module: "memory",
  },

  {
    id: "heartbeat-scheduler",
    fn: heartbeatSchedulerFn,
    dependencies: ["memory-agent-bridge"],
    desc: "Cognitive scheduling engine",
    module: "heartbeat",
  },
  {
    id: "analytics",
    fn: analyticsFn,
    dependencies: ["memory-agent-bridge"],
    desc: "Session metrics tools",
    module: "heartbeat",
  },

  {
    id: "timer",
    fn: timerFn,
    desc: "Timer tool",
  },
  {
    id: "skills-tool",
    fn: skillsToolFn,
    desc: "list_skills tool — on-demand skill discovery",
  },
  {
    id: "orchestrator",
    fn: orchestratorFn,
    desc: "orchestrate tool — multi-agent coordination (branch-per-worker, file-lock, conflict detection, merge verification)",
  },
  {
    id: "auto-recovery",
    fn: autoRecoveryFn,
    desc: "Auto-recovery from hangs",
  },
  {
    id: "latent-activator",
    fn: latentActivatorFn,
    desc: "Latent behavior activator",
  },
  {
    id: "path-miss",
    fn: pathMissFn,
    desc: "Path-miss steer — name the listing that answers a missing path",
  },

  // Watchdog (default-ON — liveness/stall state machine)
  // Default-ON per TG-HEARTBEAT-WATCHDOG-DESIGN.md ("default ON, NO new env
  // vars"); override via `broker.watchdog` in the one settings path that
  // config.ts reads (~/.pi/agent/settings.json, or ${PI_CODING_AGENT_DIR}/
  // settings.json when set). Not opt-in like error-tracking/health-maintenance.
  {
    id: "watchdog",
    fn: watchdogFn,
    dependencies: ["agent-environment"],
    desc: "Session monitoring + liveness/stall watchdog (default-on)",
  },

  // Health Maintenance (opt-in)
  {
    id: "health-maintenance",
    fn: healthMaintenanceFn,
    disabledByDefault: true,
    dependencies: ["agent-environment"],
    desc: "Health-based checkpointing, degradation detection, rollback",
  },

  {
    id: "context-management",
    fn: contextManagementFn,
    alwaysOn: true,
    desc: "Tool profile switching via pi.setActiveTools() — a curated active set (about a dozen tools) by default",
  },

  // Error Tracking (opt-in)
  {
    id: "error-tracking",
    fn: errorCaptureFn,
    disabledByDefault: true,
    dependencies: ["agent-environment"],
    desc: "Error logging tool (error)",
  },
];

const _byId = new Map(MANIFEST.map((e) => [e.id, e]));
const _byModule = new Map<string, ManifestEntry[]>();
for (const entry of MANIFEST) {
  const mod = entry.module ?? entry.id.split("/")[0] ?? "other";
  const list = _byModule.get(mod);
  if (list) list.push(entry);
  else _byModule.set(mod, [entry]);
}

export function getEntry(id: string): ManifestEntry | undefined {
  return _byId.get(id);
}

export function getModuleGroup(mod: string): ManifestEntry[] {
  return _byModule.get(mod) ?? [];
}

export function getModuleNames(): string[] {
  return [...new Set(MANIFEST.map((e) => e.module ?? e.id.split("/")[0] ?? "other"))];
}

export function getDefaultEnabledIds(): string[] {
  return MANIFEST.filter((e) => !e.disabledByDefault).map((e) => e.id);
}

export function getAlwaysOnIds(): string[] {
  return MANIFEST.filter((e) => e.alwaysOn).map((e) => e.id);
}
