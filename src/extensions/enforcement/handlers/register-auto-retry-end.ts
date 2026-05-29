/**
 * register-auto-retry-end — Error classification on API retry exhaustion.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onEvent } from "../../../lib/events/event-types.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";

export function registerAutoRetryEndHandler(pi: ExtensionAPI): void {
  onEvent(pi, "auto_retry_end", async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;

    const { success, attempt, finalError } = event;

    if (!success) {
      getState(ctx).validationFailures++;

      const now = Date.now();
      if (now - getState(ctx).lastNudgeTime < getState(ctx).nudgeCooldownMs) return;
      getState(ctx).lastNudgeTime = now;

      const errorType = classifyRetryError(finalError ?? "");

      let msg: string;
      if (errorType === "rate_limit") {
        msg = `Rate limit after ${attempt} retry(s). Switch model with /model or wait.`;
      } else if (errorType === "server_error") {
        msg = `Server error after ${attempt} retry(s) (${finalError}). Provider may be overloaded.`;
      } else if (errorType === "network") {
        msg = `Network error after ${attempt} retry(s). Check your connection.`;
      } else {
        msg = `API error after ${attempt} retry(s): ${finalError ?? "unknown"}.`;
      }

      sendEnforcementWhisper(
        pi,
        ctx,
        `## ⚠️ ${msg}\n\nStore for reference: memory_store(content="API error: ${finalError}", tags=["error", "api"])`,
      );
    }
  });
}

function classifyRetryError(
  errorMsg: string,
): "rate_limit" | "server_error" | "network" | "unknown" {
  if (/429|rate.?limit/i.test(errorMsg)) return "rate_limit";
  if (/5\d\d|server.?error|internal|overloaded|unavailable/i.test(errorMsg)) return "server_error";
  if (/network|connection|fetch failed|socket|timeout|timed out/i.test(errorMsg)) return "network";
  return "unknown";
}
