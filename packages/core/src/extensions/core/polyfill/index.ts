/**
 * Polyfill Extension - Patches missing API methods on ExtensionContext
 *
 * Three concerns:
 * 1. Model selection: /utility-model (the merged role) opens the
 *    ModelSelectorComponent UI; /max-power-model is a deprecated alias of it
 *    and /vision-model is a deprecated alias kept for one release. Model
 *    resolution is handled by src/lib/ai/model-resolver.ts (used by
 *    vision/metacognition tools directly).
 * 2. Session manager patches: context_navigate and context_compress tools
 *    need SessionManager methods in --no-session mode.
 * 3. Context window plumb: the session model reports braid's configured
 *    window (braid.context.contextLimitTokens) so pi-core's own threshold
 *    compaction fires before the configured cap; no-op when unset. Applied
 *    on session_start (startup, resume, fork, and /reload - pi-core emits
 *    session_start with reason "reload" after rebuilding the runner),
 *    re-applied at before_agent_start, and re-applied on model_select — a
 *    mid-session switch (rotation, /model, cycle) installs a fresh catalog
 *    object carrying the PROVIDER window, and before_agent_start alone left
 *    that window in force for the remainder of the current run. All three
 *    points also re-derive the reserve that window implies
 *    (applyCompactionReserveTokens); the derivation cannot be written into
 *    pi-core from an extension, so it surfaces as a once-per-process warning
 *    naming the value to set.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { ModelSelectorComponent, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import {
  resolveUtilityModel,
  resolveVisionModel,
  normaliseRoleSetting,
} from "../../../lib/ai/model-resolver.js";
import {
  applyCompactionReserveTokens,
  applyConfiguredContextWindow,
} from "../../../lib/config/braid-settings.js";
import { onEvent } from "../../../lib/events/event-types.js";
import { SESSION_START, SESSION_SHUTDOWN } from "../../../lib/core/event-names.js";
import { registerSessionCleanup } from "../../../lib/state/extension-state.js";
import { readSettingsFile, updateSettings } from "../../../lib/config/per-tool-settings.js";
import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("polyfill");

/** Custom settings keys managed by the model commands */
import {
  getCustomModelKey,
  getCustomModelKeys,
  consumeMaxPowerDeprecationNotice,
  UTILITY_MODEL_KEY,
  VISION_MODEL_KEY,
  MAX_POWER_MODEL_KEY,
} from "../../../lib/state/global-state.js";
import type { CustomModelKeyValue } from "../../../lib/state/global-state.js";

interface SessionManagerLike {
  getSessionFile(): string | null;
  getSessionDir(): string;
  getSessionId(): string;
  getHistory(): unknown[];
  getContext(): unknown;
  getTurnCount(): number;
  setTurnCount(n: number): void;
  // Session tree management methods (may not exist on all versions)
  getBranch?(sessionId?: string): unknown;
  getLeafId?(): string;
  getTree?(): unknown;
  getLabel?(nodeId?: string): string | null;
  setLabel?(nodeId: string, label: string): void;
  getChildren?(nodeId: string): unknown[];
  branchWithSummary?(label?: string): string;
  navigateTree?(targetId: string): void;
  abort?(reason?: string): void;
  getContextUsage?(): unknown;
}

// Type guard for checking if a model has image input capability
function hasImageInput(model: { input?: unknown }): boolean {
  const input = model.input;
  return Array.isArray(input) && (input as unknown[]).includes("image");
}

/** Shared sessionManager reference - used by patchSessionManagerMethods */
import { getExtensionState } from "../../../lib/state/extension-state.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function getPolyfillState(ctx?: ExtensionContext): { sessionManager: unknown } {
  if (ctx) return getExtensionState(ctx, "polyfill", () => ({ sessionManager: undefined }));
  return { sessionManager: undefined };
}

/** The on-disk form of an ordered pattern list: a single entry stays a scalar. */
function toRoleSettingValue(patterns: string[]): CustomModelKeyValue | undefined {
  if (patterns.length === 0) return undefined;
  return patterns.length === 1 ? patterns[0] : patterns;
}

/** Split a command argument into patterns: comma-separated, trimmed. */
function parseRolePatterns(text: string): string[] {
  return text
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

/** The configured patterns of a role setting, in order; empty when unset. */
function configuredRolePatterns(key: string): string[] {
  return normaliseRoleSetting(getCustomModelKey(key));
}

/**
 * Apply a /<role>-model argument: one model pattern, or a comma-separated
 * ordered list. Every pattern must resolve to a catalog model before anything
 * is written, so a typo cannot silently drop a candidate from the fallback
 * order.
 */
async function setRoleSettingFromArgs(
  ctx: ExtensionCommandContext,
  key: string,
  roleLabel: string,
  note: string,
  argsText: string,
): Promise<void> {
  const patterns = parseRolePatterns(argsText);
  if (patterns.length === 0) {
    ctx.ui.notify(`No model pattern in: ${argsText}`, "error");
    return;
  }
  const resolved: Model<Api>[] = [];
  for (const pattern of patterns) {
    const model = resolveModelPattern(ctx, pattern);
    if (!model) {
      ctx.ui.notify(`Model not found: ${pattern}`, "error");
      return;
    }
    resolved.push(model);
  }

  await setModelSetting(key, toRoleSettingValue(patterns) ?? patterns[0]);
  ctx.ui.notify(
    patterns.length === 1
      ? `${roleLabel} model set to: ${resolved[0].id}${note}`
      : `${roleLabel} models set to: ${resolved.map((m) => m.id).join(" -> ")} ` +
          "(tried in order; the first entry the provider layer reports usable wins)",
    "info",
  );
}

/**
 * The /utility-model command body. The deprecated /max-power-model alias
 * drives the same function: the roles merged, so both commands write the one
 * canonical key and differ only in the deprecation notice.
 */
async function runUtilityModelCommand(
  args: string,
  ctx: ExtensionCommandContext,
  viaDeprecatedAlias: boolean,
): Promise<void> {
  if (viaDeprecatedAlias) {
    ctx.ui.notify(
      "/max-power-model is deprecated: the max-power role merged into the utility role. " +
        "Use /utility-model; the alias is removed next release.",
      "warning",
    );
  }

  if (!args || args.trim() === "") {
    if (ctx.hasUI) {
      await openModelSelectorUI(ctx, UTILITY_MODEL_KEY, "Utility", null, resolveUtilityModel);
    } else {
      const model = resolveUtilityModel(ctx);
      const patterns = configuredRolePatterns(UTILITY_MODEL_KEY);
      ctx.ui.notify(
        patterns.length === 0
          ? "Utility model: none (will use session model)"
          : `Utility model${patterns.length > 1 ? "s" : ""}: ${patterns.join(" -> ")}` +
              ` (using: ${model?.id ?? "none"})`,
        model ? "info" : "warning",
      );
    }
    return;
  }

  const text = args.trim();
  if (text === "clear" || text === "reset") {
    await clearModelSetting(UTILITY_MODEL_KEY);
    ctx.ui.notify("Utility model cleared (will use session model for classification)", "info");
    return;
  }

  await setRoleSettingFromArgs(
    ctx,
    UTILITY_MODEL_KEY,
    "Utility",
    " (classifications will use this model)",
    text,
  );
}

/**
 * Merge the in-memory custom model keys into pi's settings.json.
 * Writes through the single settings writer, so a concurrent write to the
 * same file cannot drop these keys.
 */
function persistCustomKeys(): void {
  try {
    const map = getCustomModelKeys();
    updateSettings((settings) => {
      for (const [key, value] of map) {
        settings[key] = value;
      }
      // Any role write retires the legacy key in the same transaction: a
      // stale alias left on disk is resurrected by the next load.
      delete settings[MAX_POWER_MODEL_KEY];
    });
  } catch {
    // Non-fatal: settings won't persist but everything else still works
  }
}

/**
 * Load custom keys from pi's settings.json into the in-memory map.
 * A role key carries either one pattern or an ordered list; both land in the
 * map in the list form the resolver walks. A value with no usable pattern is
 * treated as unset rather than stored as something that resolves to nothing.
 */
function loadCustomKeysFromDisk(): void {
  try {
    const settings = readSettingsFile();
    const map = getCustomModelKeys();
    for (const key of [VISION_MODEL_KEY, UTILITY_MODEL_KEY]) {
      const value = toRoleSettingValue(normaliseRoleSetting(settings[key]));
      if (value !== undefined) map.set(key, value);
    }

    // Deprecated alias: a legacy maxPowerModel value loads under the canonical
    // key when that key carries no usable value on disk (canonical wins when
    // both are present). The legacy key is never stored under its own name;
    // one process-global notice tells the user to move the value before the
    // alias is removed.
    const canonical = toRoleSettingValue(normaliseRoleSetting(settings[UTILITY_MODEL_KEY]));
    if (canonical === undefined) {
      const legacy = toRoleSettingValue(normaliseRoleSetting(settings[MAX_POWER_MODEL_KEY]));
      if (legacy !== undefined) {
        map.set(UTILITY_MODEL_KEY, legacy);
        if (consumeMaxPowerDeprecationNotice()) {
          log.warn(
            `${MAX_POWER_MODEL_KEY} is deprecated and now loads as ${UTILITY_MODEL_KEY}. ` +
              `Move the value to ${UTILITY_MODEL_KEY} (for example /utility-model <pattern>); ` +
              "the legacy key is removed next release.",
          );
        }
      }
    }
  } catch {
    // Non-fatal: no prior settings or parse error
  }
}

/** Load disableConfirmations setting from pi's settings.json. */
function loadDisableConfirmations(): boolean {
  return readSettingsFile().disableConfirmations === true;
}

/** Patch ctx.ui.confirm to auto-confirm when disableConfirmations is enabled */
function patchConfirmForAutoConfirm(ctx: any): void {
  if (!ctx.ui?.confirm) return;

  ctx.ui.confirm = async (_title: string, _message: string, _opts?: any): Promise<boolean> => {
    // Auto-confirm all dialogs
    return true;
  };
}

export default function polyfillExtension(pi: ExtensionAPI) {
  // Load custom model keys from disk at startup so they survive session restarts.
  // Fire-and-forget: non-fatal if this fails (keys will be loaded on next set).
  loadCustomKeysFromDisk();

  // Apply the configured window as early as the platform allows: session_start
  // fires on startup and on /reload (reason "reload", after pi-core has rebuilt
  // the runner and re-resolved the model from the catalog). The session model
  // object is the same instance the TUI footer reads for its denominator
  // (session.getContextUsage() / state.model.contextWindow), so patching it
  // here makes display and enforcement agree before the first run, not only
  // at the next agent turn. No-op when the setting is unset.
  pi.on(SESSION_START, (_event, ctx) => {
    applyConfiguredContextWindow(ctx);
    // Pair the window with the reserve it implies: pi-core decides WHEN to
    // compact from its own `compaction.reserveTokens` (a fixed token count),
    // so the window alone would leave the trigger at an arbitrary share.
    applyCompactionReserveTokens(ctx);
  });

  // Re-apply the configured window whenever the model changes. A rotation or
  // a user switch installs a fresh catalog model object carrying the
  // PROVIDER window; without this hook the configured cap is not re-plumbed
  // until the next before_agent_start, so pi-core's threshold compaction and
  // the usage display read the provider window in between (observed: a
  // mid-run rotation to a 1M-window model silently lifted the 256k cap).
  // model_select fires after agent.state.model is updated, so ctx.model is
  // the newly selected object. Idempotent, like the reserve it pairs with.
  pi.on("model_select", (_event, ctx) => {
    applyConfiguredContextWindow(ctx);
    applyCompactionReserveTokens(ctx);
  });

  // Patch session manager methods on before_agent_start (fires for --no-session mode)
  pi.on("before_agent_start", async (_event, ctx) => {
    patchSessionManagerMethods(pi, ctx);

    // Re-apply the configured window per run so a mid-session model switch
    // (a fresh catalog model object carrying the provider window) is
    // re-plumbed at the next run start. Idempotent, like the reserve
    // derivation that pairs with it.
    applyConfiguredContextWindow(ctx);
    applyCompactionReserveTokens(ctx);

    // Patch confirm dialogs if auto-confirm is enabled
    const autoConfirm = loadDisableConfirmations();
    if (autoConfirm) {
      patchConfirmForAutoConfirm(ctx);
    }

    return {};
  });

  // D1: Clean up all extension state on session end.
  // This prevents memory leaks across sessions (cognitive stores, analytics,
  // enforcement state, etc.). registerSessionCleanup clears per-ctx WeakMap state.
  // pi-core has no session_end extension event; session_shutdown is the
  // end-of-session event the extension runner dispatches.
  onEvent(pi, SESSION_SHUTDOWN, registerSessionCleanup());

  // Utility model command (canonical role)
  pi.registerCommand("utility-model", {
    description:
      "Set or show the utility model for classification tasks. " +
      "Accepts one model or an ordered list (comma-separated), tried in order " +
      "until the provider layer reports a route usable. " +
      "No args = show current setting. Smaller/faster models preferred. " +
      "Examples: /utility-model provider/model-id, /utility-model a/b,c/d, " +
      "/utility-model clear",
    handler: (args, ctx) => runUtilityModelCommand(args, ctx, false),
  });

  pi.registerCommand("vision-model", {
    description:
      "Set or show the vision model. Accepts one model or an ordered list " +
      "(comma-separated); every entry must accept image input. " +
      "No args opens the (vision-filtered) selector UI. " +
      "Examples: /vision-model provider/model-id, /vision-model a/b,c/d, /vision-model clear",
    handler: async (args, ctx) => {
      ctx.ui.notify(
        "/vision-model is deprecated: image analysis falls back to the utility list's first " +
          "image-capable model. The setting keeps priority this release; the command is removed next release.",
        "warning",
      );
      if (!args || args.trim() === "") {
        if (ctx.hasUI) {
          const visionFilter = (m: Model<Api>) => hasImageInput(m as { input?: unknown });
          await openModelSelectorUI(ctx, VISION_MODEL_KEY, "Vision", visionFilter);
        } else {
          const model = resolveVisionModel(ctx);
          const patterns = configuredRolePatterns(VISION_MODEL_KEY);
          ctx.ui.notify(
            patterns.length === 0
              ? `Vision model: ${model?.id ?? "none"} (auto-detected)`
              : `Vision model${patterns.length > 1 ? "s" : ""}: ${patterns.join(" -> ")}` +
                  ` (using: ${model?.id ?? "none"})`,
            "info",
          );
        }
        return;
      }

      const text = args.trim();
      if (text === "clear" || text === "reset") {
        await clearModelSetting(VISION_MODEL_KEY);
        ctx.ui.notify("Vision model cleared (will auto-detect)", "info");
        return;
      }

      await setRoleSettingFromArgs(ctx, VISION_MODEL_KEY, "Vision", "", text);
    },
  });

  // Max-power model command (deprecated alias)
  pi.registerCommand("max-power-model", {
    description:
      "Deprecated alias of /utility-model: the max-power role merged into the " +
      "utility role. Set/show/clear operate on the canonical utility setting; " +
      "the alias is removed next release. " +
      "Examples: /max-power-model provider/model-id, /max-power-model a/b,c/d, " +
      "/max-power-model clear",
    handler: (args, ctx) => runUtilityModelCommand(args, ctx, true),
  });
}

// Helpers

/** Persist a model pattern, or an ordered list of them, for the given role key. */
async function setModelSetting(key: string, value: CustomModelKeyValue): Promise<void> {
  getCustomModelKeys().set(key, value);
  persistCustomKeys();
}

/** Clear a model pattern. Writes to disk + in-memory map. */
async function clearModelSetting(key: string): Promise<void> {
  getCustomModelKeys().delete(key);
  // persistCustomKeys writes only the keys still in the map, so deleting from
  // the map alone left the old value in settings.json and the next session
  // resurrected it. "Clear" has to clear the stored setting as well, and a
  // clear is a role write: it retires the deprecated legacy key too.
  updateSettings((settings) => {
    delete settings[key];
    delete settings[MAX_POWER_MODEL_KEY];
  });
}

/** Resolve a model from a "provider/model-id" or bare "model-id" pattern. */
function resolveModelPattern(
  ctx: ExtensionCommandContext,
  pattern: string,
): Model<Api> | undefined {
  const slashIndex = pattern.indexOf("/");
  if (slashIndex >= 0) {
    const provider = pattern.slice(0, slashIndex);
    const modelId = pattern.slice(slashIndex + 1);
    return ctx.modelRegistry.find(provider, modelId);
  }
  const all = ctx.modelRegistry.getAll();
  return all.find((m) => m.id === pattern || m.id.endsWith(`/${pattern}`));
}

/**
 * Open ModelSelectorComponent via ctx.ui.custom() for model selection.
 *
 * Approach:
 * - Use SettingsManager.inMemory() for ModelSelectorComponent (its
 *   setDefaultModelAndProvider is a no-op for disk persistence - that's fine
 *   since we call pi.setModel() afterwards which goes through AgentSession
 *   and persists via the real settings manager).
 * - Capture the selected model in the onSelect callback.
 * - After ctx.ui.custom() resolves, call pi.setModel() and setModelSetting().
 */
async function openModelSelectorUI(
  ctx: ExtensionCommandContext,
  settingKey: string,
  roleLabel: string,
  scopeFilter: ((m: Model<Api>) => boolean) | null,
  resolveFn: (ctx: ExtensionContext) => Model<Api> | undefined = resolveVisionModel,
): Promise<void> {
  const modelRegistry = ctx.modelRegistry;

  // ModelSelectorComponent writes through an in-memory SettingsManager:
  // setDefaultModelAndProvider() sets fields in memory but never persists,
  // so pi.setModel() below does the real persistence.
  const settingsManager = SettingsManager.inMemory();

  // ModelSelectorComponent's 4th parameter is the ModelRuntime. The extension
  // context exposes only the ModelRegistry facade, which holds the runtime as
  // a private field (`runtime`); read it directly. The retired
  // getAvailableSnapshot probe tested the registry for a method that exists
  // only on ModelRuntime, so it was false by construction on every supported
  // build.
  const modelRuntime = (modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;

  // Priority: selected model first, then same provider, then others
  const currentRoleModel = resolveFn(ctx as ExtensionContext);
  const mainModel = (ctx as { model?: { provider?: string } }).model;
  const prefProvider = currentRoleModel?.provider ?? mainModel?.provider;

  const allModels = modelRegistry.getAvailable();
  let scopedModels: { model: Model<Api>; thinkingLevel?: string }[];

  if (scopeFilter) {
    const filtered = allModels.filter(scopeFilter);
    filtered.sort((a, b) => {
      if (currentRoleModel && a.id === currentRoleModel.id) return -1;
      if (currentRoleModel && b.id === currentRoleModel.id) return 1;
      if (prefProvider && a.provider === prefProvider) return -1;
      if (prefProvider && b.provider === prefProvider) return 1;
      return a.id.localeCompare(b.id);
    });
    scopedModels = filtered.map((m) => ({ model: m }));
  } else {
    allModels.sort((a, b) => {
      if (currentRoleModel && a.id === currentRoleModel.id) return -1;
      if (currentRoleModel && b.id === currentRoleModel.id) return 1;
      if (prefProvider && a.provider === prefProvider) return -1;
      if (prefProvider && b.provider === prefProvider) return 1;
      return a.id.localeCompare(b.id);
    });
    scopedModels = allModels.map((m) => ({ model: m }));
  }

  // Capture selected model from the dialog
  let selectedModel: Model<Api> | undefined;

  await ctx.ui.custom(async (tui, _theme, _keybindings, done) => {
    const onSelect = async (model: Model<Api>) => {
      selectedModel = model;

      // Warn if a non-vision model was picked for the vision role
      if (scopeFilter && !hasImageInput(model as { input?: unknown })) {
        ctx.ui.notify(
          `[warn] ${model.id} does not support image input. Vision analysis may fail.`,
          "warning",
        );
      }

      done(model);
    };
    const onCancel = () => done(undefined as unknown);

    // 0.80.8: (tui, currentModel, settingsManager, modelRuntime, scopedModels,
    // onSelect, onCancel) — ctor.length 7. 0.84.4: (tui, currentModel,
    // modelRuntime, scopedModels, onSelect, onCancel, initialSearchInput?,
    // onSelectAsDefault?, defaultModel?) — SettingsManager dropped; the
    // compiled ctor declares 9 plain params (no defaults) → length 9. NB:
    // function.length counts params BEFORE the first default — the d.ts's
    // "optional" suffixes don't exist in compiled JS. So length !== 7 = new. The installed
    // devDependency types may lag the running pi dist (0.82.1 d.ts vs 0.84.4
    // runtime), so the new-signature branch is typed loosely on purpose.
    const isNewSelector = ModelSelectorComponent.length !== 7;
    // structural component — pi renders it via ctx.ui.custom. Return type is
    // `object` (not {}): the new-signature branch is typed loosely on purpose.
    const SelectorCtor = ModelSelectorComponent as unknown as new (...args: unknown[]) => object;
    const selector = isNewSelector
      ? new (SelectorCtor as any)(
          tui,
          currentRoleModel,
          modelRuntime,
          scopedModels,
          onSelect,
          onCancel,
        )
      : // 0.85.1 devDep types carry only the new signature (3rd param
        // ModelRuntime), so the legacy branch can no longer type against
        // them — same deliberate loose typing as the new branch above.
        new (SelectorCtor as any)(
          tui,
          currentRoleModel,
          settingsManager,
          modelRuntime,
          scopedModels,
          onSelect,
          onCancel,
        );

    return selector;
  });

  if (!selectedModel) return;

  // Store the role-specific key only. Do NOT call pi.setModel() - that would change
  // the default model, which is NOT what we want for utility/vision role selection.
  // model-resolver.ts reads these custom keys and uses them directly.
  const pattern = `${selectedModel.provider}/${selectedModel.id}`;
  await setModelSetting(settingKey, pattern);

  ctx.ui.notify(`${roleLabel} model set to: ${selectedModel.id}`, "info");
}

// Session manager patches for --no-session mode

/**
 * Patch SessionManager methods onto the pi ExtensionAPI so context_navigate
 * (action="tag"/"checkout") and context_compress can work in --no-session mode.
 * work in --no-session mode (where AgentSession doesn't bind them).
 */
function patchSessionManagerMethods(pi: any, ctx: any): void {
  const sm = ctx?.sessionManager as SessionManagerLike;
  if (!sm) return;

  getPolyfillState().sessionManager = sm;

  if (typeof pi.getBranch !== "function" && typeof sm.getBranch === "function") {
    pi.getBranch = () => sm.getBranch?.();
  }
  if (typeof pi.getLeafId !== "function" && typeof sm.getLeafId === "function") {
    pi.getLeafId = () => sm.getLeafId?.();
  }
  if (typeof pi.getTree !== "function" && typeof sm.getTree === "function") {
    pi.getTree = () => sm.getTree?.();
  }
  if (typeof pi.getLabel !== "function" && typeof sm.getLabel === "function") {
    pi.getLabel = (id: string) => sm.getLabel?.(id);
  }
  if (typeof pi.setLabel !== "function" && typeof sm.setLabel === "function") {
    pi.setLabel = (id: string, label: string) => sm.setLabel?.(id, label);
  }
  if (typeof pi.getChildren !== "function" && typeof sm.getChildren === "function") {
    pi.getChildren = (id: string) => sm.getChildren?.(id);
  }
  if (typeof pi.branchWithSummary !== "function" && typeof sm.branchWithSummary === "function") {
    pi.branchWithSummary = async (summary: string) => sm.branchWithSummary?.(summary);
  }
  if (typeof pi.navigateTree !== "function" && typeof sm.navigateTree === "function") {
    pi.navigateTree = async (id: string) => sm.navigateTree?.(id);
  }
  if (typeof pi.abort !== "function" && typeof sm.abort === "function") {
    pi.abort = (_reason?: string) => {
      sm.abort?.();
    };
  }
  if (typeof pi.getContextUsage !== "function" && typeof sm.getContextUsage === "function") {
    pi.getContextUsage = () => sm.getContextUsage?.();
  }
}
