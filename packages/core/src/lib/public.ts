/**
 * Public shared export surface for other packages in the pi-braid monorepo
 * (primarily pi-braid-contrib).
 *
 * Backed exclusively by canonical `packages/core/src/lib` modules — there is
 * no duplicate copy to drift. Exposed via the package.json "exports" map as
 * `./lib`.
 */

export { classify } from "./ai/text-classifier.js";
export type {
  ClassifierCriteria,
  ClassificationResult,
  ClassifierOptions,
} from "./ai/text-classifier.js";
export { resolveVisionModel } from "./ai/model-resolver.js";

export { HEALTHCHECK_DIR } from "./config/braid-paths.js";

export { onEvent } from "./events/event-types.js";

export { getExtensionState } from "./state/extension-state.js";
export { SessionPhase, registerSessionStartHandler } from "./state/session-start-queue.js";

// Key-ring feedback (direct LLM-call self-heal): the pi-braid-providers
// extension publishes a ring-feedback handler into a
// process-global slot (see global-state.ts KEY_RING_FEEDBACK_KEY); contrib's
// vision wrapper reads it via this getter to feed direct-call 429/403 back
// into the ring that owns the model. setKeyRingFeedbackHandler is exported for
// tests/registration; production registration happens in providers/index.ts.
export {
  getKeyRingFeedbackHandler,
  setKeyRingFeedbackHandler,
  type KeyRingFeedbackHandler,
} from "./state/global-state.js";

export {
  readGlobalEnabledTools,
  readSettingsFileOutcome,
  writeGlobalEnabledTools,
  type SettingsReadOutcome,
  type SettingsWriteOutcome,
} from "./config/per-tool-settings.js";
