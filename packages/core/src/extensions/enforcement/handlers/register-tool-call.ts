/**
 * register-tool-call - Tool usage tracking + blocking enforcement.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onEvent } from "../../../lib/events/event-types.js";
import { checkBlocking } from "./blocking.js";
import { checkOverCorrectionGate } from "./over-correction-gate.js";
import { recordToolCall, recordToolInput, recordBashDetails } from "./tool-tracker.js";
import {
  checkLocalizationRisk,
  recordFileTouch,
} from "../../../lib/store/bidirectional-verifier.js";
import {
  checkCoordination,
  recordCoordinationEdit,
} from "../../../lib/verification/coordination-checker.js";
import { knownFiles } from "../similarity.js";
import { getState, recordThink, incrementToolsSinceReflection } from "../state.js";
import { TOOL_CALL } from "../../../lib/core/event-names.js";
import { createLogger } from "../../../lib/core/logger.js";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { braidDir, tagsSlugFromCwd } from "../../../lib/config/braid-paths.js";
import {
  recordToolCall as recordLoopToolCall,
  getToolLoopState,
} from "../../../lib/detection/tool-loop-detector.js";
import { pushBounded } from "../../../lib/utils/bounded.js";

const log = createLogger("enforcement:tool-call");

/** ToolLog ring cap. 20x the widest lookback (verify-judge -50). */
const TOOL_LOG_CAP = 1000;

export function registerToolCallHandler(pi: ExtensionAPI): void {
  onEvent(pi, TOOL_CALL, async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) {
      return undefined;
    }

    const toolName = event.toolName;
    const input = event?.input as Record<string, unknown> | undefined;

    if (!toolName || !toolName.trim()) return undefined;

    recordToolCall(toolName, ctx);

    // Record tool call for tool-loop-detector (per-turn tool sets). The
    // arguments ride along: a loop is the same call repeating, and the tool
    // name alone cannot say whether sixteen `bash` calls are sixteen commands
    // or one command sixteen times.
    const loopState = getToolLoopState(ctx);
    recordLoopToolCall(loopState, toolName, input);
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
        recordCoordinationEdit(ctx, fp, getState(ctx).currentTurn);

        // Localization risk check
        const risk = checkLocalizationRisk(ctx, fp, getState(ctx).currentTurn);
        if (risk) {
          getState(ctx).localizationRisk = risk;
        }

        // Coordination check: cannot warn today: no relationship is registered
        // (nothing calls registerDerived). See lib/verification/coordination-checker.ts.
        const coordWarnings = checkCoordination(ctx, fp, getState(ctx).currentTurn);
        if (coordWarnings.length > 0) {
          getState(ctx).localizationRisk = coordWarnings[0].message;
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

    // ToolLog grows one string per tool call for the session's
    // lifetime. Capped ring (drop-oldest) at 1000 — 20x the widest consumer
    // lookback (verification-judge slice(-50)); the MARS/advice full-log
    // counters degrade to a last-1000 window (advisory analytics, rates
    // preserved). See lib/utils/bounded.ts for the pattern.
    pushBounded(getState(ctx).toolLog, `${toolName}`, TOOL_LOG_CAP);

    if (toolName === "finalize") {
      getState(ctx).pendingFinalize = true;
    }

    // When context_navigate(action="tag") creates a tag, also persist it to
    // ~/.pi/agent/braid/tags/<project-slug>.json so tags survive across sessions.
    if (toolName === "context_navigate" && input?.action === "tag" && input?.name) {
      try {
        const cwd = (ctx as { cwd?: string }).cwd ?? "";
        const slug = tagsSlugFromCwd(cwd);
        const tagsDir = path.join(braidDir(), "tags");
        if (!existsSync(tagsDir)) mkdirSync(tagsDir, { recursive: true });
        const tagsFile = path.join(tagsDir, `${slug}.json`);

        let tags: Record<string, { turn: number; timestamp: number }> = {};
        if (existsSync(tagsFile)) {
          try {
            tags = JSON.parse(readFileSync(tagsFile, "utf-8"));
          } catch {
            tags = {};
          }
        }

        tags[input.name as string] = {
          turn: getState(ctx).currentTurn,
          timestamp: Date.now(),
        };
        writeFileSync(tagsFile, JSON.stringify(tags, null, 2), "utf-8");
        log.debug(`Persisted tag "${input.name}" to ${tagsFile}`);
      } catch (err) {
        // Failure here means the tag is silently lost on restart — say so at
        // warn, the level a refusal has to be visible at by default.
        log.warn(`Tag persist failed for "${input.name}" (non-fatal, tag lost on reload): ${err}`);
      }
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

    const gateResult = checkOverCorrectionGate(pi, ctx, toolName, input);
    if (gateResult.blocked) {
      return { block: true, reason: gateResult.reason };
    }

    return undefined;
  });
}
