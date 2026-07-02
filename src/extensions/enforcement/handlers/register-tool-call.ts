/**
 * register-tool-call - Tool usage tracking + blocking enforcement.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onEvent } from "../../../lib/events/event-types.js";
import { checkBlocking } from "./blocking.js";
import { recordToolCall, recordToolInput, recordBashDetails } from "./tool-tracker.js";
import { checkLocalizationRisk, recordFileTouch } from "../../../lib/store/bidirectional-verifier.js";
import { knownFiles } from "../similarity.js";
import { getState, recordThink, incrementToolsSinceReflection } from "../state.js";
import { TOOL_CALL } from "../../../lib/core/event-names.js";
import {
  recordToolCall as recordLoopToolCall,
  getToolLoopState,
} from "../../../lib/detection/tool-loop-detector.js";

export function registerToolCallHandler(pi: ExtensionAPI): void {
  onEvent(pi, TOOL_CALL, async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) {
      return undefined;
    }

    const toolName = event.toolName;
    const input = event?.input as Record<string, unknown> | undefined;

    if (!toolName || !toolName.trim()) return undefined;

    recordToolCall(toolName, ctx);

    // Record tool call for tool-loop-detector (per-turn tool sets)
    const loopState = getToolLoopState(ctx);
    recordLoopToolCall(loopState, toolName);
    recordToolInput(toolName, input, getState(ctx));

    if (toolName === "bash") {
      const cmd = (input as { command?: string } | undefined)?.command || "";
      recordBashDetails(cmd, getState(ctx));
    }

    if (toolName === "edit" || toolName === "write") {
      getState(ctx).hasCodeChanges = true;
      const fp = (input?.path as string) ?? (input?.target as string) ?? "";
      if (fp) {
        recordFileTouch(ctx, fp, getState(ctx).currentTurn, true);
        const risk = checkLocalizationRisk(ctx, fp, getState(ctx).currentTurn);
        if (risk) {
          getState(ctx).localizationRisk = risk;
        }
      }
    }

    if (toolName === "read" || toolName === "grep" || toolName === "find") {
      const fp =
        (input?.path as string) ?? (input?.target as string) ?? (input?.pattern as string) ?? "";
      if (fp) {
        recordFileTouch(ctx, fp, getState(ctx).currentTurn, false);
      }
    }

    if (toolName === "edit" || toolName === "write") {
      const filePath = (input as { path?: string } | undefined)?.path;
      if (filePath) {
        knownFiles.set(filePath, { content: "", turn: getState(ctx).currentTurn });
      }
    }

    getState(ctx).toolLog.push(`${toolName}`);

    if (toolName === "finalize") {
      getState(ctx).pendingFinalize = true;
    }

    if (toolName === "think") {
      const thinkType = (input as { type?: string })?.type || "unknown";
      const parentId = (input as { parent_id?: string })?.parent_id || null;
      const confidence = (input as { confidence?: number })?.confidence;
      recordThink(getState(ctx), thinkType, parentId, confidence);
    } else {
      incrementToolsSinceReflection(getState(ctx));
    }

    const blockResult = checkBlocking(pi, toolName, input, getState(ctx));
    if (blockResult.blocked) {
      return { block: true, reason: blockResult.reason };
    }

    return undefined;
  });
}
