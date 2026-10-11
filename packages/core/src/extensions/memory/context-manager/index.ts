// Decomposed from 1141L monolith into slim index + 6 handler modules
// + 3 sub-tools in handlers/tools/.
//
// Handlers:
//   shared.ts   - state, helpers, retry logic, navigation
//   compaction.ts - compaction events + retry + smart instructions
//   compaction-retry.ts - turn-end retry reset
//   events.ts   - agent_end API-error guidance, context pruning
//   navigation.ts - tree navigation + checkout
//   rotation.ts - session rotation + shutdown
//   tools/      - context_compress, context_inspect, context_navigate
//                 (registered inline below)

import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log, getCmState } from "./handlers/shared.js";
import { registerContextInspect } from "./handlers/tools/context-inspect.js";
import { registerContextCompress } from "./handlers/tools/context-compress.js";
import { registerContextNavigate } from "./handlers/tools/context-navigate.js";
import { registerOffloadRecover } from "./handlers/tools/offload-recover.js";
import {
  registerBeforeCompactHandler,
  registerSessionCompactHandler,
  registerSessionCompactOutcomeHandler,
  registerSessionCompactFailedHandler,
} from "./handlers/compaction.js";
import { registerTurnEndRetryReset } from "./handlers/compaction-retry.js";
import {
  registerAgentEndRetryHandler,
  registerAgentEndApiErrorHandler,
} from "./handlers/events.js";
import {
  registerBeforeTreeHandler,
  registerTurnEndCheckoutHandler,
  registerAgentEndRetryHandler as registerNavAgentEndRetry,
} from "./handlers/navigation.js";

// registerContextPruningHandler stays disabled: the `context` event fires
// per-streaming-message, not pre-compaction, so its return value never feeds
// a compaction prep. handlers/offload.ts ALSO registers a `context` handler —
// that is NOT a revival of this disabled path: the offloader is a setting-gated
// (default OFF) per-request substitution whose return value IS applied by the
// installed pi-core (verified against node_modules 0.82.1 runner.js emitContext
// + agent-loop.js transformContext).
import { registerRotationHandlers, registerSessionShutdownHandler } from "./handlers/rotation.js";
import { registerStaleToolResultOffloader } from "./handlers/offload.js";
import { registerContextEmergencyOffloader } from "./handlers/context-emergency.js";
import { registerToolResultCaptureCap } from "./handlers/toolresult-capture-cap.js";

export default function contextManagerExtension(pi: ExtensionAPI): void {
  // Compaction reserve: owned by applyCompactionReserveTokens in the polyfill
  // plumb hooks, which derives it from braid.context.contextLimitTokens. A
  // fixed reserve written here would re-anchor pi-core's threshold compaction
  // trigger to an arbitrary share of the window - do not add a second writer.

  // Register tools (4 LLM-callable + 1 TUI command)
  registerContextInspect(pi);
  registerContextCompress(pi);
  registerContextNavigate(pi);
  registerOffloadRecover(pi);
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

  registerBeforeCompactHandler(pi);
  registerSessionCompactHandler(pi);
  // Outcome stage is a deliberately separate session_compact handler (verify
  // + telemetry + originals archive); the parking stage above owns the
  // intercept lifecycle. Failure routing rides session_compact_failed.
  registerSessionCompactOutcomeHandler(pi);
  registerSessionCompactFailedHandler(pi);
  registerTurnEndRetryReset(pi);
  registerBeforeTreeHandler(pi);
  registerTurnEndCheckoutHandler(pi);
  registerNavAgentEndRetry(pi);
  registerAgentEndRetryHandler(pi);
  registerAgentEndApiErrorHandler(pi);
  // [warn] DISABLED: causes session corruption via concurrent file writes during streaming.
  // registerContextPruningHandler(pi); // <- "context" event return value is ignored by pi
  registerStaleToolResultOffloader(pi); // Setting-gated (default OFF) - no-op unless opted in
  // Emergency 413 offloader (default ON) — publishes the runner
  // into the process-global slot and registers the per-request stub handler.
  registerContextEmergencyOffloader(pi);
  // Capture-time toolResult size cap (default ON) — oversized
  // results are flushed to disk BEFORE they enter the session.
  registerToolResultCaptureCap(pi);
  registerRotationHandlers(pi);
  registerSessionShutdownHandler(pi);

  log.debug("Context-manager extension initialized");
}
