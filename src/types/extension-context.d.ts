/**
 * Local type augmentation for ExtensionContext.
 *
 * Adds getUtilityModel() and getVisionModel() which are patched by the polyfill
 * extension at session_start. This allows TypeScript to recognize these methods
 * on ExtensionContext throughout the codebase without `as any` casts.
 */

import type { Model, Api } from "@mariozechner/pi-ai";

declare module "@mariozechner/pi-coding-agent" {
	interface ExtensionContext {
		/** Get the configured utility model (cheapest model for non-critical calls). Patched by polyfill extension. */
		getUtilityModel(): Model<Api> | undefined;

		/** Get the configured vision model (vision-capable model for image analysis). Patched by polyfill extension. */
		getVisionModel(): Model<Api> | undefined;
	}
}