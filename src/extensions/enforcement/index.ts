/**
 * Enforcement Extension - Smart Nudge Delivery with Semantic Interrupts
 *
 * Wiring file: registers all event handlers via handler-registry.ts.
 * The actual handler implementations are in:
 *   - handler-registry.ts   (all pi.on() registrations)
 *   - handlers/             (per-handler logic: blocking, tool-tracker, etc.)
 *   - detection/            (malformed, verification, dangerous tool detection)
 *   - similarity.ts         (text similarity for redundancy detection)
 *   - signals.ts            (L1 enforcement signals + RepE contrast mode)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerHandlers } from "./handler-registry.js";

const log = createLogger("enforcement");

export { enforcementSignals, determineContrastMode, pruneSignals } from "./signals.js";

import { createLogger } from "../../lib/core/logger.js";

export default function enforcementExtension(pi: ExtensionAPI) {
  // NudgeManager is now per-session via getNudgeManager(ctx). Handlers
  // retrieve the real instance via ctx.
  registerHandlers(pi);

  log.info("Enforcement extension registered.");
}
