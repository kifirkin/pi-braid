/**
 * Agent Patch — Runtime fix for Agent.handleRunFailure
 *
 * **Bug**: `Agent.handleRunFailure()` in pi-agent-core emits `agent_end` directly
 * without emitting `message_start`/`message_end`. Since session persistence in
 * agent-session.ts only triggers on `message_end`, the synthetic error assistant
 * message is never written to the session file. This causes:
 *
 * 1. Lost assistant responses after API errors (timeout, rate limit, etc.)
 * 2. Auto-retry chains that accumulate __retry_state entries with zero persisted
 *    assistant messages
 * 3. Working indicator stopping without restarting (because retries create new
 *    agent loops that fail the same way)
 *
 * **Fix**: Patch `Agent.prototype.handleRunFailure` to emit the full message
 * lifecycle (`message_start` → `message_end`) before `agent_end`, matching what
 * `streamAssistantResponse` does for normal assistant messages.
 *
 * This file must be loaded early (before Agent is used). It's registered as a
 * core extension so it runs at module load time.
 *
 * **Upstream**: This patch can be removed once pi-agent-core ships a proper fix.
 * Issue: handleRunFailure doesn't emit message_start/message_end — bypassing
 * session persistence.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("agent-patch");

/**
 * Apply patch unconditionally — it's idempotent.
 *
 * Original bug: Agent.handleRunFailure emits agent_end without message_start/message_end,
 * skipping session persistence. Patch emits the full message lifecycle.
 *
 * Version gate was removed (was inverted — [0,0,0] always matched so patch never applied).
 * Patch is harmless to apply multiple times (just replaces the method).
 * When upstream fixes the issue, we can remove this file, but until then it must apply.
 */
function applyPatch(): boolean {
  try {
    const proto = Agent.prototype as unknown as Record<string, unknown>;
    if (!proto) {
      log.warn("Agent class not found — patch skipped");
      return false;
    }

    const original: ((this: any, error: unknown, aborted: boolean) => Promise<void>) | undefined =
      proto.handleRunFailure as typeof original | undefined;
    if (!original) {
      log.warn("handleRunFailure not found on Agent.prototype — patch skipped");
      return false;
    }

    proto.handleRunFailure = async function (
      this: {
        _state: {
          model: { api: string; provider: string; id: string };
          messages: unknown[];
          errorMessage?: string;
        };
        processEvents: (event: Record<string, unknown>) => Promise<void>;
      },
      error: unknown,
      aborted: boolean,
    ): Promise<void> {
      const failureMessage = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "" }] as const,
        api: this._state.model.api,
        provider: this._state.model.provider,
        model: this._state.model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: aborted ? ("aborted" as const) : ("error" as const),
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      this._state.errorMessage = failureMessage.errorMessage;

      // Emit message_start (spread copy matches streamAssistantResponse pattern)
      await this.processEvents({
        type: "message_start",
        message: { ...failureMessage },
      });
      // Emit message_end — processEvents pushes to state.messages
      await this.processEvents({
        type: "message_end",
        message: failureMessage,
      });
      // Emit agent_end as before
      await this.processEvents({
        type: "agent_end",
        messages: [failureMessage],
      });
    };

    log.info("Applied Agent.handleRunFailure patch (message_end persistence fix)");
    return true;
  } catch (err) {
    log.warn(`Failed to apply Agent.handleRunFailure patch: ${err}`);
    return false;
  }
}

// ── Extension Factory ────────────────────────────────────────────────────────

export default async function agentPatchExtension(_pi: ExtensionAPI): Promise<void> {
  // Apply the patch synchronously at extension load time.
  // This runs before any agent loops start, so the patched
  // handleRunFailure is in place for the entire session.
  applyPatch();
}
