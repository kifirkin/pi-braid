/**
 * Latent activation signals - per-behavior triggers and priorities.
 *
 * Each AtomicBehavior has:
 *   - activation: phrases that should turn this behavior ON
 *   - deactivation: phrases that should turn this behavior OFF
 *   - priority: how strongly the behavior should activate (0-1)
 *
 * Extracted from index.ts (was lines 81-310) to keep the main file focused
 * on extension logic. Pure data - no imports from index.ts.
 */

import type { AtomicBehavior } from "./types.js";

export const LATENT_SIGNALS: Record<
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
