import { createLogger } from "../../../lib/logger.js";

const log = createLogger("polyfill");
/**
 * Polyfill Extension - Patches missing API methods on ExtensionContext
 *
 * Two concerns:
 * 1. Model selection: /utility-model and /vision-model commands open the ModelSelectorComponent UI.
 *    Model resolution is handled by src/lib/model-resolver.ts (used by vision/metacognition tools directly).
 * 2. Session manager patches: context_tag/checkout commands need SessionManager methods in --no-session mode.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { ModelSelectorComponent, SettingsManager } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import { resolveVisionModel } from "../../../lib/model-resolver.js";
import { registerSessionCleanup } from "../../../lib/extension-state.js";

/** Custom settings keys managed by /utility-model and /vision-model commands */
import { getCustomModelKeys, VISION_MODEL_KEY } from "../../../lib/global-state.js";

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

/** Shared sessionManager reference — used by patchSessionManagerMethods */
import { getExtensionState } from "../../../lib/extension-state.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

function getPolyfillState(ctx?: ExtensionContext): { sessionManager: any } {
  if (ctx) return getExtensionState(ctx, "polyfill", () => ({ sessionManager: undefined }));
  return _default;
}
const _default = { sessionManager: undefined as any };

/** Path to the global settings file - ~/.pi/agent/settings.json */
const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

/**
 * Persist custom model keys to ~/.pi/agent/settings.json.
 * Reads the existing file, merges in our custom keys, writes back.
 * Silently fails if the file can't be read/written (non-fatal).
 */
async function persistCustomKeys(): Promise<void> {
  try {
    const existing = await fs.readFile(SETTINGS_PATH, "utf-8").catch(() => null);
    const settings = existing ? JSON.parse(existing) : {};

    // Write all custom keys that are currently set
    const map = getCustomModelKeys();
    for (const [key, value] of map) {
      settings[key] = value;
    }

    await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
  } catch {
    // Non-fatal: settings won't persist but everything else still works
    /* Non-fatal: input normalization unavailable */
  }
}

/** Load custom keys from ~/.pi/agent/settings.json into the in-memory map. */
async function loadCustomKeysFromDisk(): Promise<void> {
  try {
    const content = await fs.readFile(SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(content);
    const map = getCustomModelKeys();
    for (const key of [VISION_MODEL_KEY]) {
      if (typeof settings[key] === "string" && settings[key]) {
        map.set(key, settings[key]);
      }
    }
  } catch {
    // Non-fatal: no prior settings or parse error
    /* Non-fatal: tool registry access unavailable */
  }
}

export default function polyfillExtension(pi: ExtensionAPI) {
  // Load custom model keys from disk at startup so they survive session restarts.
  // Fire-and-forget: non-fatal if this fails (keys will be loaded on next set).
  loadCustomKeysFromDisk().catch(() => {});

  // Patch session manager methods on before_agent_start (fires for --no-session mode)
  pi.on("before_agent_start", async (_event, ctx) => {
    patchSessionManagerMethods(pi, ctx);
    return {};
  });

  // D1: Clean up all extension state on session rotation.
  // This prevents memory leaks across sessions (cognitive stores, analytics,
  // enforcement state, etc.). registerSessionCleanup clears per-ctx WeakMap state.
  pi.on("session_end" as any, registerSessionCleanup());

  // Register settings commands for model selection
  pi.registerCommand("vision-model", {
    description:
      "Set or show the vision model for image analysis. No args = open model selector UI (filtered to vision-capable models).",
    handler: async (args, ctx) => {
      if (!args || args.trim() === "") {
        if (ctx.hasUI) {
          const visionFilter = (m: Model<Api>) =>
            hasImageInput(m as unknown as { input?: unknown });
          await openModelSelectorUI(ctx, VISION_MODEL_KEY, "Vision Model", visionFilter);
        } else {
          const model = resolveVisionModel(ctx);
          ctx.ui.notify(`Vision model: ${model?.id ?? "none"} (auto-detected)`, "info");
        }
        return;
      }

      const text = args.trim();
      if (text === "clear" || text === "reset") {
        await clearModelSetting(VISION_MODEL_KEY);
        ctx.ui.notify("Vision model cleared (will auto-detect)", "info");
        return;
      }

      const model = resolveModelPattern(ctx, text);
      if (!model) {
        ctx.ui.notify(`Model not found: ${text}`, "error");
        return;
      }
      await setModelSetting(VISION_MODEL_KEY, text);
      ctx.ui.notify(`Vision model set to: ${model.id}`, "info");
    },
  });
}

// Helpers

/** Persist a model pattern for the given role key. Writes to disk + in-memory map. */
async function setModelSetting(key: string, pattern: string): Promise<void> {
  getCustomModelKeys().set(key, pattern);
  await persistCustomKeys();
}

/** Clear a model pattern. Writes to disk + in-memory map. */
async function clearModelSetting(key: string): Promise<void> {
  getCustomModelKeys().delete(key);
  await persistCustomKeys();
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
  // Try to find by model ID alone
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
  _label: string,
  scopeFilter: ((m: Model<Api>) => boolean) | null,
): Promise<void> {
  const modelRegistry = ctx.modelRegistry;

  // Use an in-memory SettingsManager for ModelSelectorComponent.
  // Its setDefaultModelAndProvider() will work (sets in-memory fields) but
  // won't persist to disk. We call pi.setModel() below for proper persistence.
  const settingsManager = SettingsManager.inMemory();

  // Build scoped models list for vision filter
  const scopedModels: { model: Model<Api>; thinkingLevel?: string }[] = scopeFilter
    ? modelRegistry
        .getAvailable()
        .filter(scopeFilter)
        .map((m) => ({ model: m }))
    : [];

  // Pre-select the currently configured model (vision model only — no utility model)
  const currentModel = resolveVisionModel(ctx);

  // Capture selected model from the dialog
  let selectedModel: Model<Api> | undefined;

  await ctx.ui.custom(async (tui, _theme, _keybindings, done) => {
    const selector = new ModelSelectorComponent(
      tui,
      currentModel,
      settingsManager,
      modelRegistry,
      scopedModels,
      async (model) => {
        selectedModel = model;

        // Warn if a non-vision model was picked for the vision role
        if (!hasImageInput(model as { input?: unknown })) {
          ctx.ui.notify(
            `⚠ ${model.id} does not support image input. Vision analysis may fail.`,
            "warning",
          );
        }

        done(model);
      },
      () => done(undefined as unknown),
    );

    return selector;
  });

  if (!selectedModel) return;

  // Store the role-specific key only. Do NOT call pi.setModel() - that would change
  // the default model, which is NOT what we want for utility/vision role selection.
  // model-resolver.ts reads these custom keys and uses them directly.
  const pattern = `${selectedModel.provider}/${selectedModel.id}`;
  await setModelSetting(settingKey, pattern);

  ctx.ui.notify(`Vision model set to: ${selectedModel.id}`, "info");
}

// Session manager patches for --no-session mode

/**
 * Patch SessionManager methods onto the pi ExtensionAPI so context_tag/checkout commands
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
    pi.abort = (reason?: string) => {
      sm.abort?.();
    };
  }
  if (typeof pi.getContextUsage !== "function" && typeof sm.getContextUsage === "function") {
    pi.getContextUsage = () => sm.getContextUsage?.();
  }
}
