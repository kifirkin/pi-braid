/**
 * Project docs section for the prompt-builder.
 *
 * Mirrors the skills model: a `<available_project_docs>` block listing
 * each AGENTS.md / CLAUDE.md file with metadata (name, location, line
 * count, section headings). NO content is injected into the system
 * prompt — the agent reads full content on demand via the `read` tool.
 *
 * Why pointer-only (and not the previous verbatim injection):
 *
 *   1. Project docs are project-LOCAL content. They may be stale, may
 *      reference events that haven't happened, or may contain forward
 *      references to anticipated patterns. Verbatim injection primes
 *      the agent to pattern-match against those references when parsing
 *      ambiguous external output (e.g., scraped DOM data).
 *
 *   2. The skills section has been using the pointer model since Braid
 *      started. It works — the agent reads full skill content on demand.
 *      Project docs should follow the same proven pattern.
 *
 *   3. Token cost: a 33KB AGENTS.md injected on every turn is far more
 *      expensive than a ~500-byte pointer block + occasional re-reads.
 *
 * Cache: rendered string is cached per file-set fingerprint so we don't
 * re-read every AGENTS.md on every turn. Invalidated by
 * `resetProjectDocsSectionCache()` on `RESOURCES_DISCOVER` (mirrors the
 * skills-section invalidation pattern).
 */

import { readFile } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../../lib/state/extension-state.js";

/** A project context file as returned by pi-native's `loadProjectContextFiles`. */
export interface ProjectContextFile {
  path: string;
  content: string;
}

/** Metadata extracted from a project doc, for the pointer block. */
interface ProjectDocMeta {
  totalLines: number;
  sections: string[];
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** Count lines and extract `## / ###` section headings from a project doc. */
async function getProjectDocMeta(filePath: string): Promise<ProjectDocMeta> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const sections: string[] = [];
    for (const line of lines) {
      const match = line.match(/^#{2,3}\s+(.+)$/);
      if (match) sections.push(match[1].trim());
    }
    return { totalLines: lines.length, sections: sections.slice(0, 8) };
  } catch {
    return { totalLines: 0, sections: [] };
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Build the `<available_project_docs>` section. Returns empty string if no docs. */
export async function projectDocsSection(
  contextFiles: readonly ProjectContextFile[],
): Promise<string> {
  if (contextFiles.length === 0) {
    return "";
  }

  const lines = [
    "Project documentation is your first knowledge in context. Read the relevant ones with the `read` tool before starting a task — they may include stale references to past events or anticipated patterns, so cross-check before acting on time-sensitive claims.",
    "<available_project_docs>",
  ];

  for (const file of contextFiles) {
    const meta = await getProjectDocMeta(file.path);
    lines.push("  <project_doc>");
    lines.push(`    <name>${escapeXml(basename(file.path))}</name>`);
    lines.push(`    <description>Project documentation</description>`);
    lines.push(`    <location>${escapeXml(file.path)}</location>`);
    lines.push(`    <lines>${meta.totalLines}</lines>`);
    if (meta.sections.length > 0) {
      lines.push(`    <sections>${meta.sections.join(" | ")}</sections>`);
    }
    lines.push("  </project_doc>");
  }

  lines.push("</available_project_docs>");
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
