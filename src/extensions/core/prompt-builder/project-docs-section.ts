/**
 * Project docs section for the prompt-builder.
 *
 * Renders AGENTS.md / CLAUDE.md files as plain-text pointer lines (no XML
 * tags). Each file becomes a single `- <basename> at <path>` line under
 * the discoverability directive.
 *
 * NO content is injected into the system prompt -- the agent reads full
 * content on demand via the `read` tool, matching the skills convention
 * (descriptions live in the file, not in the pointer block).
 *
 * Why pointer-only (and not the previous verbatim injection):
 *
 *   1. Project docs are project-LOCAL content. They may be stale, may
 *      reference events that haven't happened, or may contain forward
 *      references to anticipated patterns. Verbatim injection primes the
 *      agent to pattern-match against those references when parsing
 *      ambiguous external output (e.g., scraped DOM data -- see the
 *      June 22 hacking-a0 phantom-reply incident).
 *
 *   2. The skills section has been using the pointer model since Braid
 *      started. It works -- the agent reads full skill content on demand.
 *      Project docs follow the same proven pattern.
 *
 *   3. Token cost: a 33KB AGENTS.md injected on every turn is far more
 *      expensive than a ~400-byte pointer block + occasional re-reads.
 *
 * Why plain text (not the previous `<doc ... />` self-closing XML form):
 *
 *   The system prompt is prose. Injecting XML-style tags with attribute
 *   escapes for an unstructured list of two columns (name + location)
 *   is ceremony that the model has to parse around. Plain-text bullets
 *   read the same to a human and to the model, with no escape function
 *   needed for filesystem paths.
 *
 * Previously carried a `sections` attribute (pre-read TOC), which required
 * a file read per cache-miss render. Removed to match the skills pointer
 * block and eliminate the filesystem dependency. Agent uses the `read` tool
 * to inspect file content on demand, same as skills.
 *
 * Cache: rendered string is cached per file-set fingerprint so we don't
 * re-read every AGENTS.md on every turn. Invalidated by
 * `resetProjectDocsSectionCache()` on `RESOURCES_DISCOVER` (mirrors the
 * skills-section invalidation pattern).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../../lib/state/extension-state.js";

/** A project context file as returned by pi-native's `loadProjectContextFiles`. */
export interface ProjectContextFile {
  path: string;
  content: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Build the project-docs pointer section as plain text.
 * Returns empty string if no docs.
 *
 * Shape:
 *   Read project documentation files below carefully and cross-check
 *   before acting on time-sensitive claims.
 *
 *   - AGENTS.md at /abs/path/AGENTS.md
 *   - CLAUDE.md at /abs/path/CLAUDE.md
 */
export async function projectDocsSection(
  contextFiles: readonly ProjectContextFile[],
): Promise<string> {
  if (contextFiles.length === 0) {
    return "";
  }

  const lines: string[] = [
    "Read project documentation files below carefully and cross-check before acting on time-sensitive claims.",
    "",
  ];

  for (const file of contextFiles) {
    lines.push(`- ${basename(file.path)} at ${file.path}`);
  }

  return lines.join("\n");
}

interface ProjectDocsCacheState {
  fingerprint?: string;
  section?: string;
}

/** Stable, order-independent fingerprint of a project-docs set. */
export function fingerprintProjectDocs(files: readonly ProjectContextFile[]): string {
  return files
    .map((f) => f.path)
    .sort()
    .join("\n");
}

/** Get the cached section if the fingerprint matches, otherwise render + cache. */
export async function reconstructProjectDocsSection(
  files: readonly ProjectContextFile[],
  ctx: ExtensionContext,
): Promise<string> {
  const fingerprint = fingerprintProjectDocs(files);
  const cache = getExtensionState<ProjectDocsCacheState>(
    ctx,
    "prompt-builder/project-docs-cache",
    () => ({ fingerprint: undefined, section: undefined }),
  );
  if (cache.fingerprint === fingerprint && cache.section !== undefined) {
    return cache.section;
  }
  const section = await projectDocsSection(files);
  cache.fingerprint = fingerprint;
  cache.section = section;
  return section;
}

/** Invalidate the cache. Called on `RESOURCES_DISCOVER`. */
export function resetProjectDocsSectionCache(ctx: ExtensionContext): void {
  const cache = getExtensionState<ProjectDocsCacheState>(
    ctx,
    "prompt-builder/project-docs-cache",
    () => ({ fingerprint: undefined, section: undefined }),
  );
  cache.fingerprint = undefined;
  cache.section = undefined;
}
