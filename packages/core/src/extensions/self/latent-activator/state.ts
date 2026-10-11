/**
 * Latent activator state management.
 *
 * Owns the in-memory behavior state, activation/deactivation logic, and the
 * max-cap enforcement.
 */

import { getExtensionState } from "../../../lib/state/extension-state.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AtomicBehavior } from "./types.js";

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

export {
  getActivatorState,
  MAX_ACTIVE_BEHAVIORS,
  activateBehavior,
  deactivateBehavior,
  getActiveBehaviors,
};
