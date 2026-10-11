/**
 * Project docs section for the prompt-builder.
 *
 * Renders AGENTS.md / CLAUDE.md files as plain-text pointer lines
 * (`- <basename> at <path>`), one per file, under a directive to read
 * them in full before editing. No content is injected — the agent
 * reads files on demand via `read` (project docs can be stale;
 * pointer-only matches the skills convention; plain text avoids XML
 * ceremony and path escaping). Rendered string is cached per file-set
 * fingerprint, invalidated via `resetProjectDocsSectionCache()` on
 * RESOURCES_DISCOVER.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../../lib/state/extension-state.js";

/** A project context file as returned by pi-native's `loadProjectContextFiles`. */
export interface ProjectContextFile {
  path: string;
  content: string;
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Build the project-docs pointer section as plain text.
 * Returns empty string if no docs.
 *
 * Shape:
 *   Read the project docs in full before editing the areas they cover: the
 *   AGENTS.md / CLAUDE.md files below are this project's authoritative contract —
 *   cross-check references against source.
 *
 *   - AGENTS.md at /abs/path/AGENTS.md
 *   - CLAUDE.md at /abs/path/CLAUDE.md
 *
 * The directive is imperative and project-scoped: fresh sessions must
 * actually read the docs before editing. Pointer-only — no file content
 * is injected; the bullets name the files for on-demand `read`.
 */
export async function projectDocsSection(
  contextFiles: readonly ProjectContextFile[],
): Promise<string> {
  if (contextFiles.length === 0) {
    return "";
  }

  const lines: string[] = [
    "Read the project docs in full before editing the areas they cover: the AGENTS.md / CLAUDE.md files below are this project's authoritative contract — cross-check references against source.",
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
