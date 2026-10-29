/**
 * The tool families a skill declares it governs.
 *
 * A trigger phrase says WHEN to open a skill file; nothing in the file says
 * what the file's advice is then used FOR. `governs:` closes that: the tool
 * families whose calls the body is written to direct. A family is the tool
 * name's first underscore-delimited segment (`search_documents` → `search`),
 * the same token `loading-guidance.ts` pairs with a skill name in the
 * mechanical trigger, so "before the first call in the family" in the prompt
 * and "a call in a declared family" in the record cannot mean two things.
 *
 * The declaration is authored data in the skill's own frontmatter — pi's
 * parser already returns it, and the pack's authoring contract already admits
 * any YAML-valid extra key. No new file format and no new field parser is
 * needed, which is why this module only reads.
 *
 * Most skills govern nothing: advice about prose, a palette or a checklist
 * directs no tool, and a file without the key is read as declaring no family.
 * The absence is a fact, not a gap — an obligation that names no family is
 * satisfied by the read alone.
 *
 * A declared family may not be the detector's own tool (`read`): a call to it
 * IS the read leg, so counting it as an applied call would let an obligation
 * satisfy itself. The parser drops such an entry; the shipped pack's contract
 * refuses it by name so an author sees the problem before a release.
 *
 * Nothing here names a skill, a package or a path. Reads are memoized by file
 * mtime + size, so a turn pays one stat per skill file and a parse only when
 * a file changed.
 */

import { readFileSync, statSync } from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * Max families read from one declaration. A body that directs more than four
 * tool families is not one skill's job, and the record's per-session rows are
 * bounded by the same number. The pack's contract mirrors this cap.
 */
export const MAX_GOVERNED_FAMILIES = 4;

/** The token shape a declaration must use: a tool name's first segment. */
export const GOVERNED_FAMILY_SHAPE = /^[a-z][a-z0-9]*$/;

/**
 * The tool whose call is the read leg itself. Never a declarable family: see
 * the module header.
 */
export const DETECTOR_TOOL = "read";

/** The family a tool name belongs to: its first underscore-delimited segment. */
export function toolFamilyToken(toolName: string): string {
  return (toolName ?? "").split("_")[0].toLowerCase();
}

/**
 * Normalize a frontmatter `governs` value into family tokens. Accepts a YAML
 * list or a comma-separated string, lowercases, drops malformed, detector, and
 * surplus entries, and dedupes in authored order. Pure.
 */
export function parseGovernedFamilies(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const families: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const family = item.trim().toLowerCase();
    if (!GOVERNED_FAMILY_SHAPE.test(family) || family === DETECTOR_TOOL) continue;
    if (families.includes(family)) continue;
    families.push(family);
    if (families.length >= MAX_GOVERNED_FAMILIES) break;
  }
  return families;
}

interface FamilyCacheEntry {
  mtimeMs: number;
  size: number;
  families: string[];
}

const cache = new Map<string, FamilyCacheEntry>();

/**
 * Read the families a skill file declares. Missing or unreadable file, or
 * malformed frontmatter, yields an empty list (a declaration that cannot be
 * read is not a declaration). Memoized: an unchanged file never re-reads.
 */
export function readGovernedFamilies(filePath: string): string[] {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    cache.delete(filePath);
    return [];
  }
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.families;
  let families: string[] = [];
  try {
    const { frontmatter } = parseFrontmatter(readFileSync(filePath, "utf-8"));
    families = parseGovernedFamilies((frontmatter as Record<string, unknown>).governs);
  } catch {
    // Unreadable or unparseable: no declared family, and no throw on a turn.
  }
  cache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, families });
  return families;
}

/** Test seam: forget every memoized read. */
export function clearGovernedFamilyCache(): void {
  cache.clear();
}
