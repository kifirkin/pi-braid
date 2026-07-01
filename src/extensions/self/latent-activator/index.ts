import { createLogger } from "../../../lib/core/logger.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";

const log = createLogger("latent-activator");
/**
 * Latent Activation Framework
 *
 * Dynamic implicit identity/persona system that activates latent capabilities.
 * Based on research:
 * - HER (2601.21459): Dual-layer thinking - first-person vs third-person
 * - HumanLLM (2601.10198): Psychological patterns as causal forces
 * - DPRF (2510.14205): Dynamic persona refinement
 *
 * Key insight: Models have INERTIA - persistent biases. Framework works WITH biases.
 *
 * Safety bounds on the `behavior` tool:
 * - **Session reset:** every new session starts with `["planner", "executor"]` -
 *   behaviors never leak across sessions.
 * - **Active cap:** max 5 behaviors active at once. Activation beyond the cap is
 *   refused with a clear error; the agent must deactivate first (or use
 *   `action="deactivate_all"` to clear all and start fresh).
 * - **Idempotent `mix`:** `action="mix"` clears existing behaviors first, so a
 *   scenario combo is a known good state regardless of prior activations.
 * - **No auto-activation:** the latent-activation inference path is disabled
 *   (see comment above the tool). The agent must explicitly call the tool.
 *
 * Design principles:
 * 1. IMPLICIT > EXPLICIT - subtle cues > direct commands
 * 2. ACTIVATION > INSTRUCTION - trigger capabilities vs tell what to do
 * 3. DUAL-MODE - actor perspective + reviewer perspective
 * 4. BEHAVIORAL DECOMPOSITION - atomic behaviors, not personas
 */

import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LATENT_SIGNALS } from "./signals.js";
import { BEHAVIOR_MIXES } from "./mixes.js";
import type { AtomicBehavior } from "./types.js";

/**
 * Re-export AtomicBehavior so existing imports
 * `import { type AtomicBehavior } from "latent-activator"` keep working.
 */
export type { AtomicBehavior } from "./types.js";

import { getExtensionState } from "../../../lib/state/extension-state.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface ActivatorState {
  currentBehaviors: Set<AtomicBehavior>;
  activationHistory: Array<{ behavior: AtomicBehavior; timestamp: number }>;
}

function getActivatorState(ctx?: ExtensionContext): ActivatorState {
  if (ctx)
    return getExtensionState(ctx, "latent-activator", () => ({
      currentBehaviors: new Set(["planner", "executor", "research"] as AtomicBehavior[]),
      activationHistory: [],
    }));
  return _default;
}
const _default: ActivatorState = {
  currentBehaviors: new Set(["planner", "executor", "research"] as AtomicBehavior[]),
  activationHistory: [],
};

/**
 * Maximum behaviors active at once. The agent can stack more, but the
 * activate handler will warn the user and refuse to add (so they have to
 * explicitly deactivate first). This prevents a runaway accumulation where
 * the agent activates "meticulous" + "pragmatic" + "architectural" + ... and
 * then the prompt is dominated by behavior-specific instructions.
 */
const MAX_ACTIVE_BEHAVIORS = 5;

/**
 * Activate a behavior
 */
function activateBehavior(behavior: AtomicBehavior): { ok: true } | { ok: false; reason: string } {
  const s = getActivatorState();
  if (s.currentBehaviors.size >= MAX_ACTIVE_BEHAVIORS && !s.currentBehaviors.has(behavior)) {
    return {
      ok: false,
      reason: `Already at max (${MAX_ACTIVE_BEHAVIORS}) active behaviors: ${getActiveBehaviors().join(", ")}. Deactivate one first or use action="deactivate_all".`,
    };
  }
  s.currentBehaviors.add(behavior);
  s.activationHistory.push({ behavior, timestamp: Date.now() });

  if (s.activationHistory.length > 100) {
    s.activationHistory = s.activationHistory.slice(-50);
  }
  return { ok: true };
}

/**
 * Deactivate a behavior
 */
function deactivateBehavior(behavior: AtomicBehavior): void {
  getActivatorState().currentBehaviors.delete(behavior);
}

/**
 * Get active behaviors
 */
function getActiveBehaviors(): AtomicBehavior[] {
  return Array.from(getActivatorState().currentBehaviors);
}

/**
 * Note: prior versions of this file had `generateLatentActivation`,
 * `hasComplianceFraming`, `hasComplianceFramingWithJudge`, and
 * `inferBehaviorsFromTask` (a 14-keyword task->behavior map + 10-keyword
 * compliance list). All four were dead code: exported but never
 * called from anywhere. The behavior auto-inference was explicitly
 * disabled ("Behavior inference disabled - use manual behavior tool
 * instead"). Removed in the fragile-pattern cleanup.
 */

const ACTIVATE_BEHAVIORS = Object.keys(LATENT_SIGNALS);

const behaviorSchema = Type.Object({
  action: Type.String({
    enum: ["activate", "deactivate", "deactivate_all", "list", "mix"],
    description:
      "activate = enable a behavior pattern. deactivate = disable a behavior. " +
      "deactivate_all = clear all active behaviors. list = show active behaviors. " +
      "mix = activate predefined scenario combos (clears existing first).",
  }),
  behavior: Type.Optional(
    Type.String({
      enum: ACTIVATE_BEHAVIORS,
      description: `Behavior to activate/deactivate. Available: ${ACTIVATE_BEHAVIORS.join(", ")}. Required for action=activate|deactivate.`,
    }),
  ),
  scenario: Type.Optional(
    Type.String({
      enum: Object.keys(BEHAVIOR_MIXES),
      description: `Predefined scenario combo. Available: ${Object.keys(BEHAVIOR_MIXES).join(", ")}. Required for action=mix.`,
    }),
  ),
});

export default function latentActivatorExtension(pi: ExtensionAPI) {
  registerSessionStartHandler(pi, SessionPhase.Background, async () => {
    try {
      const s = getActivatorState();
      s.currentBehaviors = new Set(["planner", "executor"] as AtomicBehavior[]);
      s.activationHistory = [];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[latent-activator] session_start error: ${msg}`);
    }
  });

  // Behavior inference disabled - use manual behavior tool instead

  pi.registerTool({
    name: "behavior",
    label: "Behavior",
    description:
      "Manage behavior patterns. Use action=activate to enable a behavior, action=deactivate to disable, " +
      "action=list to see active behaviors, action=mix for predefined scenario combos (e.g., 'refactoring', 'debugging').",
    promptSnippet: "manage behavior patterns for different problem-solving modes",
    parameters: behaviorSchema,
    execute: async (_toolCallId, params: any) => {
      try {
        const action = params.action;

        if (action === "activate") {
          if (!params.behavior) {
            return {
              content: [{ type: "text", text: "behavior is required for action=activate" }],
              details: { action, error: true },
            };
          }
          const behavior = params.behavior as AtomicBehavior;
          if (LATENT_SIGNALS[behavior]) {
            const result = activateBehavior(behavior);
            if (!result.ok) {
              return {
                content: [{ type: "text", text: result.reason }],
                details: { action, behavior, error: true, active: getActiveBehaviors() },
              };
            }
            const signal = LATENT_SIGNALS[behavior].activation[0];
            return {
              content: [{ type: "text", text: `Activated: ${behavior}. ${signal}` }],
              details: { action, behavior, active: getActiveBehaviors() },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Unknown behavior: "${behavior}". Available behaviors: ${ACTIVATE_BEHAVIORS.join(", ")}.`,
              },
            ],
            details: { action, behavior, available: ACTIVATE_BEHAVIORS, active: getActiveBehaviors() },
          };
        }

        if (action === "deactivate") {
          if (!params.behavior) {
            return {
              content: [{ type: "text", text: "behavior is required for action=deactivate" }],
              details: { action, error: true },
            };
          }
          const behavior = params.behavior as AtomicBehavior;
          deactivateBehavior(behavior);
          return {
            content: [{ type: "text", text: `Deactivated: ${behavior}` }],
            details: { action, behavior, active: getActiveBehaviors() },
          };
        }

        if (action === "list") {
          const active = getActiveBehaviors();
          return {
            content: [{ type: "text", text: `Active behaviors: ${active.join(", ") || "none"}` }],
            details: { action, active },
          };
        }

        if (action === "deactivate_all") {
          const before = getActiveBehaviors();
          for (const b of before) {
            deactivateBehavior(b);
          }
          return {
            content: [{ type: "text", text: `Deactivated all (${before.length}): ${before.join(", ") || "none"}` }],
            details: { action, deactivated: before, active: getActiveBehaviors() },
          };
        }

        if (action === "mix") {
          if (!params.scenario) {
            return {
              content: [{ type: "text", text: "scenario is required for action=mix" }],
              details: { action, error: true },
            };
          }
          const behaviors = BEHAVIOR_MIXES[params.scenario];
          if (behaviors) {
            // Clear existing first so `mix` is idempotent regardless of cap.
            for (const b of getActiveBehaviors()) {
              deactivateBehavior(b);
            }
            const skipped: string[] = [];
            for (const b of behaviors) {
              const result = activateBehavior(b);
              if (!result.ok) skipped.push(b);
            }
            return {
              content: [
                {
                  type: "text",
                  text:
                    skipped.length > 0
                      ? `Activated ${params.scenario} mode: ${behaviors.join(", ")} (skipped due to cap: ${skipped.join(", ")})`
                      : `Activated ${params.scenario} mode: ${behaviors.join(", ")}`,
                },
              ],
              details: { action, scenario: params.scenario, active: getActiveBehaviors() },
            };
          }
          return {
            content: [{ type: "text", text: `Unknown scenario: ${params.scenario}` }],
            details: { action, scenario: params.scenario, active: getActiveBehaviors() },
          };
        }

        return {
          content: [{ type: "text", text: "Unknown action. Use activate, deactivate, list, or mix." }],
          details: { action, error: true },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`behavior tool failed: ${msg}`);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          details: { error: msg },
        } as AgentToolResult<unknown>;
      }
    },
  });
}

export {
  activateBehavior,
  deactivateBehavior,
  getActiveBehaviors,
  LATENT_SIGNALS,
  BEHAVIOR_MIXES,
};
