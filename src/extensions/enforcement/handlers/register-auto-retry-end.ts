/**
 * register-auto-retry-end - Error classification on API retry exhaustion.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onEvent } from "../../../lib/events/event-types.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";
import { classify } from "../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";
import { errorTypeFallback } from "../../../lib/ai/critic-fallbacks.js";

export function registerAutoRetryEndHandler(pi: ExtensionAPI): void {
  onEvent(pi, "auto_retry_end", async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;

    const { success, attempt, finalError } = event;

    if (!success) {
      getState(ctx).validationFailures++;

      const now = Date.now();
      if (now - getState(ctx).lastNudgeTime < getState(ctx).nudgeCooldownMs) return;
      getState(ctx).lastNudgeTime = now;

      const errorType = await classifyRetryError(finalError ?? "", ctx);

      let msg: string;
      if (errorType === "rate_limit") {
        msg = `Rate limit after ${attempt} retry(s). Switch model with /model or wait.`;
      } else if (errorType === "server_error") {
        msg = `Server error after ${attempt} retry(s) (${finalError}). Provider may be overloaded.`;
      } else if (errorType === "network") {
        msg = `Network error after ${attempt} retry(s). Check your connection.`;
      } else if (errorType === "auth") {
        msg = `Auth error after ${attempt} retry(s). Check API keys.`;
      } else {
        msg = `API error after ${attempt} retry(s): ${finalError ?? "unknown"}.`;
      }

      sendEnforcementWhisper(
        pi,
        ctx,
        `## [warn] ${msg}\n\nStore for reference: memory_store(content="API error: ${finalError}", tags=["error", "api"])`,
      );
    }
  });
}

async function classifyRetryError(
  errorMsg: string,
  ctx: ExtensionContext,
): Promise<string> {
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
