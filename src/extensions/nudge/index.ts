import { createLogger } from "../../lib/logger.js";
import { sendTrackedMessage } from "../../lib/injection-tracker.js";
import { registerSessionStartHandler, SessionPhase } from "../../lib/session-start-queue.js";
import { areCognitiveNudgesDisabled } from "../../lib/braid-settings.js";

const log = createLogger("feedback");

/**
 * Feedback & Tuning Extension - Phase 4
 *
 * Uses the whisper pattern (before_agent_start event) to inject
 * feedback and nudges as visible messages with purple background.
 *
 * Integrates all enforcement framework components:
 * 1. Smart nudge generator - Context-aware, rate-limited nudges
 * 2. A/B testing framework - Test different enforcement rules
 * 3. Per-model preferences - Model-specific configurations
 * 4. Integration hub - Connects analytics, enforcement, adaptive
 */

import { FEEDBACK_DIR, METRICS_FILE } from "../../lib/braid-paths.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { getExtensionState } from "../../lib/extension-state.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface Nudge {
  id: string;
  timestamp: number;
  type: NudgeType;
  severity: "info" | "warning" | "critical";
  message: string;
  triggeredBy: string;
  action?: string;
  acknowledged: boolean;
}

type NudgeType =
  | "silent_turn"
  | "tool_ineffective"
  | "scratchpad_missing"
  | "hallucination_detected"
  | "phase_mismatch"
  | "success_tip"
  | "think_tool_missing";

interface ABTest {
  id: string;
  name: string;
  variantA: Record<string, unknown>;
  variantB: Record<string, unknown>;
  active: boolean;
  results: {
    variantA: { impressions: number; success: number };
    variantB: { impressions: number; success: number };
  };
}

interface ModelPreferences {
  modelId: string;
  preferences: {
    requireReasoning: boolean;
    requirePlan: boolean;
    enforceScratchpad: boolean;
    maxSilentTurns: number;
    nudgeFrequency: "low" | "medium" | "high";
    preferredTools: string[];
    avoidTools: string[];
  };
}

interface FeedbackConfig {
  nudgeCooldownMs: number;
  maxNudgesPerTurn: number;
  enableABTesting: boolean;
  enableModelPreferences: boolean;
  smartNudgeThreshold: number;
  thinkToolEnforcementTurns: number;
}

// ── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: FeedbackConfig = {
  nudgeCooldownMs: 3000,
  maxNudgesPerTurn: 2,
  enableABTesting: false,
  enableModelPreferences: true,
  smartNudgeThreshold: 0.6,
  thinkToolEnforcementTurns: 5,
};

const STORAGE_DIR = FEEDBACK_DIR;
const NUDGE_HISTORY_FILE = join(STORAGE_DIR, "nudge-history.jsonl");
const AB_TESTS_FILE = join(STORAGE_DIR, "ab-tests.json");
const MODEL_PREFS_FILE = join(STORAGE_DIR, "model-preferences.json");
const CONFIG_FILE = join(STORAGE_DIR, "config.json");

// ── Session-scoped State ───────────────────────────────────────────────────

interface FeedbackState {
  config: FeedbackConfig;
  nudgeHistory: Nudge[];
  activeNudges: Nudge[];
  abTests: ABTest[];
  modelPreferences: Record<string, ModelPreferences["preferences"]>;
  lastNudgeTime: number;
  nudgeCountThisTurn: number;
  currentTurn: number;
  analyticsPath: string;
  lastThinkToolTurn: number;
  thinkToolNudgeActive: boolean;
}

function createFeedbackState(): FeedbackState {
  return {
    config: loadConfig(),
    nudgeHistory: [],
    activeNudges: [],
    abTests: loadABTests(),
    modelPreferences: loadModelPreferences(),
    lastNudgeTime: 0,
    nudgeCountThisTurn: 0,
    currentTurn: 0,
    analyticsPath: METRICS_FILE,
    lastThinkToolTurn: -1,
    thinkToolNudgeActive: false,
  };
}

function getFeedbackState(ctx: ExtensionContext): FeedbackState {
  return getExtensionState(ctx, "feedback", createFeedbackState);
}

// ── Persistence ────────────────────────────────────────────────────────────

function ensureStorageDir(): void {
  if (!existsSync(STORAGE_DIR)) {
    mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function loadConfig(): FeedbackConfig {
  ensureStorageDir();
  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function loadABTests(): ABTest[] {
  ensureStorageDir();
  if (!existsSync(AB_TESTS_FILE)) {
    return getDefaultABTests();
  }
  try {
    return JSON.parse(readFileSync(AB_TESTS_FILE, "utf-8"));
  } catch {
    return getDefaultABTests();
  }
}

function getDefaultABTests(): ABTest[] {
  return [
    {
      id: "nudge-frequency",
      name: "Nudge Frequency Test",
      variantA: { nudgeCooldownMs: 5000, maxNudgesPerTurn: 1 },
      variantB: { nudgeCooldownMs: 2000, maxNudgesPerTurn: 3 },
      active: false,
      results: {
        variantA: { impressions: 0, success: 0 },
        variantB: { impressions: 0, success: 0 },
      },
    },
    {
      id: "reasoning-required",
      name: "Require Reasoning Block Test",
      variantA: { requireReasoning: false },
      variantB: { requireReasoning: true },
      active: false,
      results: {
        variantA: { impressions: 0, success: 0 },
        variantB: { impressions: 0, success: 0 },
      },
    },
  ];
}

function saveABTests(s: FeedbackState): void {
  ensureStorageDir();
  writeFileSync(AB_TESTS_FILE, JSON.stringify(s.abTests, null, 2));
}

function loadModelPreferences(): Record<string, ModelPreferences["preferences"]> {
  ensureStorageDir();
  if (!existsSync(MODEL_PREFS_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(MODEL_PREFS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function sendFeedbackWhisper(pi: ExtensionAPI, message: string): void {
  // Cognitive nudge suppression — separate from confirm dialogs
  if (areCognitiveNudgesDisabled()) {
    log.debug("[feedback] Nudge suppressed via braid.suppressNudges=true");
    return;
  }

  sendTrackedMessage(
    pi,
    {
      customType: "feedback",
      content: [{ type: "text", text: `[feedback] ${message}` }],
      display: true,
    },
    { deliverAs: "steer", triggerTurn: false },
    { type: "other", source: "feedback/whisper" },
  );
}

// ── Smart Nudge Generator ──────────────────────────────────────────────────

function generateNudge(
  type: NudgeType,
  context: Record<string, unknown>,
): { message: string; severity: "info" | "warning" | "critical"; action?: string } {
  switch (type) {
    case "think_tool_missing": {
      const turnsSince = context.turnsSince as number;
      return {
        severity: "info",
        message: `Consider using think() tool to record structured reasoning.\n\n${turnsSince} turn(s) since think() was called. Use think() to track:\n- Observation: what you discovered\n- Decision: what you decided\n- Reason: why you made that choice`,
        action: "Call think() tool to record your reasoning.",
      };
    }

    case "silent_turn": {
      const silentCount = context.silentTurns as number;
      return {
        severity: "critical",
        message: `You have ${silentCount} turn(s) without calling any tools. You work through tools - reach for: read, grep, find, bash, edit, write, think, scratchpad.\n\nYou don't describe what you would do - you do it with tools.`,
        action: "Call at least one tool in your next response.",
      };
    }

    case "tool_ineffective": {
      const ineffectiveTool = context.toolName as string;
      const tip = context.tip as string;
      return {
        severity: "info",
        message: `Note: ${ineffectiveTool} has low effectiveness. ${tip || "Consider using a different approach."}`,
      };
    }

    case "scratchpad_missing":
      return {
        severity: "warning",
        message:
          "You made file changes (edit/write) without updating scratchpad.\n\nUse the scratchpad tool to track:\n- Current goal\n- Decisions made\n- Next steps\n\nThis helps maintain context in long sessions.",
        action: "Call scratchpad tool to update your tracking.",
      };

    case "hallucination_detected":
      return {
        severity: "critical",
        message:
          "HALLUCINATION DETECTED: You claimed work is complete without actually doing it.\n\nYou verify your work:\n1. Run the actual tests\n2. Verify files were created/modified\n3. You don't claim success without evidence\n\nYour claim has been noted. Provide actual verification.",
        action: "Run verification commands and show the actual results.",
      };

    case "phase_mismatch": {
      const expected = (context.expected as string[]) || [];
      const received = context.received as string;
      return {
        severity: "info",
        message: `Unusual tool for current phase: ${received}\nExpected tools: ${expected.join(", ") || "any"}\n\nThis is informational only. Continue if intentional.`,
      };
    }

    case "success_tip": {
      const tipTool = context.tool as string;
      const successRate = context.successRate as number;
      return {
        severity: "info",
        message: `Tip: ${tipTool} has ${((successRate as number) * 100).toFixed(0)}% success rate in similar tasks.\n\nConsider using it if appropriate.`,
      };
    }

    default:
      return {
        severity: "info",
        message: (context.message as string) || "General feedback",
      };
  }
}

function shouldSendNudge(s: FeedbackState, nudge: Nudge): boolean {
  const now = Date.now();

  if (now - s.lastNudgeTime < s.config.nudgeCooldownMs) {
    return false;
  }

  if (s.nudgeCountThisTurn >= s.config.maxNudgesPerTurn) {
    return false;
  }

  const recentTypes = s.nudgeHistory.slice(-5).map((n) => n.type);
  if (recentTypes.includes(nudge.type)) {
    if (nudge.severity !== "critical") {
      return false;
    }
  }

  return true;
}

function recordNudge(s: FeedbackState, nudge: Nudge): void {
  s.nudgeHistory.push(nudge);
  s.activeNudges.push(nudge);

  if (s.nudgeHistory.length > 500) {
    s.nudgeHistory = s.nudgeHistory.slice(-500);
  }

  ensureStorageDir();
  writeFileSync(NUDGE_HISTORY_FILE, `${JSON.stringify(nudge)}\n`, { flag: "a" });

  s.lastNudgeTime = Date.now();
  s.nudgeCountThisTurn++;
}

// ── A/B Testing ────────────────────────────────────────────────────────────

function getABTestConfig(s: FeedbackState): Record<string, unknown> {
  const activeTests = s.abTests.filter((t) => t.active);
  if (activeTests.length === 0) {
    return {};
  }

  const turnMod = s.currentTurn % 2;
  const variant = turnMod === 0 ? "variantA" : "variantB";

  for (const test of activeTests) {
    const result = test.results[variant as "variantA" | "variantB"];
    result.impressions++;
    saveABTests(s);
  }

  return Object.assign(
    {},
    ...activeTests.map((t) => t[variant === "variantA" ? "variantA" : "variantB"]),
  );
}

// ── Extension Factory ──────────────────────────────────────────────────────

export default function feedbackExtension(pi: ExtensionAPI) {
  // Initialize state on start
  registerSessionStartHandler(pi, SessionPhase.Background, async (_event, ctx) => {
    const state = getFeedbackState(ctx);
    state.nudgeCountThisTurn = 0;
  });

  // Reset turn counter at turn start
  pi.on("turn_start", async (_event, ctx) => {
    try {
      const state = getFeedbackState(ctx);
      state.currentTurn++;
      state.nudgeCountThisTurn = 0;

      if (state.config.enableABTesting) {
        const abConfig = getABTestConfig(state);
        if (abConfig.nudgeCooldownMs) {
          state.config.nudgeCooldownMs = abConfig.nudgeCooldownMs as number;
        }
        if (abConfig.maxNudgesPerTurn) {
          state.config.maxNudgesPerTurn = abConfig.maxNudgesPerTurn as number;
        }
      }
    } catch (err) {
      log.error("[feedback-turn-start] error:", err);
    }
  });

  // Monitor for issues and generate nudges
  pi.on("message_end", async (event, ctx) => {
    try {
      if (event.message.role !== "assistant") {
        return;
      }

      const state = getFeedbackState(ctx);
      const issues: { type: NudgeType; context: Record<string, unknown> }[] = [];

      for (const issue of issues) {
        const nudgeDef = generateNudge(issue.type, issue.context);
        const nudge: Nudge = {
          id: `${issue.type}-${Date.now()}`,
          timestamp: Date.now(),
          type: issue.type,
          severity: nudgeDef.severity,
          message: nudgeDef.message,
          triggeredBy: "message_end",
          action: nudgeDef.action,
          acknowledged: false,
        };

        if (shouldSendNudge(state, nudge)) {
          recordNudge(state, nudge);
          sendFeedbackWhisper(pi, nudgeDef.message);
        }
      }
    } catch (err) {
      log.error("[feedback-msg-end] error:", err);
    }
  });

  // Track tool usage for sequence repetition detection
  pi.on("tool_call", async (event, ctx) => {
    try {
      const toolName = event.toolName;
      const state = getFeedbackState(ctx);

      if (
        [
          "feedback",
          "enforcement_status",
          "scratchpad",
          "memory_recall",
          "memory_store",
          "context_prune",
          "context_audit",
          "get-tool-addiction",
        ].includes(toolName)
      ) {
        return;
      }

      if (toolName === "think") {
        state.lastThinkToolTurn = state.currentTurn;
        state.thinkToolNudgeActive = false;
      }
    } catch (err) {
      log.error("[feedback-tool-call] error:", err);
    }
  });

  // Track scratchpad usage and enforce think tool cadence
  pi.on("turn_end", async (event, ctx) => {
    try {
      const state = getFeedbackState(ctx);
      const tools = (event.toolResults || []).map((r) => r.toolName);

      const madeFileChanges = tools.some((t) => ["edit", "write"].includes(t));
      const isComplexTurn = tools.length >= 3;
      const usedScratchpad = tools.includes("scratchpad");

      // Widen: fire on file changes OR complex turns without scratchpad
      if ((madeFileChanges || isComplexTurn) && !usedScratchpad) {
        const reason = madeFileChanges
          ? "You made file changes (edit/write) without updating scratchpad."
          : `Complex turn (${tools.length} tools) without scratchpad tracking.`;
        const message =
          `${reason}\n\nUse the scratchpad tool to track:\n` +
          `- Current goal\n- Decisions made\n- Next steps\n\nThis helps maintain context in long sessions.`;
        const nudgeDef = {
          severity: "warning" as const,
          message,
          action: "Call scratchpad tool to update your tracking.",
        };
        const nudge: Nudge = {
          id: `scratchpad-${Date.now()}`,
          timestamp: Date.now(),
          type: "scratchpad_missing",
          severity: nudgeDef.severity,
          message: nudgeDef.message,
          triggeredBy: "turn_end",
          action: nudgeDef.action,
          acknowledged: false,
        };

        if (shouldSendNudge(state, nudge)) {
          recordNudge(state, nudge);
          sendFeedbackWhisper(pi, nudgeDef.message);
        }
      }

      const turnsSinceThink = state.currentTurn - state.lastThinkToolTurn;
      const madeHighStakesAction = tools.some((t: string) =>
        ["edit", "write", "finalize"].includes(t),
      );
      const noThinkEver = state.lastThinkToolTurn < 0;

      // Widen: fire on (a) turn-count threshold OR (b) high-stakes action without prior think
      const thinkNeeded =
        (state.config.thinkToolEnforcementTurns > 0 &&
          turnsSinceThink >= state.config.thinkToolEnforcementTurns) ||
        (madeHighStakesAction && noThinkEver && state.currentTurn >= 3);

      if (thinkNeeded && !state.thinkToolNudgeActive) {
        state.thinkToolNudgeActive = true;
        const message =
          madeHighStakesAction && noThinkEver
            ? `High-stakes action without prior think(). Use think() to track:\n- Observation: what you discovered\n- Decision: what you decided\n- Reason: why you made that choice`
            : `Consider using think() tool to record structured reasoning.\n\n${turnsSinceThink} turn(s) since think() was called. Use think() to track:\n- Observation: what you discovered\n- Decision: what you decided\n- Reason: why you made that choice`;
        const nudge: Nudge = {
          id: `think-${Date.now()}`,
          timestamp: Date.now(),
          type: "think_tool_missing",
          severity: "info",
          message,
          triggeredBy: "turn_end",
          action: "Call think() tool to record your reasoning.",
          acknowledged: false,
        };

        if (shouldSendNudge(state, nudge)) {
          recordNudge(state, nudge);
          sendFeedbackWhisper(pi, message);
        }
      }
    } catch (err) {
      log.error("[feedback-turn-end] error:", err);
    }
  });

  // Before Agent Start: No-op (whispers are now sent immediately)
  pi.on("before_agent_start", async (_event) => {
    return undefined;
  });
}
