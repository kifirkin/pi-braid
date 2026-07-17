/**
 * Context body fragment for the prompt-builder.
 *
 * Renders the *body* of the runtime context bullets (no heading):
 *   - Context-usage percentage (only when > 75%)
 *   - Session health (only when non-healthy; full recovery message
 *     still travels via the whisper channel)
 *   - Memory count (only when > 0)
 *   - Steps since last checkpoint (only when > 0)
 *
 * Returns "" when nothing matches; the prompt-builder composes this
 * fragment with `project-docs-section` and `memory-section` into a
 * unified context block (no heading, plain text, see index.ts).
 *
 * Differs from Instance (stable per session-start) and Session
 * (volatile session stats). The three-block split landed in v3.6;
 * the previous monolithic `l1-environment.ts` mixed all three
 * categories and has been removed.
 *
 * Source of pi package root that used to live here was dropped
 * (v3.5 moved it into the Instance block alongside braid version
 * and root).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCognitiveMemory } from "../../../lib/memory/index.js";
import { getSessionHealth } from "../../enforcement/session-health.js";
import type { PromptSection } from "./section.js";

export interface ContextData {
  contextPercent: number;
  memoryCount: number;
  stepsSinceCheckpoint: number;
  sessionHealth?: { mode: string; lastErrorCategory?: string };
}

/**
 * Gather conditional context data. Each gather is best-effort: if a
 * source is unavailable (memory not init'd, session manager absent,
 * enforcement not loaded), the corresponding field stays at its
 * zero-value rather than throwing. The agent should not see an
 * "unavailable" message in the system prompt for these.
 */
export async function gatherContextState(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<ContextData> {
  let contextPercent = 0;
  let stepsSinceCheckpoint = 0;

  try {
    const usage = ctx?.getContextUsage?.();
    if (usage) contextPercent = usage.percent ?? 0;

    const sm = ctx?.sessionManager;
    if (sm) {
      const branch = sm.getBranch();
      for (let i = branch.length - 1; i >= 0; i--) {
        const label = sm.getLabel(branch[i].id);
        if (label) {
          stepsSinceCheckpoint = branch.length - 1 - i;
          break;
        }
      }
    }
  } catch {
    // Non-fatal: missing APIs in some environments
  }

  let memoryCount = 0;
  try {
    const memory = getCognitiveMemory();
    try {
      await memory.init();
    } catch {
      /* already initialized or init failed - non-fatal */
    }
    memoryCount = memory.getAll(3).length;
  } catch {
    // Non-fatal: memory unavailable
  }

  let sessionHealth: ContextData["sessionHealth"];
  try {
    const health = getSessionHealth(ctx);
    if (health.mode !== "healthy") {
      sessionHealth = {
        mode: health.mode,
        lastErrorCategory: health.lastError?.category,
      };
    }
  } catch {
    // Non-fatal: enforcement may not be loaded
  }

  return { contextPercent, memoryCount, stepsSinceCheckpoint, sessionHealth };
}

/** Build the Context section. Renders "" when nothing to surface. */
export function contextSection(data: ContextData): PromptSection {
  return {
    name: "context",
    render: () => {
      const lines: string[] = [];

      // Context warning only when critical (matches the v3.5 threshold).
      if (data.contextPercent > 75) {
        lines.push(`- Context: ${data.contextPercent.toFixed(0)}%`);
      }

      // Session health surfaces only when not healthy. The whisper
      // channel already carries the full recovery message; this is
      // the at-a-glance indicator in the system prompt.
      if (data.sessionHealth) {
        const errorDetail = data.sessionHealth.lastErrorCategory
          ? ` (last error: ${data.sessionHealth.lastErrorCategory})`
          : "";
        lines.push(`- Session health: ${data.sessionHealth.mode}${errorDetail}`);
      }

      if (data.memoryCount > 0) {
        lines.push(`- Memory: ${data.memoryCount} prior experience(s)`);
      }

      if (data.stepsSinceCheckpoint > 0) {
        lines.push(
          `- Checkpoint: ${data.stepsSinceCheckpoint} step(s) since last checkpoint - consider tagging context`,
        );
      }

      // Omit the body entirely when nothing to surface. The composer
      // (index.ts) joins this fragment with project-docs and memory
      // bodies; an empty fragment is filtered out before the
      // unified context block (no heading). Returning the bullets
      // without a heading lets the parent composer own the heading
      // so all three sibling fragments share one markdown heading.
      if (lines.length === 0) return "";
      return lines.join("\n");
    },
  };
}
