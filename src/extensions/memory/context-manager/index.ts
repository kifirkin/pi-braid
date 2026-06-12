import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";

// ── Context-Manager Extension ──────────────────────────────────────
// Decomposed from 1141L monolith into slim index + 6 handler modules
// + 3 sub-tools in handlers/tools/.
//
// Handlers:
//   shared.ts   - state, helpers, retry logic, navigation
//   compaction.ts - compaction events + retry + smart instructions
//   compaction-retry.ts - turn-end retry reset
//   events.ts   - agent_end retry, auto_retry_end, context pruning
//   navigation.ts - tree navigation + checkout
//   rotation.ts - session rotation + shutdown
//   tools/      - context_compress, context_inspect, context_navigate
//                 (registered inline below)

import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log, getCmState } from "./handlers/shared.js";
import { registerContextInspect } from "./handlers/tools/context-inspect.js";
import { registerContextCompress } from "./handlers/tools/context-compress.js";
import { registerContextNavigate } from "./handlers/tools/context-navigate.js";
import {
  registerBeforeCompactHandler,
  registerSessionCompactHandler,
  registerCompactionEndHandler,
} from "./handlers/compaction.js";
import { registerTurnEndRetryReset } from "./handlers/compaction-retry.js";
import { registerAgentEndRetryHandler, registerAutoRetryEndHandler } from "./handlers/events.js";
import {
  registerBeforeTreeHandler,
  registerTurnEndCheckoutHandler,
  registerAgentEndRetryHandler as registerNavAgentEndRetry,
} from "./handlers/navigation.js";

// NOTE: registerContextPruningHandler DISABLED - the "context" event fires per-streaming-message
// (not pre-compaction). Its return value is ignored by pi. Logic to be migrated to
// session_before_compact handler in compaction.ts where return value is respected.
// import { registerContextPruningHandler } from "./handlers/events.js";
import { registerRotationHandlers, registerSessionShutdownHandler } from "./handlers/rotation.js";

export default function contextManagerExtension(pi: ExtensionAPI): void {
  // ── Session Start ──────────────────────────────────────────────
  registerSessionStartHandler(
    pi,
    SessionPhase.MemoryState,
    async (_event: any, ctx: ExtensionContext) => {
      try {
        // Pruning state is initialized eagerly in getCmState factory
        // Set compaction reserve tokens
        const sm = ctx.sessionManager as {
          globalSettings?: { compaction?: { reserveTokens?: number } };
          save?: () => void;
        };
        if (sm?.globalSettings?.compaction) {
          sm.globalSettings.compaction.reserveTokens = 50_000;
          sm.save?.();
        }
      } catch {
        // Ignore - best effort
      }
    },
  );

  // ── Register tools (3 LLM-callable + 1 TUI command) ─────────
  registerContextInspect(pi);
  registerContextCompress(pi);
  registerContextNavigate(pi);
  pi.registerCommand("context-stats", {
    description: "Show context pruning statistics",
    handler: async (_args: string | undefined, ctx: ExtensionContext) => {
      const stats = getCmState(ctx).pruningState.stats;
      const rules = getCmState(ctx)
        .pruningState.rules.filter((r: { enabled: boolean }) => r.enabled)
        .map((r: { id: string }) => r.id);
      ctx.ui?.notify(
        [
          "Context Pruning Stats:",
          `  Total pruned: ${stats.totalPruned}`,
          `  Total processed: ${stats.totalProcessed}`,
          `  Active rules: ${rules.join(", ") || "none"}`,
          `  Keep recent: ${getCmState(ctx).pruningState.keepRecentCount} messages`,
          `  Prune reasons: ${
            Object.entries(stats.pruneReasons)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ") || "none"
          }`,
        ].join("\n"),
        "info",
      );
    },
  });

  // ── Register handlers from modules ───────────────────────────
  registerBeforeCompactHandler(pi);
  registerSessionCompactHandler(pi);
  registerCompactionEndHandler(pi);
  registerTurnEndRetryReset(pi);
  registerBeforeTreeHandler(pi);
  registerTurnEndCheckoutHandler(pi);
  registerNavAgentEndRetry(pi);
  registerAgentEndRetryHandler(pi);
  registerAutoRetryEndHandler(pi);
  // ⚠️ DISABLED: causes session corruption via concurrent file writes during streaming.
  // registerContextPruningHandler(pi); // ← "context" event return value is ignored by pi
  registerRotationHandlers(pi);
  registerSessionShutdownHandler(pi);

  log.debug("Context-manager extension initialized");
}
