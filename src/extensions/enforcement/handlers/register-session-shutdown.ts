/**
 * register-session-shutdown — State cleanup on session end.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onEvent } from "../../../lib/events/event-types.js";
import { getState, resetState } from "../state.js";
import { resetAdviceTracker } from "../../../lib/reasoning/advice-tracker.js";
import { shutdownAsyncStorage } from "../../../lib/state/async-storage.js";
import { clearVerifierState } from "../../../lib/store/bidirectional-verifier.js";
import { createLogger } from "../../../lib/core/logger.js";
import { SESSION_SHUTDOWN } from "../../../lib/core/event-names.js";

const log = createLogger("enforcement:session-shutdown");

export function registerSessionShutdownHandler(pi: ExtensionAPI): void {
  onEvent(pi, SESSION_SHUTDOWN, async (_event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);
    const sessionId = ctx.cwd ?? "default";

    log.info(
      `[session_shutdown] Session ${sessionId}: ` +
        `${state.totalToolCalls} tool calls, ${state.uniqueToolsUsed.size} unique tools, ` +
        `${state.verificationsDone} verifications, ${state.validationFailures} failures`,
    );

    // Flush pending async writes and clear cross-session state
    await shutdownAsyncStorage();
    clearVerifierState(ctx);
    resetAdviceTracker();
    resetState(getState(ctx));
    log.info(`[session_shutdown] Enforcement state reset for session ${sessionId}`);
  });
}
