/**
 * Polyfill Extension — Patches missing API methods on ExtensionContext
 *
 * On upstream_main (v0.65.x/v0.66.x), the ExtensionContext doesn't have:
 * - getUtilityModel() — resolve cheapest model for utility calls
 * - getVisionModel() — resolve vision-capable model for image analysis
 *
 * This extension patches these methods during session_start so that
 * other extensions (vision, enforcement, evolve, metacognition) can
 * call them without crashing.
 *
 * Priority resolution for utilityModel:
 *   1. Check .pi/settings.json for "utilityModel" custom key
 *   2. Fall back to current model
 *   3. Fall back to cheapest available model (non-reasoning, lowest cost)
 *
 * Priority resolution for visionModel:
 *   1. Check .pi/settings.json for "visionModel" custom key
 *   2. Fall back to current model if vision-capable
 *   3. Fall back to first available vision-capable model
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Type assertion helpers for events that may not be in TypeScript definitions
// but are implemented in pi-coding-agent 0.66.x
const asApi = (pi: ExtensionAPI) => pi as ExtensionAPI & {
	on(event: string, handler: (event: any, ctx: any) => Promise<any>): void;
};

/** Custom settings keys managed by /utility-model and /vision-model commands */
const UTILITY_MODEL_KEY = "utilityModel";
const VISION_MODEL_KEY = "visionModel";

/** Shared settingsManager reference (stored from session_start context where it's available) */
let _settingsManager: any = undefined;

/** Get the stored settingsManager, falling back to sessionManager's settingsManager */
function getSettingsManager(ctx: any): any {
	// Return stored reference if available
	if (_settingsManager) return _settingsManager;

	// Fallback: try sessionManager's settingsManager (may be on full SessionManager)
	const sm = ctx.sessionManager as any;
	if (sm?.settingsManager) {
		_settingsManager = sm.settingsManager;
		return _settingsManager;
	}

	return undefined;
}

export default function polyfillExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		patchContextMethods(ctx);
		// Store settingsManager from sessionManager (available on ReadonlySessionManager)
		// Note: settingsManager lives on the full SessionManager, not ReadonlySessionManager,
		// but sessionManager.settingsManager may be accessible in some versions
		const sm = ctx.sessionManager as any;
		if (sm?.settingsManager && !_settingsManager) {
			_settingsManager = sm.settingsManager;
		}
	});

	// Also patch on context event (fires after session_start in case context is rebuilt)
	pi.on("context", async () => {
		// Methods are already patched on the context object
		// This handler ensures we have the latest settings
		return {};
	});

	// Register settings commands for model selection
	pi.registerCommand("utility-model", {
		description: "Set or show the utility model for cheap LLM calls",
		handler: async (args, ctx) => {
			const settings = getSettingsManager(ctx);
			const current = settings?.get?.(UTILITY_MODEL_KEY);

			if (!args || args.trim() === "") {
				// Show current or auto-detected
				const model = resolveUtilityModel(ctx);
				ctx.ui.notify(
					current
						? `Utility model: ${current} (configured)`
						: `Utility model: ${model?.id ?? "none"} (auto-detected)`,
					"info",
				);
				return;
			}

			if (args.trim() === "clear" || args.trim() === "reset") {
				if (settings?.set) settings.set(UTILITY_MODEL_KEY, undefined);
				ctx.ui.notify("Utility model cleared (will auto-detect)", "info");
				return;
			}

			// Set pattern: "provider/model-id" or just "model-id"
			if (settings?.set) settings.set(UTILITY_MODEL_KEY, args.trim());
			ctx.ui.notify(`Utility model set to: ${args.trim()}`, "info");
		},
	});

	pi.registerCommand("vision-model", {
		description: "Set or show the vision model for image analysis",
		handler: async (args, ctx) => {
			const settings = getSettingsManager(ctx);
			const current = settings?.get?.(VISION_MODEL_KEY);

			if (!args || args.trim() === "") {
				const model = resolveVisionModel(ctx);
				ctx.ui.notify(
					current
						? `Vision model: ${current} (configured)`
						: `Vision model: ${model?.id ?? "none"} (auto-detected)`,
					"info",
				);
				return;
			}

			if (args.trim() === "clear" || args.trim() === "reset") {
				if (settings?.set) settings.set(VISION_MODEL_KEY, undefined);
				ctx.ui.notify("Vision model cleared (will auto-detect)", "info");
				return;
			}

			if (settings?.set) settings.set(VISION_MODEL_KEY, args.trim());
			ctx.ui.notify(`Vision model set to: ${args.trim()}`, "info");
		},
	});

	// Track agent_end to capture user messages for retry
	// Note: turn_end is in the type definitions but not implemented in 0.66.1
	// Using type assertion since runtime supports any event string
	const piTyped = asApi(pi);
	piTyped.on("agent_end", async (event: any) => {
		// Extract user messages from the conversation for retry tracking
		if (event.messages && Array.isArray(event.messages)) {
			// Find the last user message
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
	// Workaround for upstream_main limitation: no direct message manipulation or continue()
	pi.registerCommand("retry", {
		description: "Retry the last turn (abort and re-send)",
		handler: async (_args, ctx) => {
			if (!_lastUserMessage) {
				ctx.ui.notify("/retry: No previous turn to retry.", "warning");
				return;
			}

			// Abort current operation
			ctx.abort();

			// Re-send the last user message to trigger a new turn
			// This preserves previous tool results in context
			const content = _lastUserMessage.images
				? [_lastUserMessage.text, ..._lastUserMessage.images]
				: _lastUserMessage.text;

			pi.sendUserMessage(content);

			ctx.ui.notify("/retry: Aborted and re-sending last message.", "info");
		},
	});
}

/**
 * Patch getUtilityModel and getVisionModel onto the context if missing.
 * These methods exist on the develop branch but not on upstream_main.
 */
function patchContextMethods(ctx: any): void {
	if (typeof ctx.getUtilityModel !== "function") {
		ctx.getUtilityModel = () => resolveUtilityModel(ctx);
	}
	if (typeof ctx.getVisionModel !== "function") {
		ctx.getVisionModel = () => resolveVisionModel(ctx);
	}
}

/**
 * Resolve the best utility model.
 * Priority: custom setting > current model > cheapest available.
 */
function resolveUtilityModel(ctx: any): any {
	// 1. Check custom setting via settingsManager
	const settings = getSettingsManager(ctx);
	const settingPattern = settings?.get?.(UTILITY_MODEL_KEY) as string | undefined;
	if (settingPattern) {
		const resolved = resolveModelPattern(ctx, settingPattern);
		if (resolved) return resolved;
	}

	// 2. Current model
	if (ctx.model) return ctx.model;

	// 3. Cheapest available non-reasoning model
	const available = ctx.modelRegistry?.getAvailable?.() ?? [];
	const nonReasoning = available.filter((m: any) => !m.reasoning);
	if (nonReasoning.length > 0) {
		nonReasoning.sort(
			(a: any, b: any) => (a.cost?.input ?? 0) + (a.cost?.output ?? 0) - ((b.cost?.input ?? 0) + (b.cost?.output ?? 0)),
		);
		return nonReasoning[0];
	}

	// 4. Fall back to any available
	return available[0];
}

/**
 * Resolve the best vision model.
 * Priority: custom setting > current model if vision-capable > first available vision model.
 */
function resolveVisionModel(ctx: any): any {
	// 1. Check custom setting via settingsManager
	const settings = getSettingsManager(ctx);
	const settingPattern = settings?.get?.(VISION_MODEL_KEY) as string | undefined;
	if (settingPattern) {
		const resolved = resolveModelPattern(ctx, settingPattern);
		if (resolved?.input?.includes("image")) return resolved;
	}

	// 2. Current model if vision-capable
	if (ctx.model?.input?.includes("image")) return ctx.model;

	// 3. First available vision model
	const available = ctx.modelRegistry?.getAvailable?.() ?? [];
	return available.find((m: any) => m.input?.includes("image"));
}

/**
 * Resolve a model from a pattern like "anthropic/claude-sonnet-4-5" or "claude-sonnet-4-5".
 */
function resolveModelPattern(ctx: any, pattern: string): any {
	const slashIndex = pattern.indexOf("/");
	if (slashIndex >= 0) {
		const provider = pattern.slice(0, slashIndex);
		const modelId = pattern.slice(slashIndex + 1);
		return ctx.modelRegistry?.find?.(provider, modelId);
	}

	// Try to find by model ID alone
	const allModels = ctx.modelRegistry?.getAll?.() ?? [];
	return allModels.find(
		(m: any) => m.id === pattern || m.id.endsWith(`/${pattern}`),
	);
}

/** Track last user message for retry functionality */
let _lastUserMessage: { text: string; images?: any[] } | null = null;

/** Track turn start to capture user messages */
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
			_lastUserMessage = { text: textParts.join("\n"), images: images.length > 0 ? images : undefined };
		}
	} else if (typeof content === "string") {
		_lastUserMessage = { text: content };
	}
}