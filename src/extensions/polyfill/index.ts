import { createLogger } from "../../lib/logger.js";

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
import { resolveUtilityModel, resolveVisionModel } from "../../lib/model-resolver.js";

// Type assertion helpers for events that may not be in TypeScript definitions
const asApi = (pi: ExtensionAPI) => pi as ExtensionAPI & {
	on(event: string, handler: (event: any, ctx: any) => Promise<any>): void;
};

/** Custom settings keys managed by /utility-model and /vision-model commands */
const UTILITY_MODEL_KEY = "utilityModel";
const VISION_MODEL_KEY = "visionModel";

/** Shared sessionManager reference */
let _sessionManager: any = undefined;

/**
 * Cross-module shared map for custom model role keys (utilityModel / visionModel).
 * Uses a Symbol-keyed global so model-resolver.ts and polyfill/index.ts share the same map.
 */
const CUSTOM_KEYS_MAP = Symbol.for("pi-braid:custom-model-keys");

function getCustomModelKeys(): Map<string, string> {
	if (!(globalThis as any)[CUSTOM_KEYS_MAP]) {
		(globalThis as any)[CUSTOM_KEYS_MAP] = new Map<string, string>();
	}
	return (globalThis as any)[CUSTOM_KEYS_MAP];
}

/** Read a custom model key (utilityModel / visionModel). Shared with model-resolver.ts. */
export function getCustomModelKey(key: string): string | undefined {
	return getCustomModelKeys().get(key);
}

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
		for (const key of [UTILITY_MODEL_KEY, VISION_MODEL_KEY]) {
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

	// Register settings commands for model selection
	pi.registerCommand("utility-model", {
		description: "Set or show the utility model for cheap LLM calls. No args = open model selector UI.",
		handler: async (args, ctx) => {
			if (!args || args.trim() === "") {
				if (ctx.hasUI) {
					await openModelSelectorUI(ctx, UTILITY_MODEL_KEY, "Utility Model", null);
				} else {
					// Non-interactive: show auto-detected model
					const model = resolveUtilityModel(ctx);
					ctx.ui.notify(`Utility model: ${model?.id ?? "none"} (auto-detected)`, "info");
				}
				return;
			}

			const text = args.trim();
			if (text === "clear" || text === "reset") {
				await clearModelSetting(UTILITY_MODEL_KEY);
				ctx.ui.notify("Utility model cleared (will auto-detect)", "info");
				return;
			}

			// Text-based set: "provider/model-id" or just "model-id"
			const model = resolveModelPattern(ctx, text);
			if (!model) {
				ctx.ui.notify(`Model not found: ${text}`, "error");
				return;
			}
			await setModelSetting(UTILITY_MODEL_KEY, text);
			ctx.ui.notify(`Utility model set to: ${model.id}`, "info");
		},
	});

	pi.registerCommand("vision-model", {
		description: "Set or show the vision model for image analysis. No args = open model selector UI (filtered to vision-capable models).",
		handler: async (args, ctx) => {
			if (!args || args.trim() === "") {
				if (ctx.hasUI) {
					const visionFilter = (m: Model<Api>) =>
						Array.isArray((m as any)?.input) && (m as any)?.input.includes("image");
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

	// Track agent_end to capture user messages for retry
	const piTyped = asApi(pi);
	piTyped.on("agent_end", async (event: any) => {
		if (event.messages && Array.isArray(event.messages)) {
			for (let i = event.messages.length - 1; i >= 0; i--) {
				const msg = event.messages[i];
				if (msg.role === "user") {
					trackUserMessage(msg);
					break;
				}
			}
		}
		return {};
	});

	// Retry command - abort current turn and re-send last user message
	pi.registerCommand("retry", {
		description: "Retry the last turn (abort and re-send)",
		handler: async (_args, ctx) => {
			if (!_lastUserMessage) {
				ctx.ui.notify("/retry: No previous turn to retry.", "warning");
				return;
			}

			ctx.abort();

			const content = _lastUserMessage.images
				? [_lastUserMessage.text, ..._lastUserMessage.images]
				: _lastUserMessage.text;

			pi.sendUserMessage(content);
			ctx.ui.notify("/retry: Aborted and re-sending last message.", "info");
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
function resolveModelPattern(ctx: ExtensionCommandContext, pattern: string): Model<Api> | undefined {
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
	const scopedModels: { model: Model<Api>; thinkingLevel?: string }[] =
		scopeFilter
			? modelRegistry.getAvailable().filter(scopeFilter).map((m) => ({ model: m }))
			: [];

	// Pre-select the currently configured model
	const currentModel =
		settingKey === UTILITY_MODEL_KEY
			? resolveUtilityModel(ctx)
			: resolveVisionModel(ctx);

	// Capture selected model from the dialog
	let selectedModel: Model<Api> | undefined;

	await ctx.ui.custom(
		async (tui, _theme, _keybindings, done) => {
			const selector = new ModelSelectorComponent(
				tui,
				currentModel,
				settingsManager,
				modelRegistry,
				scopedModels,
				async (model) => {
					selectedModel = model;

					// Warn if a non-vision model was picked for the vision role
					if (settingKey === VISION_MODEL_KEY) {
						const hasImageInput =
							Array.isArray((model as any)?.input) && (model as any)?.input.includes("image");
						if (!hasImageInput) {
							ctx.ui.notify(
								`⚠ ${model.id} does not support image input. Vision analysis may fail.`,
								"warning",
							);
						}
					}

					done(model);
				},
				() => done(undefined as any),
			);

			return selector;
		},
	);

	if (!selectedModel) return;

	// Store the role-specific key only. Do NOT call pi.setModel() - that would change
	// the default model, which is NOT what we want for utility/vision role selection.
	// model-resolver.ts reads these custom keys and uses them directly.
	const pattern = `${selectedModel.provider}/${selectedModel.id}`;
	await setModelSetting(settingKey, pattern);

	ctx.ui.notify(`${settingKey === UTILITY_MODEL_KEY ? "Utility" : "Vision"} model set to: ${selectedModel.id}`, "info");
}

// Session manager patches for --no-session mode

/**
 * Patch SessionManager methods onto the pi ExtensionAPI so context_tag/checkout commands
 * work in --no-session mode (where AgentSession doesn't bind them).
 */
function patchSessionManagerMethods(pi: any, ctx: any): void {
	const sm = ctx?.sessionManager as any;
	if (!sm) return;

	_sessionManager = sm;

	if (typeof pi.getBranch !== "function" && typeof sm.getBranch === "function") {
		pi.getBranch = () => sm.getBranch();
	}
	if (typeof pi.getLeafId !== "function" && typeof sm.getLeafId === "function") {
		pi.getLeafId = () => sm.getLeafId();
	}
	if (typeof pi.getTree !== "function" && typeof sm.getTree === "function") {
		pi.getTree = () => sm.getTree();
	}
	if (typeof pi.getLabel !== "function" && typeof sm.getLabel === "function") {
		pi.getLabel = (id: string) => sm.getLabel(id);
	}
	if (typeof pi.setLabel !== "function" && typeof sm.setLabel === "function") {
		pi.setLabel = (id: string, label: string) => sm.setLabel(id, label);
	}
	if (typeof pi.getChildren !== "function" && typeof sm.getChildren === "function") {
		pi.getChildren = (id: string) => sm.getChildren(id);
	}
	if (typeof pi.branchWithSummary !== "function" && typeof sm.branchWithSummary === "function") {
		pi.branchWithSummary = async (targetId: string, summary: string) =>
			sm.branchWithSummary(targetId, summary);
	}
	if (typeof pi.navigateTree !== "function" && typeof sm.navigateTree === "function") {
		pi.navigateTree = async (id: string, options?: any) => sm.navigateTree(id, options);
	}
	if (typeof pi.abort !== "function" && typeof sm.abort === "function") {
		pi.abort = () => sm.abort();
	}
	if (typeof pi.getContextUsage !== "function" && typeof sm.getContextUsage === "function") {
		pi.getContextUsage = () => sm.getContextUsage();
	}
}

// Retry tracking

let _lastUserMessage: { text: string; images?: any[] } | null = null;

function trackUserMessage(msg: any): void {
	const content = msg.content;
	if (Array.isArray(content)) {
		const textParts: string[] = [];
		const images: any[] = [];
		for (const c of content) {
			if (c.type === "text") textParts.push(c.text);
			else if (c.type === "image") images.push(c);
		}
		if (textParts.length > 0) {
			_lastUserMessage = {
				text: textParts.join("\n"),
				images: images.length > 0 ? images : undefined,
			};
		}
	} else if (typeof content === "string") {
		_lastUserMessage = { text: content };
	}
}
