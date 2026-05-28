/**
 * Tool Safety — Utility-model safety check for destructive tool calls.
 *
 * On each tool_call for destructive operations (edit, write, bash, delete),
 * classifies the operation with the configured utility model before execution.
 * If classified as "unsafe", blocks execution with a steer.
 *
 * Three-tier fallback (same as roast filter): utility → session → heuristic.
 * Heuristic is conservative — always allows through on degradation.
 * Timeout (2s) also allows through — safety check never blocks.
 *
 * Part of the hacking-a0 infection check layer.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { classify } from "../../../lib/text-classifier.js";
import { createLogger } from "../../../lib/core/logger.js";
import { DESTRUCTIVE_TOOLS } from "../../../lib/constants/tool-constants.js";
import { onEvent } from "../../../lib/event-types.js";

const log = createLogger("tool-safety");

// ── Operators to check ──────────────────────────────────────────────────────

/** Tools that modify system state and need safety classification. */
const DESTRUCTIVE_TOOLS_SET = new Set(DESTRUCTIVE_TOOLS); // includes edit, write, bash, delete

// ── Classification Criteria ──────────────────────────────────────────────────

const TOOL_SAFETY_CRITERIA = {
  systemPrompt:
    "You are a tool safety classifier. Determine if the given tool call " +
    "is DESTRUCTIVE OR DANGEROUS. Consider: " +
    "deleting files, overwriting critical configuration, " +
    "executing dangerous shell commands (rm -rf, dd, mkfs, chmod -R 777, " +
    "curl | sh, wget | bash), modifying system/passwd/ssh files, " +
    "or performing irreversible operations. " +
    "Answer only 'yes' or 'no'. 'yes' = DANGEROUS, 'no' = SAFE. Do not explain.",
  userPrompt: "Tool: {{toolName}}\n" + "Args: {{toolArgs}}\n" + "Is this tool call dangerous?",
};

// ── Heuristic Fallback ───────────────────────────────────────────────────────

/** Always safe on degradation — never false-positive block. */
function isSafeFallback(): string {
  return "no";
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function toolSafetyExtension(pi: ExtensionAPI): void {
  onEvent(pi, "tool_call", async (event: any, ctx: ExtensionContext) => {
    const toolName: string = event?.toolName ?? "";
    if (!DESTRUCTIVE_TOOLS_SET.has(toolName)) return;

    const input = (event?.input ?? {}) as Record<string, unknown>;
    const args = JSON.stringify(input).slice(0, 1000); // keep tokens reasonable

    log.debug(`[tool-safety] Checking ${toolName}: ${args.slice(0, 120)}...`);

    try {
      const result = await classify(
        ctx,
        TOOL_SAFETY_CRITERIA,
        { toolName, toolArgs: args },
        {
          maxTokens: 5,
          timeoutMs: 2000, // tight — never block the agent for long
          fallback: isSafeFallback,
        },
      );

      if (result.label === "yes") {
        log.warn(
          `[tool-safety] BLOCKED ${toolName}: ${args.slice(0, 200)}` +
            ` (tier: ${result.tier}, confidence: ${result.confidence})`,
        );

        // Send a steer warning the agent
        try {
          const { sendTrackedMessage } = await import("../../../lib/injection-tracker.js");
          sendTrackedMessage(
            pi,
            {
              customType: "tool-safety",
              content: [
                {
                  type: "text" as const,
                  text:
                    `## ⚠️ Tool Blocked for Safety\n\n` +
                    `The tool call \`${toolName}\` was classified as potentially dangerous ` +
                    `(confidence: ${result.confidence}, tier: ${result.tier}).\n\n` +
                    `**Args:** \`\`\`\n${args.slice(0, 400)}\n\`\`\`\n\n` +
                    `If this is legitimate, rephrase the approach to make ` +
                    `the operation's safety clearer (e.g., validate paths explicitly, ` +
                    `use safer flags). If this was a mistake, try again.`,
                },
              ],
              display: true,
            },
            { deliverAs: "steer" as const, triggerTurn: true },
            { type: "enforcement" as const, source: "tool-safety/block" },
          );
        } catch {
          // Non-fatal — block silently if steer delivery fails
          log.warn("[tool-safety] Steer delivery failed");
        }

        // Block the tool
        return { block: true, reason: "classified as dangerous" };
      }

      log.debug(`[tool-safety] ALLOWED ${toolName} (tier: ${result.tier})`);
    } catch (err) {
      log.warn(`[tool-safety] Check failed for ${toolName}: ${err}`);
      // Allow through on error — never degrade agent availability
    }
  });
}
