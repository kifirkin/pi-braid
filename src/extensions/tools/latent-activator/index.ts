import { createLogger } from "../../../lib/logger.js";

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
 * Design principles:
 * 1. IMPLICIT > EXPLICIT - subtle cues > direct commands
 * 2. ACTIVATION > INSTRUCTION - trigger capabilities vs tell what to do
 * 3. DUAL-MODE - actor perspective + reviewer perspective
 * 4. BEHAVIORAL DECOMPOSITION - atomic behaviors, not personas
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

/**
 * Atomic behaviors that can be activated
 */
export type AtomicBehavior =
  | "meticulous" | "pragmatic" | "architectural" | "debugger" | "reviewer"
  | "explorer" | "executor" | "planner" | "synthesizer" | "validator"
  | "forensic" | "catalyst" | "archivist" | "guardian" | "oracle"
  | "mirror" | "bridge" | "scalpel" | "compass" | "lens"
  | "hammer" | "detective" | "teacher" | "mentor" | "witness"
  | "artist" | "scientist" | "engineer" | "translator" | "referee"
  | "pioneer" | "curator" | "warrior" | "healer" | "messenger"
  | "keeper" | "wanderer" | "reflection";

/**
 * Implicit activation signals for each behavior
 */
const LATENT_SIGNALS: Record<AtomicBehavior, {
  activation: string[];
  deactivation: string[];
  priority: number;
}> = {
  meticulous: {
    activation: ["you are meticulous — you notice the small things that matter", "find the subtle issue", "spot the edge case"],
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
    activation: ["you are a debugger — you trace problems to their source", "why is this broken", "investigate the failure"],
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
    activation: ["you are a planner — you think step by step toward the correct path", "what's the trajectory", "find the correct path"],
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
    activation: ["you are a catalyst — you break deadlocks and move things forward", "move forward", "unblock this"],
    deactivation: ["still blocked", "need more discussion"],
    priority: 0.9,
  },
  archivist: {
    activation: ["remember from before", "this was solved similar", "capture this pattern"],
    deactivation: ["start fresh", "ignore history", "new problem"],
    priority: 0.7,
  },
  guardian: {
    activation: ["you are a guardian — you protect against what could go wrong", "prevent the bug", "safety check"],
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
  "learning": ["scientist", "teacher", "explorer"],
  "refactoring": ["architectural", "meticulous", "artist", "scalpel"],
  "handover": ["witness", "translator", "archivist"],
};

/**
 * State for latent activation
 */
let _currentBehaviors: Set<AtomicBehavior> = new Set(["planner", "executor"]);
let _activationHistory: Array<{ behavior: AtomicBehavior; timestamp: number }> = [];

/**
 * Activate a behavior
 */
function activateBehavior(behavior: AtomicBehavior): void {
  _currentBehaviors.add(behavior);
  _activationHistory.push({ behavior, timestamp: Date.now() });
  
  if (_activationHistory.length > 100) {
    _activationHistory = _activationHistory.slice(-50);
  }
}

/**
 * Deactivate a behavior
 */
function deactivateBehavior(behavior: AtomicBehavior): void {
  _currentBehaviors.delete(behavior);
}

/**
 * Get active behaviors
 */
function getActiveBehaviors(): AtomicBehavior[] {
  return Array.from(_currentBehaviors);
}

/**
 * Generate implicit activation prompt from current behaviors.
 * Optionally accepts a task hint to infer and activate relevant behaviors first.
 */
function generateLatentActivation(taskHint?: string): string {
  if (taskHint) {
    const inferred = inferBehaviorsFromTask(taskHint);
    for (const b of inferred) {
      activateBehavior(b);
    }
  }
  
  if (_currentBehaviors.size === 0) return "";
  
  const sorted = Array.from(_currentBehaviors)
    .map(b => ({ behavior: b, signal: LATENT_SIGNALS[b] }))
    .sort((a, b) => b.signal.priority - a.signal.priority)
    .slice(0, 3);
  
  const cues = sorted.map(({ signal }) => 
    signal.activation[Math.floor(Math.random() * signal.activation.length)]
  );
  
  return cues.join(". ") + ".";
}

/**
 * Check if task hints suggest certain behaviors
 */
const COMPLIANCE_PATTERNS = [
  "must", "required", "ensure", "verify", "always",
  "never", "critical", "strictly", "mandatory", "obligatory",
  "shall", "will be", "is expected to", "it is essential",
];

function hasComplianceFraming(text: string): boolean {
  const lower = text.toLowerCase();
  return COMPLIANCE_PATTERNS.some(p => lower.includes(p));
}

function inferBehaviorsFromTask(task: string): AtomicBehavior[] {
  const lowerTask = task.toLowerCase();
  const inferred: AtomicBehavior[] = [];

  // Detect compliance framing and inject reflection to counter compliance theater
  if (hasComplianceFraming(task)) {
    inferred.push("reflection");
  }
  
  const keywordMap: Array<[string, AtomicBehavior[]]> = [
    ["bug", ["detective", "debugger", "forensic"]],
    ["fix", ["healer", "catalyst"]],
    ["implement", ["executor", "pragmatic", "hammer"]],
    ["design", ["architectural", "artist", "planner"]],
    ["refactor", ["architectural", "meticulous", "scalpel"]],
    ["review", ["reviewer", "validator", "guardian"]],
    ["test", ["validator", "scientist", "guardian"]],
    ["explore", ["explorer", "wanderer", "lens"]],
    ["explain", ["teacher", "translator", "bridge"]],
    ["optimize", ["scientist", "scalpel", "architectural"]],
    ["debug", ["detective", "forensic", "oracle"]],
    ["investigate", ["detective", "forensic", "witness"]],
    ["plan", ["planner", "compass", "architectural"]],
    ["create", ["artist", "pioneer", "executor"]],
  ];
  
  for (const [keyword, behaviors] of keywordMap) {
    if (lowerTask.includes(keyword)) {
      inferred.push(...behaviors);
    }
  }
  
  return [...new Set(inferred)];
}

const activateSchema = Type.Object({
  behavior: Type.String({
    description: "Behavior to activate",
  }),
});

const deactivateSchema = Type.Object({
  behavior: Type.String({
    description: "Behavior to deactivate",
  }),
});

const activateMixSchema = Type.Object({
  scenario: Type.String({
    enum: Object.keys(BEHAVIOR_MIXES),
    description: "Scenario to activate behaviors for",
  }),
});

export default function latentActivatorExtension(pi: ExtensionAPI) {
  pi.on("session_start", () => {
    _currentBehaviors = new Set(["planner", "executor"]);
    _activationHistory = [];
  });
  
  // Behavior inference disabled - use manual activate_behavior tool instead
  
  pi.registerTool({
    name: "activate_behavior",
    label: "Activate Behavior",
    description: "Activate a latent behavior pattern. Behaviors are implicit - they shift how you approach problems.",
    promptSnippet: "activate behavior patterns for different problem-solving modes",
    parameters: activateSchema,
    execute: async (_toolCallId, params: any) => {
      const behavior = params.behavior as AtomicBehavior;
      if (LATENT_SIGNALS[behavior]) {
        activateBehavior(behavior);
        const signal = LATENT_SIGNALS[behavior].activation[0];
        return {
          content: [{ type: "text", text: `Activated: ${behavior}. ${signal}` }],
          details: { behavior, active: getActiveBehaviors() },
        };
      }
      return {
        content: [{ type: "text", text: `Unknown behavior: ${behavior}` }],
        details: { behavior, active: getActiveBehaviors() },
      };
    },
  });
  
  pi.registerTool({
    name: "deactivate_behavior",
    label: "Deactivate Behavior",
    description: "Deactivate a behavior pattern when no longer relevant.",
    promptSnippet: "deactivate a behavior pattern when no longer relevant",
    parameters: deactivateSchema,
    execute: async (_toolCallId, params: any) => {
      const behavior = params.behavior as AtomicBehavior;
      deactivateBehavior(behavior);
      return {
        content: [{ type: "text", text: `Deactivated: ${behavior}` }],
        details: { behavior, active: getActiveBehaviors() },
      };
    },
  });
  
  pi.registerTool({
    name: "get_active_behaviors",
    label: "Get Active Behaviors",
    description: "View currently active behavior patterns.",
    promptSnippet: "check what behavior patterns are currently active",
    parameters: Type.Object({}),
    execute: async () => {
      const active = getActiveBehaviors();
      return {
        content: [{ type: "text", text: `Active behaviors: ${active.join(", ") || "none"}` }],
        details: { active },
      };
    },
  });
  
  pi.registerTool({
    name: "activate_mix",
    label: "Activate Mix",
    description: "Activate a predefined combination of behaviors for common scenarios.",
    promptSnippet: "activate a predefined behavior mix for common scenarios",
    parameters: activateMixSchema,
    execute: async (_toolCallId, params: any) => {
      const behaviors = BEHAVIOR_MIXES[params.scenario];
      if (behaviors) {
        for (const b of behaviors) {
          activateBehavior(b);
        }
        return {
          content: [{ type: "text", text: `Activated ${params.scenario} mode: ${behaviors.join(", ")}` }],
          details: { scenario: params.scenario, active: getActiveBehaviors() },
        };
      }
      return {
        content: [{ type: "text", text: `Unknown scenario: ${params.scenario}` }],
        details: { scenario: params.scenario, active: getActiveBehaviors() },
      };
    },
  });
}

export {
  activateBehavior,
  deactivateBehavior,
  getActiveBehaviors,
  generateLatentActivation,
  inferBehaviorsFromTask,
  LATENT_SIGNALS,
  BEHAVIOR_MIXES,
};
