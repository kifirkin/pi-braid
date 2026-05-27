// ── Context-Manager Tools Registry ───────────────────────────────────────────
// Thin orchestrator that imports and registers all individual tools.
// Each tool is implemented in tools/<tool-name>.ts for independent testing.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerContextTag } from "./tools/context-tag.js";
import { registerContextLog } from "./tools/context-log.js";
import { registerContextCheckout } from "./tools/context-checkout.js";
import { registerContextPrune } from "./tools/context-prune.js";
import { registerContextAudit } from "./tools/context-audit.js";
import { registerContextSnapshot } from "./tools/context-snapshot.js";
import { registerContextCompact } from "./tools/context-compact.js";
import { registerContextArchive } from "./tools/context-archive.js";
import { log, getCmState } from "./shared.js";

export function registerTools(pi: ExtensionAPI): void {
  registerContextTag(pi);
  registerContextLog(pi);
  registerContextCheckout(pi);
  registerContextPrune(pi);
  registerContextAudit(pi);
  registerContextSnapshot(pi);
  registerContextCompact(pi);
  registerContextArchive(pi);

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
