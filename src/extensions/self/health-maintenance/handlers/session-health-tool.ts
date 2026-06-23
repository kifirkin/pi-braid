/**
 * session_health tool - introspection surface for the SessionHealthState.
 *
 * Layer 7 of the session-recovery proposal (2026-06-23). The state itself
 * is owned by the enforcement layer; this tool is the read-and-act surface
 * for the agent and the user.
 *
 * Actions:
 *   - get:      return the current SessionHealthState (read-only)
 *   - diagnose: return the state + the last error + session error counts
 *   - recover:  explicitly transition out of balance/auth/degraded.
 *               The user has topped up, fixed the key, or otherwise
 *               resolved the upstream issue. Clears the error window.
 *
 * Recovery is intentionally explicit — automatic recovery on next LLM
 * success is also wired (via recordLlmSuccess), but for terminal modes
 * (balance, auth) the user must signal they have acted before the agent
 * resumes normal work. This is the only way the agent learns that a
 * balance-topup has actually happened.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getSessionHealth,
  setSessionHealthMode,
  type SessionHealthMode,
  type SessionHealthState,
} from "../../../enforcement/session-health.js";

const sessionHealthSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("get"),
      Type.Literal("diagnose"),
      Type.Literal("recover"),
    ],
    { description: "Action: get (read state) | diagnose (read + history) | recover (force mode reset)" },
  ),
  // recover-only
  mode: Type.Optional(
    Type.String({
      enum: ["healthy", "degraded", "balance", "context_overflow", "auth", "aborted"],
      description: "Target mode for action=recover. Default: healthy.",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description: "Free-text reason for action=recover (logged for audit).",
    }),
  ),
});

interface SessionHealthToolDetails {
  mode: SessionHealthMode;
  state: SessionHealthState;
  action: "get" | "diagnose" | "recover";
  recovered?: boolean;
  error?: string;
}

function formatState(state: SessionHealthState): string {
  const lines: string[] = [];
  lines.push(`## Session health: ${state.mode}`);
  lines.push("");
  lines.push(`- Consecutive errors: ${state.consecutiveErrors}`);
  lines.push(`- Consecutive healthy turns: ${state.consecutiveHealthyTurns}`);
  lines.push(`- Provider successes (session total): ${state.providerSuccessCount}`);
  if (state.modeEnteredAt) {
    const ageMs = Date.now() - state.modeEnteredAt;
    lines.push(`- In current mode for: ${Math.round(ageMs / 1000)}s`);
  }
  if (state.lastError) {
    lines.push("");
    lines.push(`### Last error`);
    lines.push(`- Category: ${state.lastError.category}`);
    lines.push(`- Retryable: ${state.lastError.retryable}`);
    lines.push(`- User action required: ${state.lastError.userActionRequired}`);
    if (state.lastError.userMessage) lines.push(`- User hint: ${state.lastError.userMessage}`);
  }
  return lines.join("\n");
}

function formatCategoryCounts(state: SessionHealthState): string {
  const entries: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(state.providerErrorsByCategory)) {
    if (typeof v === "number" && v > 0) entries.push([k, v]);
  }
  entries.sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "  (none this session)";
  return entries.map(([k, v]) => `  - ${k}: ${v}`).join("\n");
}

export function registerSessionHealthTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "session_health",
    label: "Session Health",
    promptSnippet: "Read or reset session health (LLM provider state)",
    description:
      "Read or reset the session's LLM-provider health state. " +
      "Use action=get to see the current mode, action=diagnose to see mode + error history, " +
      "action=recover to explicitly transition out of balance/auth/degraded after the user has acted " +
      "(e.g., topped up the provider balance). The state is owned by the enforcement layer; this is its " +
      "introspection surface.",
    parameters: sessionHealthSchema,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const action = params.action;
      const state = getSessionHealth(ctx);

      if (action === "get") {
        const details: SessionHealthToolDetails = { mode: state.mode, state, action: "get" };
        return {
          content: [{ type: "text" as const, text: formatState(state) }],
          details,
        };
      }

      if (action === "diagnose") {
        const lines: string[] = [formatState(state), ""];
        lines.push("### Error counts (session total)");
        lines.push(formatCategoryCounts(state));
        const details: SessionHealthToolDetails = { mode: state.mode, state, action: "diagnose" };
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details,
        };
      }

      if (action === "recover") {
        const target = (params.mode ?? "healthy") as SessionHealthMode;
        if (target !== "healthy") {
          // Only allow transition to non-healthy modes if there is a
          // known reason. For now, refuse and tell the user to use
          // recordLlmError via the LLM pathway.
          const details: SessionHealthToolDetails = {
            mode: state.mode,
            state,
            action: "recover",
            error: "invalid_target",
          };
          return {
            content: [
              {
                type: "text" as const,
                text: `action=recover can only target "healthy". For non-healthy target modes, wait for the LLM call pathway to record the relevant error.`,
              },
            ],
            details,
          };
        }
        setSessionHealthMode(ctx, "healthy", params.reason);
        const after = getSessionHealth(ctx);
        const details: SessionHealthToolDetails = {
          mode: after.mode,
          state: after,
          action: "recover",
          recovered: true,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Session health reset to ${after.mode}.\n\nThe next LLM call will either succeed (staying healthy) or fail (re-entering the appropriate mode).${params.reason ? `\n\nReason: ${params.reason}` : ""}`,
            },
          ],
          details,
        };
      }

      const details: SessionHealthToolDetails = {
        mode: state.mode,
        state,
        action: "recover",
        error: "unknown_action",
      };
      return {
        content: [{ type: "text" as const, text: `Unknown action: ${action}. Use get, diagnose, or recover.` }],
        details,
      };
    },
  });
}
