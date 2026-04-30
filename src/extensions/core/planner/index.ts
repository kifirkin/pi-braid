/**
 * @fileoverview Planner extension — goal/plan state management.
 *
 * Tools removed (2026-04-28): plan_with_budget, check_budget, set_budget.
 * Reason: rarely used, verbose output fills context. scratchpad handles task management.
 * Future research: reintegrate as automatic budget tracking via heartbeat.
 *
 * The planner extension still provides goal/plan restoration on session_start
 * via scratchpad integration.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("planner");

// ── Extension ──────────────────────────────────────────────────────────────

export default function plannerExtension(pi: ExtensionAPI) {
  log.info("Planner extension registered (goal/plan state only — no tools)");
}
