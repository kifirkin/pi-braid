/**
 * Tool provenance: records which extension registered each tool.
 *
 * Written by the loader's `registerTool` wrapper (src/loader/loader.ts,
 * wrapForProvenance) as each extension registers its tools. Read by nobody:
 * the module exposes no getter, and the prompt-builder's Instance block builds
 * its extension list from discoverTopLevelExtensions() instead
 * (extensions/core/prompt-builder/instance-composition.ts).
 *
 * Pattern: per-process module-level state. The provenance is built
 * once at session-start by the loader and is read-only
 * after that. Cross-session state is fine here -- tool registration
 * is determined by config, not by per-session data.
 *
 * Invariant: every entry has both a tool name and an extension id.
 * Unregistered tools (pi-core built-ins not registered by an extension)
 * are simply absent from the map; a consumer should treat absence as
 * "from pi-core or unknown source."
 */

const _provenance = new Map<string, string>();

/** Record a tool registration. Called by the loader after each extension runs. */
export function recordToolRegistration(toolName: string, extensionId: string): void {
  _provenance.set(toolName, extensionId);
}
