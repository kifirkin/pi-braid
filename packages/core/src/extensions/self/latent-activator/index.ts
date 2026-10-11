import { createLogger } from "../../../lib/core/logger.js";
import {
  registerSessionStartHandler,
  SessionPhase,
} from "../../../lib/state/session-start-queue.js";

const log = createLogger("latent-activator");

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

import {
  getActivatorState,
  activateBehavior,
  deactivateBehavior,
  getActiveBehaviors,
} from "./state.js";

const ACTIVATE_BEHAVIORS = Object.keys(LATENT_SIGNALS);

const behaviorSchema = Type.Object({
  action: Type.String({
    enum: ["activate", "deactivate", "deactivate_all", "list", "mix"],
    description:
      "activate/deactivate a behavior, deactivate_all to clear, list to view, mix scenario combos (clears first).",
  }),
  behavior: Type.Optional(
    Type.String({
      enum: ACTIVATE_BEHAVIORS,
      description: `Behavior to activate/deactivate. Available: ${ACTIVATE_BEHAVIORS.join(", ")}.`,
    }),
  ),
  scenario: Type.Optional(
    Type.String({
      enum: Object.keys(BEHAVIOR_MIXES),
      description: `Predefined scenario combo. Available: ${Object.keys(BEHAVIOR_MIXES).join(", ")}.`,
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
    description: "Manage behavior patterns: activate, deactivate, list, or mix scenario combos.",
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
            details: {
              action,
              behavior,
              available: ACTIVATE_BEHAVIORS,
              active: getActiveBehaviors(),
            },
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
            content: [
              {
                type: "text",
                text: `Deactivated all (${before.length}): ${before.join(", ") || "none"}`,
              },
            ],
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
          content: [
            { type: "text", text: "Unknown action. Use activate, deactivate, list, or mix." },
          ],
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

export { activateBehavior, deactivateBehavior, getActiveBehaviors, LATENT_SIGNALS, BEHAVIOR_MIXES };
