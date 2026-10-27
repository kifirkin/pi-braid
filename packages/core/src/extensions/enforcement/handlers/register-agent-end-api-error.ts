// register-agent-end-api-error - Error classification when the run ends
// with an API error.
//
// pi-core 0.85.1 has no auto_retry_end extension event: when the provider
// keeps erroring past the auto-retry budget, the agent run simply ends with
// the last assistant message stopReason "error". Register on agent_end and
// classify the final error for the whisper.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENT_END } from "../../../lib/core/event-names.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";
import { classify } from "../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";
import { errorTypeFallback } from "../../../lib/ai/critic-fallbacks.js";
import { classifyLlmError } from "../../../lib/errors/llm-error.js";
import { recordRouteFailure } from "../session-health.js";

export function registerAgentEndApiErrorHandler(pi: ExtensionAPI): void {
  pi.on(AGENT_END, async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;

    const messages: any[] = event?.messages ?? [];
    let lastAssistant: any = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") {
        lastAssistant = messages[i];
        break;
      }
    }
    if (!lastAssistant || lastAssistant.stopReason !== "error") return;

    const finalError: string = lastAssistant.errorMessage ?? "Unknown error";

    getState(ctx).validationFailures++;

    // Count the failure for the route-failure latch BEFORE the nudge cooldown
    // below: the cooldown throttles the message, not the observation. A run
    // that ends on a provider error is the only evidence the latch has, and
    // the auxiliary calls classifyRetryError makes are excluded from it by
    // design (they are what releases the latch, never what feeds it).
    try {
      recordRouteFailure(ctx, classifyLlmError(finalError).category);
    } catch {
      // A broken counter must never suppress the nudge.
    }

    const now = Date.now();
    if (now - getState(ctx).lastNudgeTime < getState(ctx).nudgeCooldownMs) return;
    getState(ctx).lastNudgeTime = now;

    const errorType = await classifyRetryError(finalError, ctx);

    let msg: string;
    if (errorType === "rate_limit") {
      msg = `Rate limit ended the run. Switch model with /model or wait.`;
    } else if (errorType === "server_error") {
      msg = `Server error ended the run (${finalError}). Provider may be overloaded.`;
    } else if (errorType === "network") {
      msg = `Network error ended the run. Check your connection.`;
    } else if (errorType === "auth") {
      msg = `Auth error ended the run. Check API keys.`;
    } else {
      msg = `API error ended the run: ${finalError}.`;
    }

    // The run already ended on the error: park the guidance for the next
    // prompt instead of forcing a continuation turn.
    sendEnforcementWhisper(
      pi,
      ctx,
      `## [warn] ${msg}\n\nStore for reference: memory_store(content="API error: ${finalError}", tags=["error", "api"])`,
      false,
      { delivery: "park" },
    );
  });
}

async function classifyRetryError(errorMsg: string, ctx: ExtensionContext): Promise<string> {
  try {
    const result = await classify(
      ctx,
      CRITICS.errorType.criteria,
      { errorMsg },
      {
        timeoutMs: 60_000,
        label: CRITICS.errorType.label,
        fallback: () => errorTypeFallback(errorMsg),
      },
    );
    return result.label;
  } catch {
    return errorTypeFallback(errorMsg);
  }
}
