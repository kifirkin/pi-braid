/**
 * pi-ai Models Instance Initialization
 *
 * Creates and holds the process-global pi-ai `Models` instance, replacing
 * the deprecated `@earendil-works/pi-ai/compat` import path.
 *
 * ## Migration path
 *
 * pi-ai v0.80 moved `completeSimple` from the top-level export to the
 * `/compat` subpath (deprecated). The forward-looking API is:
 *
 *   import { createModels } from "@earendil-works/pi-ai";
 *   const models = createModels();
 *   const result = await models.completeSimple(model, context, options);
 *
 * ## Current state
 *
 * - `llm-call.ts` still imports from `@earendil-works/pi-ai/compat` (the
 *   deprecated compat subpath). This module provides the `Models` instance
 *   that will replace that import when the compat subpath is removed.
 * - The pi-core runtime (pi-coding-agent) has its own nested pi-ai v0.77.0
 *   dependency. Braid's pi-ai v0.80.2 dependency is in the outer node_modules.
 * - When pi-core updates to pi-ai v0.80+, the nested copy will be v0.80.x
 *   and the `Models` interface will be the canonical path for all callers.
 *
 * ## Usage
 *
 *   import { initModels, getModels } from "./models-init.js";
 *   await initModels();  // Call once at startup
 *   const models = getModels();  // Returns the Models instance, or null
 *
 * @packageDocumentation
 */

import { createModels } from "@earendil-works/pi-ai";
import { getModelsInstance, setModelsInstance } from "../state/global-state.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("models-init");

/**
 * Initialize the pi-ai Models instance.
 * Called once at extension startup. Safe to call multiple times —
 * subsequent calls are no-ops.
 */
export async function initModels(): Promise<void> {
  if (getModelsInstance()) {
    log.debug("Models instance already initialized, skipping");
    return;
  }

  try {
    const models = createModels();
    setModelsInstance(models);
    log.info("pi-ai Models instance created");
  } catch (err) {
    log.error("Failed to create pi-ai Models instance:", err);
  }
}

/**
 * Get the initialized pi-ai Models instance.
 * Returns null if initModels() has not been called or failed.
 * Caller casts to the pi-ai Models type when needed.
 */
export function getModels(): unknown {
  return getModelsInstance();
}