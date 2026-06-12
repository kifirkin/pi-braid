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

/**
 * Atomic behaviors that can be activated
 */
export type AtomicBehavior =
  | "meticulous"
  | "pragmatic"
  | "architectural"
  | "debugger"
  | "reviewer"
  | "explorer"
  | "executor"
  | "planner"
  | "synthesizer"
  | "validator"
  | "forensic"
  | "catalyst"
  | "archivist"
  | "guardian"
  | "oracle"
  | "mirror"
  | "bridge"
  | "scalpel"
  | "compass"
  | "lens"
  | "hammer"
  | "detective"
  | "teacher"
  | "mentor"
  | "witness"
  | "artist"
  | "scientist"
  | "engineer"
  | "translator"
  | "referee"
  | "pioneer"
  | "curator"
  | "warrior"
  | "healer"
  | "messenger"
  | "keeper"
  | "wanderer"
  | "reflection"
  | "research";

/**
 * Implicit activation signals for each behavior
 */
const LATENT_SIGNALS: Record<
  AtomicBehavior,
  {
    activation: string[];
    deactivation: string[];
    priority: number;
  }
> = {
  meticulous: {
    activation: [
      "you are meticulous - you notice the small things that matter",
      "find the subtle issue",
      "spot the edge case",
    ],
    deactivation: ["move fast", "rough draft", "good enough"],
    priority: 0.8,
  },
  pragmatic: {
    activation: ["ship it", "keep it simple", "practical over perfect"],
    deactivation: ["over-engineer", "perfect solution", "clean abstraction"],
    priority: 0.9,
  },
  architectural: {
    activation: ["design the system", "long-term thinking", "patterns and principles"],
    deactivation: ["quick fix", "band-aid", "one-off solution"],
    priority: 0.85,
  },
  debugger: {
    activation: [
      "you are a debugger - you trace problems to their source",
      "why is this broken",
      "investigate the failure",
    ],
    deactivation: ["works fine", "ignore it", "probably nothing"],
    priority: 0.9,
  },
  reviewer: {
    activation: ["evaluate the quality", "what could go wrong", "critical eye"],
    deactivation: ["looks good", "ship it", "lgtm"],
    priority: 0.75,
  },
  explorer: {
    activation: ["what if we tried", "explore alternatives", "multiple approaches"],
    deactivation: ["obvious solution", "only one way", "no alternatives"],
    priority: 0.8,
  },
  executor: {
    activation: ["just do it", "write the code", "implement now"],
    deactivation: ["think more", "plan first", "design first"],
    priority: 0.95,
  },
  planner: {
    activation: [
      "you are a planner - you think step by step toward the correct path",
      "what's the trajectory",
      "find the correct path",
    ],
    deactivation: ["just start coding", "figure it out as we go"],
    priority: 0.9,
  },
  synthesizer: {
    activation: ["combine these ideas", "find the pattern", "connect the dots"],
    deactivation: ["isolated thinking", "one piece at a time"],
    priority: 0.7,
  },
  validator: {
    activation: ["test this hypothesis", "verify the solution", "prove it works"],
    deactivation: ["trust me", "should work", "obviously correct"],
    priority: 0.85,
  },
  forensic: {
    activation: ["gather evidence", "build the case", "what happened here"],
    deactivation: ["skip the investigation", "obvious"],
    priority: 0.75,
  },
  catalyst: {
    activation: [
      "you are a catalyst - you break deadlocks and move things forward",
      "move forward",
      "unblock this",
    ],
    deactivation: ["still blocked", "need more discussion"],
    priority: 0.9,
  },
  archivist: {
    activation: ["remember from before", "this was solved similar", "capture this pattern"],
    deactivation: ["start fresh", "ignore history", "new problem"],
    priority: 0.7,
  },
  guardian: {
    activation: [
      "you are a guardian - you protect against what could go wrong",
      "prevent the bug",
      "safety check",
    ],
    deactivation: ["just ship it", "move fast", "risky is fine"],
    priority: 0.85,
  },
  oracle: {
    activation: ["predict what will happen", "foresee the consequence", "anticipate the failure"],
    deactivation: ["deal with it later", "cross that bridge"],
    priority: 0.7,
  },
  mirror: {
    activation: ["reflect on this", "what are we missing", "self-correct"],
    deactivation: ["keep going", "no time for reflection"],
    priority: 0.75,
  },
  bridge: {
    activation: ["connect these concepts", "analogy to explain", "translate between domains"],
    deactivation: ["stay focused", "don't change topics"],
    priority: 0.7,
  },
  scalpel: {
    activation: ["precise change", "surgical precision", "minimal impact"],
    deactivation: ["big refactor", "rewrite it all", "nuke it"],
    priority: 0.8,
  },
  compass: {
    activation: ["what matters most", "prioritize this", "which direction"],
    deactivation: ["everything is urgent", "equal priority"],
    priority: 0.85,
  },
  lens: {
    activation: ["look at it differently", "shift perspective", "reframe the problem"],
    deactivation: ["obvious approach", "standard solution"],
    priority: 0.75,
  },
  hammer: {
    activation: ["solve it directly", "the obvious solution", "sometimes simple is best"],
    deactivation: ["overthink it", "elegant solution"],
    priority: 0.9,
  },
  detective: {
    activation: ["follow the clues", "piece together", "find the evidence"],
    deactivation: ["skip investigation", "obvious culprit"],
    priority: 0.8,
  },
  teacher: {
    activation: ["explain this", "help them understand", "walk through"],
    deactivation: ["they should know", "obvious"],
    priority: 0.7,
  },
  mentor: {
    activation: ["guide the way", "what would help", "teach them to fish"],
    deactivation: ["just give them fish", "spoonfeed"],
    priority: 0.75,
  },
  witness: {
    activation: ["observe and document", "what did we see", "record this"],
    deactivation: ["move on", "we know enough"],
    priority: 0.6,
  },
  artist: {
    activation: ["elegant solution", "creative approach", "beauty in code"],
    deactivation: ["works is enough", "functional over beautiful"],
    priority: 0.7,
  },
  scientist: {
    activation: ["form a hypothesis", "design an experiment", "test it"],
    deactivation: ["assume it's true", "obvious"],
    priority: 0.8,
  },
  engineer: {
    activation: ["build robust systems", "consider scale", "production-ready"],
    deactivation: ["prototype only", "proof of concept"],
    priority: 0.85,
  },
  translator: {
    activation: ["make it clear", "explain simply", "clarify this"],
    deactivation: ["technical is fine", "they understand"],
    priority: 0.75,
  },
  referee: {
    activation: ["judge this", "make the call", "decide between options"],
    deactivation: ["both are good", "let them decide"],
    priority: 0.7,
  },
  pioneer: {
    activation: ["new territory", "venture into unknown", "first to try"],
    deactivation: ["proven path", "stick to what works"],
    priority: 0.65,
  },
  curator: {
    activation: ["select the best", "organize this", "curate carefully"],
    deactivation: ["include everything", "more is better"],
    priority: 0.7,
  },
  warrior: {
    activation: ["fight through this", "overcome the obstacle", "battle the problem"],
    deactivation: ["give up", "too hard"],
    priority: 0.8,
  },
  healer: {
    activation: ["fix what's broken", "make it whole", "restore health"],
    deactivation: ["leave it", "not our job"],
    priority: 0.85,
  },
  messenger: {
    activation: ["convey this", "deliver the message", "communicate clearly"],
    deactivation: ["they'll figure it out", "obvious"],
    priority: 0.7,
  },
  keeper: {
    activation: ["preserve this", "maintain the legacy", "keep it safe"],
    deactivation: ["change everything", "burn it down"],
    priority: 0.65,
  },
  wanderer: {
    activation: ["explore freely", "wander into the unknown", "see what's out there"],
    deactivation: ["stay on path", "focused mission"],
    priority: 0.6,
  },
  reflection: {
    activation: ["step back and look", "what are we really doing", "question assumptions"],
    deactivation: ["just follow instructions", "don't overthink"],
    priority: 0.85,
  },
  research: {
    activation: ["search thoroughly", "verify before claiming", "find the evidence"],
    deactivation: ["assume it's true", "skip verification", "obvious"],
    priority: 0.9,
  },
};

/**
 * Behavior combinations for common scenarios
 */
const BEHAVIOR_MIXES: Record<string, AtomicBehavior[]> = {
  "code-review": ["reviewer", "validator", "guardian", "meticulous"],
  "debugging": ["detective", "debugger", "forensic", "oracle"],
  "planning": ["planner", "architectural", "compass", "oracle"],
  "implementation": ["executor", "pragmatic", "scalpel", "catalyst"],
  "exploration": ["explorer", "wanderer", "bridge", "lens"],
  "reflection": ["mirror", "archivist", "witness", "mentor"],
  "crisis": ["catalyst", "warrior", "guardian", "hammer"],
  "learning": ["scientist", "research", "teacher", "explorer"],
  "research": ["research", "scientist", "detective", "archivist"],
  "refactoring": ["architectural", "meticulous", "artist", "scalpel"],
  "handover": ["witness", "translator", "archivist"],
};

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
 * `inferBehaviorsFromTask` (a 14-keyword task→behavior map + 10-keyword
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
