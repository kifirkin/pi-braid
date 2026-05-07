/**
 * Retry Extension — /retry command + error capture.
 *
 * Persists last user message via session custom entries (survives restart/resume),
 * provides manual /retry with error context display, and injects error info as
 * custom_message when handleRunFailure bypasses message_end (session persistence fix).
 *
 * NOTE: Auto-retry was removed (Dec 2025). It created agent loops that fail
 * identically on persistent API errors, cascading into working indicator hangs
 * and lost messages. pi's built-in retry (in agent-session.ts) covers the same
 * transient errors. This extension is purely passive: state + /retry command.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  AgentEndEvent,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";

import { createLogger } from "../../../lib/logger.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/session-start-queue.js";

import { classifyRetryError } from "./types.js";
import {
  getState,
  recoverState,
  captureUserInput,
  recordAgentEnd,
  continueRetry,
} from "./state.js";

const log = createLogger("retry");

// ── Extension Factory ────────────────────────────────────────────────────────

export default async function retryExtension(pi: ExtensionAPI): Promise<void> {
  // ── Events ───────────────────────────────────────────────────────────

  // Recover persisted retry state on session start
  registerSessionStartHandler(pi, SessionPhase.MemoryState, async (_event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
    recoverState(ctx.sessionManager, ctx);
    const state = getState(ctx);
    if (state.lastUserMessage)
      log.info(`Recovered retry state: "${truncate(state.lastUserMessage.text, 60)}"`);
  });

  // Capture user input for potential retry (skip commands and shell invocations)
  pi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
    if (event.text.startsWith("/") || event.text.startsWith("!")) return;
    captureUserInput(pi, event.text, event.images as any, undefined, ctx);
  });

  // tool_end no longer needs to capture failed tool name — /retry sends
  // a minimal steer regardless of which tool failed.

  // Detect errors on agent_end, record turn result, inject error custom_message
  pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
    const messages = (event as any).messages as any[];
    if (!messages || messages.length === 0) return;

    // Fallback capture of last user message (only if `input` event was missed)
    let lastUserMsg: any = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserMsg = messages[i];
        break;
      }
    }
    if (lastUserMsg && !getState(ctx).lastUserMessage) {
      const text =
        typeof lastUserMsg.content === "string"
          ? lastUserMsg.content
          : (lastUserMsg.content?.find((c: any) => c.type === "text" && c.text)?.text ?? "");
      const imgs = Array.isArray(lastUserMsg.content)
        ? lastUserMsg.content.filter((c: any) => c.type === "image")
        : undefined;
      if (text) captureUserInput(pi, text, imgs, lastUserMsg.id ?? null, ctx);
    }

    // Detect error from tool results (Priority 1) or assistant text (Priority 2)
    let errorMsg: string | null = null;
    for (const msg of messages) {
      if (msg.role === "tool" && msg.isError) {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : (msg.content?.find((c: any) => c.type === "text" && c.text)?.text ?? "");
        if (text) {
          errorMsg = text;
          break;
        }
      }
    }
    if (!errorMsg) {
      // Only check assistant content if stopReason indicates an error
      // This prevents false positives from natural conversation containing "error" or "context"
      const assistantMsg = messages.find((m: any) => m.role === "assistant");
      const stopReason = (assistantMsg as any)?.stopReason;
      if (stopReason === "error" || stopReason === "aborted") {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") {
            const text =
              typeof messages[i].content === "string"
                ? messages[i].content
                : (messages[i].content?.find((c: any) => c.type === "text" && c.text)?.text ?? "");
            if (text && classifyRetryError(text, null).category !== "unknown") {
              errorMsg = text;
              break;
            }
          }
        }
      }
    }

    // Detect mid-chain: assistant/tool messages after the last user message?
    let hasPostUserAssistantMsgs = false;
    if (lastUserMsg) {
      const lastUserIdx = messages.lastIndexOf(lastUserMsg);
      for (let i = lastUserIdx + 1; i < messages.length; i++) {
        if (messages[i].role === "assistant" || messages[i].role === "tool") {
          hasPostUserAssistantMsgs = true;
          break;
        }
      }
    }

    // Detect if the error message was created by Agent.handleRunFailure() which
    // skips message_start/message_end. These messages have empty content text
    // because the actual error is in the `errorMessage` field. When handleRunFailure
    // bypasses message_end, the message is NOT persisted to the session file.
    // We inject a custom_message so the error info survives session reloads.
    const isHandleRunFailureBypass =
      errorMsg &&
      messages.some((m: any) => {
        if (m.role !== "assistant" || m.stopReason !== "error") return false;
        const c = m.content;
        if (!Array.isArray(c)) return !c;
        // Empty content = handleRunFailure created it (error is in errorMessage)
        return c.every((b: any) => b.type === "text" && !b.text);
      });

    recordAgentEnd(
      pi,
      lastUserMsg?.id ?? null,
      errorMsg !== null,
      errorMsg,
      null,
      hasPostUserAssistantMsgs,
      ctx,
    );
    // ── handleRunFailure workaround ─────────────────────────────────
    // When handleRunFailure creates the error, agent is still streaming
    // (isStreaming=true). We can't call sendMessage() until finishRun()
    // completes. Use setTimeout(0) to defer to the NEXT macrotask, which
    // fires after finishRun() sets isStreaming=false.
    if (isHandleRunFailureBypass) {
      setTimeout(() => {
        try {
          const assistantMsg = messages.find((m: any) => m.stopReason === "error");
          const errText = assistantMsg?.errorMessage || errorMsg || "Unknown error";
          (ctx as any).sendMessage({
            customType: "__agent_error",
            content: [{ type: "text" as const, text: `[Agent error: ${errText}]` }],
            display: true,
            details: { _braidInjected: true, _braidSource: "retry/error-persist" },
          });
          log.info(`Persisted handleRunFailure error as custom_message: ${truncate(errText, 80)}`);
        } catch {
          // Best-effort — agent may have been shut down
        }
      }, 0);
    }
  });

  // Capture HTTP status codes from provider responses
  pi.on("after_provider_response", (event: any, ctx: ExtensionContext) => {
    if (event.status >= 400) {
      const state = getState(ctx);
      if (state.lastError) state.lastError.httpStatus = event.status;
    }
  });

  // ── Command: /retry ─────────────────────────────────────────────────

  pi.registerCommand("retry", {
    description: "Retry the last turn as a steer continuation.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = getState(ctx);

      if (!state.lastUserMessage) {
        ctx.ui.notify?.("Nothing to retry — no previous user message found.", "warning");
        return;
      }

      ctx.ui.notify?.(`Retrying: "${truncate(state.lastUserMessage.text, 100)}"`, "info");

      if (state.lastError) {
        const age = Math.round((Date.now() - state.lastError.timestamp) / 1000);
        const hints: Record<string, string> = {
          quota_exceeded: "add API keys or switch providers",
          auth_error: "check API keys",
          transient: "should work on retry",
          context_overflow: "conversation too long — compaction may help",
        };
        const hint = hints[state.lastError.category] ? ` (${hints[state.lastError.category]})` : "";
        ctx.ui.notify?.(
          `Error (${age}s ago): [${state.lastError.category}] ${truncate(state.lastError.message, 100)}${hint}`,
          state.lastError.category === "transient" ? "info" : "warning",
        );
      }
      if (state.failureCount > 0) {
        ctx.ui.notify?.(`Retry attempt #${state.failureCount + 1} for this turn.`, "info");
      }

      // Staleness check — don't retry messages older than 10 minutes
      if (state.lastUserMessage) {
        const lastTurnTs = state.lastTurn?.timestamp ?? 0;
        const lastErrorTs = state.lastError?.timestamp ?? 0;
        const lastActivity = Math.max(lastTurnTs, lastErrorTs);
        if (lastActivity > 0 && Date.now() - lastActivity > 10 * 60 * 1000) {
          ctx.ui.notify?.("Last message is too old (>10 min) to retry safely.", "warning");
          return;
        }
      }

      // Ensure agent is idle before sending (with timeout guard)
      try {
        if (!ctx.isIdle()) {
          await ctx.abort();
          await new Promise((r) => setTimeout(r, 100));
          await Promise.race([
            ctx.waitForIdle(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("waitForIdle timeout")), 10000),
            ),
          ]);
        }
      } catch {
        /* best-effort */
      }

      try {
        if (!(await continueRetry(pi, ctx))) {
          ctx.ui.notify?.("Retry failed — no message to send.", "error");
          return;
        }
        ctx.ui.notify?.("Retrying last turn.", "info");
      } catch (sendErr) {
        log.error(`Retry send failed: ${(sendErr as Error).message}`);
        ctx.ui.notify?.(`Retry failed: ${(sendErr as Error).message}`, "error");
      }
    },
  });

  // ── Command: /retry-status (debugging) ─────────────────────────────

  pi.registerCommand("retry-status", {
    description: "Show current retry state.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = getState(ctx);
      const parts: string[] = [];
      if (state.lastUserMessage) {
        parts.push(`Last message: "${truncate(state.lastUserMessage.text, 80)}"`);
        if (state.lastUserMessage.images?.length)
          parts.push(`  Images: ${state.lastUserMessage.images.length}`);
      } else {
        parts.push("No last message captured.");
      }
      if (state.lastError) {
        const age = Math.round((Date.now() - state.lastError.timestamp) / 1000);
        parts.push(
          `Last error (${age}s ago): [${state.lastError.category}] ${truncate(state.lastError.message, 120)}`,
        );
      } else {
        parts.push("No last error.");
      }
      if (state.lastTurn)
        parts.push(
          `Last turn: ${state.lastTurn.hadError ? "FAILED" : "OK"} — entry: ${state.lastTurn.entryId}`,
        );
      parts.push(`Failures: ${state.failureCount}`);
      parts.push(`Version: ${state.version}`);
      ctx.ui.notify?.(parts.join("\n"), "info");
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(s: string, maxLen: number): string {
  if (!s) return "";
  return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}
