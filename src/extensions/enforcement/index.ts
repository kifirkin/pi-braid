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
import { NudgeManager } from "./nudge-manager.js";
import { registerHandlers } from "./handler-registry.js";

const log = createLogger("enforcement");

export { enforcementSignals, determineContrastMode } from "./signals.js";

import { createLogger } from "../../lib/core/logger.js";

export default function enforcementExtension(pi: ExtensionAPI) {
  const nudgeManager = new NudgeManager();

  registerHandlers(pi, nudgeManager);

  log.info("Enforcement extension registered.");
}
