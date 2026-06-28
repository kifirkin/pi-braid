/**
 * Tool provenance: tracks which extension registered each tool.
 *
 * Used by the prompt-builder's Instance block to surface a full
 * "what's loaded and where it came from" picture to the agent.
 *
 * Pattern: per-process module-level state. The provenance is built
 * once at session-start by the loader (loader.ts) and is read-only
 * after that. Cross-session state is fine here — tool registration
 * is determined by config, not by per-session data.
 *
 * Invariant: every entry has both a tool name and an extension id.
 * Unregistered tools (pi-core built-ins not registered by an extension)
 * are simply absent from the map; consumers should treat absence as
 * "from pi-core or unknown source."
 */

const _provenance = new Map<string, string>();

/** Get the shared tool provenance map (tool name → extension id). */
export function getToolProvenance(): Map<string, string> {
  return _provenance;
}

/** Record a tool registration. Called by the loader after each extension runs. */
export function recordToolRegistration(toolName: string, extensionId: string): void {
  _provenance.set(toolName, extensionId);
}

/** Get the extension id that registered a given tool, or undefined. */
export function getToolSource(toolName: string): string | undefined {
  return _provenance.get(toolName);
}

/**
 * Get all tools grouped by their source extension.
 * Returns: Map<extensionId, string[] of tool names>.
 */
export function getToolsByExtension(): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const [toolName, extId] of _provenance) {
    const list = grouped.get(extId);
    if (list) list.push(toolName);
    else grouped.set(extId, [toolName]);
  }
  return grouped;
}

/** Clear the provenance map. For tests or session resets. */
export function clearToolProvenance(): void {
  _provenance.clear();
}
