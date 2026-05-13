import { createLogger } from "../../../lib/logger.js";

const log = createLogger("enforcement");
/**
 * Tool registrations — enforcement commands.
 * All commands removed (2026-04-28): enforcement-stats, enforcement-on, enforcement-off.
 * Enforcement operates via event handlers and whispers only.
 */
