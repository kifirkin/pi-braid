/**
 * Flat extension manifest — replaces src/modules/definitions.ts.
 *
 * Each extension registers itself here with its factory function and metadata.
 * There is no module grouping abstraction — just a flat list. The `module`
 * tag on each entry is a convenience label for the subagent API commands
 * (e.g. "disable enforcement") but has no structural role.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Extension imports ────────────────────────────────────────────────────────

// core (always on, no dependencies)
import corePolyfillFn from "./core/polyfill/index.js";
import coreMetacognitionFn from "./core/metacognition/index.js";
import coreScratchpadFn from "./core/scratchpad/index.js";
import inputPolisherFn from "./core/input-polisher/index.js";
import corePromptBuilderFn from "./core/prompt-builder/index.js";
import coreAgentEnvFn from "./core/agent-environment/index.js";
import coreWorkspaceSnapshotFn from "./core/workspace-snapshot/index.js";

// cognitive-quality (reasoning tools, verification, topic control, turn-outcome)
import reasoningFn from "./cognitive/reasoning/index.js";
import verificationFn from "./cognitive/verification/index.js";
import topicDriftFn from "./cognitive/topic-drift/index.js";
import sycophancyDetectorFn from "./cognitive/sycophancy-detector/index.js";
import turnOutcomeFn from "./cognitive/turn-outcome/index.js";
import toolSafetyFn from "./cognitive/tool-safety/index.js";

// enforcement (heavy event handling, split from cognitive-quality)
import enforcementFn from "./enforcement/index.js";

// memory (three-store memory + context lifecycle + agent-facing bridge)
import memoryStoresFn from "./memory/three-memory-stores/index.js";
import sessionRecallFn from "./memory/session-recall/index.js";
import contextManagerFn from "./memory/context-manager/index.js";
import contextLifecycleFn from "./memory/context-lifecycle/index.js";
import memoryAgentBridgeFn from "./memory/memory-agent-bridge/index.js";

// heartbeat (proactive cognitive scheduling)
import heartbeatSchedulerFn from "./heartbeat/heartbeat-scheduler/index.js";
import analyticsFn from "./heartbeat/analytics/index.js";

// tools (utility tools, pure tool-providers)
import timerFn from "./tools/timer/index.js";
import latentActivatorFn from "./tools/latent-activator/index.js";
import autoSingletonFn from "./tools/auto-singleton/index.js";
import autoRecoveryFn from "./tools/auto-recovery/index.js";

// watchdog (session monitoring, opt-in)
import watchdogFn from "./watchdog/index.js";

// health-maintenance (degradation detection + checkpointing, opt-in)
import healthMaintenanceFn from "./health-maintenance/index.js";

// error-tracking (error logging tools, opt-in)
import errorCaptureFn from "./error-tracking/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ManifestEntry {
  /** Unique extension identifier (e.g. "enforcement", "core/metacognition"). */
  id: string;
  /** Factory function called with pi API to register tools + event handlers. */
  fn: (pi: ExtensionAPI) => Promise<void> | void;
  /** Human-readable description. */
  desc: string;
  /** Core — cannot be disabled, always loaded. */
  alwaysOn?: boolean;
  /** Opt-in — disabled by default unless explicitly enabled. */
  disabledByDefault?: boolean;
  /** Extension IDs this depends on (loaded first). */
  dependencies?: string[];
  /** Convenience module label for subagent API commands (no structural role). */
  module?: string;
}

// ── Manifest ─────────────────────────────────────────────────────────────────

export const MANIFEST: ManifestEntry[] = [
  // ── Core ──────────────────────────────────────────────────────────────
  {
    id: "polyfill",
    fn: corePolyfillFn,
    alwaysOn: true,
    desc: "pi API polyfills, vision model config",
  },
  {
    id: "metacognition",
    fn: coreMetacognitionFn,
    alwaysOn: true,
    desc: "think, hypothesize, finalize, verify tools",
  },
  {
    id: "scratchpad",
    fn: coreScratchpadFn,
    alwaysOn: true,
    desc: "scratchpad tool",
  },
  {
    id: "input-polisher",
    fn: inputPolisherFn,
    alwaysOn: true,
    desc: "Input proofreading & translation",
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
    fn: coreWorkspaceSnapshotFn,
    alwaysOn: true,
    desc: "workspace_snapshot tool — capture/list/diff/restore file snapshots",
  },

  // ── Cognitive Quality ─────────────────────────────────────────────────
  {
    id: "reasoning",
    fn: reasoningFn,
    dependencies: ["agent-environment"],
    desc: "Structured reasoning tools",
  },
  {
    id: "verification",
    fn: verificationFn,
    dependencies: ["agent-environment"],
    desc: "verify_claim, verify_decomposition tools",
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
    id: "tool-safety",
    fn: toolSafetyFn,
    dependencies: ["agent-environment"],
    desc: "Tool safety checks",
  },

  // ── Enforcement ───────────────────────────────────────────────────────
  {
    id: "enforcement",
    fn: enforcementFn,
    dependencies: ["agent-environment"],
    desc: "RepE-based behavioral enforcement, turn validation",
  },

  // ── Memory ────────────────────────────────────────────────────────────
  {
    id: "three-memory-stores",
    fn: memoryStoresFn,
    dependencies: ["agent-environment"],
    desc: "Core memory infrastructure",
  },
  {
    id: "session-recall",
    fn: sessionRecallFn,
    dependencies: ["three-memory-stores"],
    desc: "Session recall tools (session_search, session_query)",
  },
  {
    id: "context-manager",
    fn: contextManagerFn,
    dependencies: ["three-memory-stores"],
    desc: "Context compaction/pruning tools",
  },
  {
    id: "context-lifecycle",
    fn: contextLifecycleFn,
    dependencies: ["three-memory-stores"],
    desc: "Context proposals, signal, lifecycle",
  },
  {
    id: "memory-agent-bridge",
    fn: memoryAgentBridgeFn,
    dependencies: ["three-memory-stores"],
    desc: "Agent-facing memory tools (store/recall/list/get)",
  },

  // ── Heartbeat ─────────────────────────────────────────────────────────
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

  // ── Tools ─────────────────────────────────────────────────────────────
  {
    id: "timer",
    fn: timerFn,
    desc: "Timer tool",
  },
  {
    id: "auto-singleton",
    fn: autoSingletonFn,
    desc: "Auto-singleton watchdog",
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

  // ── Watchdog (opt-in) ────────────────────────────────────────────────
  {
    id: "watchdog",
    fn: watchdogFn,
    disabledByDefault: true,
    dependencies: ["agent-environment"],
    desc: "Session monitoring and error alerting",
  },

  // ── Health Maintenance (opt-in) ───────────────────────────────────────
  {
    id: "health-maintenance",
    fn: healthMaintenanceFn,
    disabledByDefault: true,
    dependencies: ["agent-environment"],
    desc: "Health-based checkpointing, degradation detection, rollback",
  },

  // ── Error Tracking (opt-in) ──────────────────────────────────────────
  {
    id: "error-tracking",
    fn: errorCaptureFn,
    disabledByDefault: true,
    dependencies: ["agent-environment"],
    desc: "Error logging tools: error_list, error_get",
  },
];

// ── Lookup helpers ──────────────────────────────────────────────────────────

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
