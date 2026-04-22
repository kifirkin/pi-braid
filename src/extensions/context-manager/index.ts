// ── Context-Manager Extension ─────────────────────────────────────────────────
// Decomposed from 1141L monolith into 4 handler modules + slim index.
//
// Handlers:
//   shared.ts   — state, helpers, retry logic, navigation
//   tools.ts    — 6 tool registrations + 1 command
//   compaction.ts — compaction events + retry + smart instructions
//   navigation.ts — tree navigation + checkout
//   events.ts   — agent_end retry, auto_retry_end, context pruning

import { Type } from "typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { log } from "./handlers/shared.js";
import { registerTools } from "./handlers/tools.js";
import { registerBeforeCompactHandler, registerSessionCompactHandler, registerCompactionEndHandler, registerTurnEndRetryReset } from "./handlers/compaction.js";
import { registerBeforeTreeHandler, registerTurnEndCheckoutHandler, registerAgentEndRetryHandler as registerNavAgentEndRetry } from "./handlers/navigation.js";
import { registerAgentEndRetryHandler, registerAutoRetryEndHandler, registerContextPruningHandler } from "./handlers/events.js";
import { registerRotationHandlers } from "./handlers/rotation.js";

export default function contextManagerExtension(pi: any): void {
	// ── Session Start ──────────────────────────────────────────────────────
	pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
		try {
			// Pruning state is initialized eagerly in getCmState factory
			// Set compaction reserve tokens
			const sm = ctx.sessionManager as { globalSettings?: { compaction?: { reserveTokens?: number } }; save?: () => void };
			if (sm?.globalSettings?.compaction) {
				sm.globalSettings.compaction.reserveTokens = 50_000;
				sm.save?.();
			}
		} catch { /* non-fatal: reserve tokens */ }
	});

	// ── Register handlers from modules ─────────────────────────────────────
	registerTools(pi);
	registerBeforeCompactHandler(pi);
	registerSessionCompactHandler(pi);
	registerCompactionEndHandler(pi);
	registerTurnEndRetryReset(pi);
	registerBeforeTreeHandler(pi);
	registerTurnEndCheckoutHandler(pi);
	registerNavAgentEndRetry(pi);
	registerAgentEndRetryHandler(pi);
	registerAutoRetryEndHandler(pi);
	registerContextPruningHandler(pi);
	registerRotationHandlers(pi);

	log.debug("Context-manager extension initialized");
}
