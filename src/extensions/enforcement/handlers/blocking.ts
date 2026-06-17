


/**
 * Blocking enforcement - prevents tool execution that violates patterns
 *
 * L2 signals (soft nudges): tracked in state, bundled by index.ts turn_end.
 *
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EnforcementState } from "../state.js";

/** Result of a blocking check */
export interface BlockResult {
  blocked: boolean;
  reason: string;
}

/** Check if a tool call should be blocked based on enforcement rules */
export function checkBlocking(
  _pi: ExtensionAPI,
  toolName: string,
  eventInput: Record<string, unknown> | undefined,
  stateRef: EnforcementState,
): BlockResult {
  const writeTools = ["edit", "write"];

  function fileExists(filePath: string): boolean {
    try {
      const stats = fs.statSync(filePath);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  // BLOCK: Edit/Write without any prior exploration in session (existing files only)
  if (writeTools.includes(toolName)) {
    const targetPath = (eventInput as { path?: string } | undefined)?.path;
    const isWriteToNewFile = toolName === "write" && targetPath && !fileExists(targetPath);

    // Downgraded from block to passthrough: too noisy to force exploration.
    if (!stateRef.exploreCalledInSession && !stateRef.hasExplored && !isWriteToNewFile) {
      return { blocked: false, reason: "explore-before-edit (downgraded)" };
    }
  }

  // L2: Edit without think() - track for Session Signals bundle
  if (toolName === "edit" && !stateRef.thinkCalledInSession) {
    stateRef.toolChain.recentEditWithoutThink.push(stateRef.currentTurn);
  }

  // L2: Edit without plan - track for Session Signals bundle
  if (toolName === "edit") {
    const turnsSincePlan = stateRef.currentTurn - stateRef.toolChain.lastPlanCall;
    if (turnsSincePlan > 3 && stateRef.thinkCalledInSession) {
      stateRef.toolChain.recentEditWithoutPlan.push(stateRef.currentTurn);
    }
  }

  return { blocked: false, reason: "" };
}
