// ── Context-Manager Tools Registry ───────────────────────────────────────────
// Thin orchestrator that imports and registers all individual tools.
// Each tool is implemented in tools/<tool-name>.ts for independent testing.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextInspect } from "./tools/context-inspect.js";
import { registerContextCompress } from "./tools/context-compress.js";
import { registerContextNavigate } from "./tools/context-navigate.js";
import { log, getCmState } from "./shared.js";

export function registerTools(pi: ExtensionAPI): void {
  registerContextInspect(pi);
  registerContextCompress(pi);
  registerContextNavigate(pi);

  // ── context-stats Command ───────────────────────────────────────────
  pi.registerCommand("context-stats", {
    description: "Show context pruning statistics",
    handler: async (_args: string | undefined, ctx: any) => {
      const stats = getCmState(ctx).pruningState.stats;
      const rules = getCmState(ctx)
        .pruningState.rules.filter((r: any) => r.enabled)
        .map((r: any) => r.id);
      ctx.ui.notify(
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
}
