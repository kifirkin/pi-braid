/**
 * Local type augmentation for ExtensionContext.
 *
 * Adds commonly accessed properties that exist at runtime but are not declared
 * in the upstream type definitions. This eliminates `as any` casts across the
 * codebase.
 */

import type { Model, Api } from "@mariozechner/pi-ai";

declare module "@mariozechner/pi-coding-agent" {
	interface ExtensionContext {
		/** Session-scoped key-value store. */
		getState<T = unknown>(key: string): T | undefined;
		/** Global (cross-session) key-value store. */
		getGlobalState<T = unknown>(key: string): T | undefined;
		/** Logger instance. */
		logger: {
			info(...args: unknown[]): void;
			warn(...args: unknown[]): void;
			error(...args: unknown[]): void;
			debug?(msg: string, data?: unknown): void;
		};
		/** Raw mutable state object (legacy). */
		state: Record<string, unknown>;
		/** Settings manager for default provider / model. */
		settingsManager: {
			getDefaultProvider(): string | undefined;
			getDefaultModel(): string | undefined;
		};
		/** Session manager for stable session identifiers. */
		sessionManager: {
			getSessionFile(): string | undefined;
			getSessionId(): string | undefined;
		};
		/** Agent / run identifiers. */
		agentId: string;
		runId: string;
		/** Model registry. */
		modelRegistry: {
			find(provider: string, modelId: string): Model<Api> | undefined;
			getAll(): Model<Api>[];
			getAvailable(): Model<Api>[];
		};
		/** Current model. */
		model: Model<Api> | undefined;

		/** Get the configured utility model (cheapest model for non-critical calls). Patched by polyfill extension. */
		getUtilityModel(): Model<Api> | undefined;
		/** Get the configured vision model (vision-capable model for image analysis). Patched by polyfill extension. */
		getVisionModel(): Model<Api> | undefined;
	}
}