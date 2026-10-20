/**
 * What a SKILL.md costs before it is read.
 *
 * `list_skills` is a choice between reads, and a row that names a path but
 * prices nothing leaves that choice blind: a 650-byte pointer and a 25KB
 * reference look identical until one of them is already in context. The fields
 * here are the price - line count, byte count, character count, a token
 * estimate, and the file's ATX headings with line numbers, which is the
 * cheapest useful table of contents for "read section 88 and stop".
 *
 * Counts are the whole file, frontmatter included: the question a reader is
 * asking is what the `read` call will cost, not what the body costs.
 *
 * One read per change. The cache is keyed on mtime + size, the same
 * invalidation `skill-triggers.ts` uses: a page render stats every row, and
 * only a first-seen or changed file is opened and parsed. Failures are not
 * cached, because a chmod that took away read access leaves mtime untouched -
 * a cached failure would outlive the repair.
 *
 * Headings are parsed fence-aware. Skill files carry long fenced blocks of
 * shell, TypeScript and markdown samples whose comment lines start with `#`;
 * on the installed core pack the fence-unaware count is several times the real
 * heading count, so a naive parse advertises sections that do not exist.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Characters per token. The same divisor the pre-send guard uses
 * (`packages/providers/presend-guard.ts`, `CHARS_PER_TOKEN`) and the one
 * pi-core's `estimateTokens` applies, so a reach estimate and a payload
 * estimate are comparable numbers rather than two private conventions.
 * Declared here instead of imported: providers is a standalone package with no
 * import path into core.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Headings reported per skill when the caller does not ask for another cap.
 *
 * Six is a prompt-budget number, not a taste one: with the shipped pack the
 * heaviest ten-row page of the pretty-printed catalog measures ~10.8KB at six
 * headings and crosses the 12KB page bound at eight. Callers who want the full
 * contents pass `sectionsMax` (up to SECTIONS_MAX_LIMIT).
 */
export const DEFAULT_SECTIONS_MAX = 6;

/** A heading is a table-of-contents entry, not a paragraph. */
const SECTION_TEXT_MAX = 80;

/** Upper bound on the per-skill heading cap - a request above it is a bug. */
export const SECTIONS_MAX_LIMIT = 64;

/**
 * ATX heading: up to three spaces of indent (four would be an indented code
 * block), one to six `#`, then a space or the end of the line - so `#region`
 * in a TypeScript sample is not a heading.
 */
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;

/** A heading's optional closing sequence: `## Title ##`. */
const CLOSING_HASHES = /[ \t]+#+$/;

/** A fence line: up to three spaces of indent, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface SkillSection {
  /** 1-indexed line the heading sits on. */
  line: number;
  /** Heading text with its leading `#`s stripped, trimmed, capped. */
  text: string;
}

export interface SkillReach {
  reachable: true;
  lines: number;
  bytes: number;
  chars: number;
  estTokens: number;
  /** Total headings in the file, independent of the per-call report cap. */
  sectionCount: number;
  /** Omitted when the caller asked for no section list. */
  sections?: SkillSection[];
}

export interface UnreachableReach {
  reachable: false;
  /** Stat size when stat() succeeded and the read failed; absent otherwise. */
  bytes?: number;
}

export type Reach = SkillReach | UnreachableReach;

interface ReachCacheEntry {
  mtimeMs: number;
  size: number;
  reach: SkillReach;
}

const cache = new Map<string, ReachCacheEntry>();

/**
 * Lines in a file's text, by the rule every editor and `wc -l` agree on: a
 * trailing newline ends the last line rather than starting a phantom one, and
 * an empty file has no lines.
 */
export function countLines(text: string): number {
  if (text === "") return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") newlines++;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/**
 * Headings in document order, skipping fenced blocks. A fence opens on a run
 * of backticks or tildes (with or without an info string) and closes only on a
 * run of the same character at least as long, so a `~~~` sample inside a
 * backtick fence is content, not a delimiter. A backtick run followed by more
 * backticks (` ```a`` `) is not a fence at all, per CommonMark.
 */
function scanHeadings(text: string): SkillSection[] {
  const headings: SkillSection[] = [];
  let fence: { marker: string; length: number } | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
    const fenceLine = FENCE.exec(line);
    if (fence) {
      if (
        fenceLine &&
        fenceLine[1][0] === fence.marker &&
        fenceLine[1].length >= fence.length &&
        fenceLine[2].trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceLine && !(fenceLine[1][0] === "`" && fenceLine[2].includes("`"))) {
      fence = { marker: fenceLine[1][0], length: fenceLine[1].length };
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (!heading) continue;
    const text = (heading[2] ?? "").replace(CLOSING_HASHES, "").trim();
    headings.push({
      line: i + 1,
      text: text.length > SECTION_TEXT_MAX ? text.slice(0, SECTION_TEXT_MAX) : text,
    });
  }
  return headings;
}

/** Clamp a caller-supplied heading cap into range; 0 means "no list". */
export function clampSectionsMax(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (Number.isNaN(n)) return DEFAULT_SECTIONS_MAX;
  if (n <= 0) return 0;
  return Math.min(n, SECTIONS_MAX_LIMIT);
}

/**
 * Reach for one SKILL.md. A file that cannot be stat'ed or read answers
 * `reachable: false` instead of throwing: the catalog has to render, and one
 * unreadable skill must not take the page down with it.
 *
 * `sectionsMax` caps the returned heading list; the cached parse keeps the
 * whole list, so two callers asking for different caps share one read.
 */
export function readSkillReach(
  filePath: string,
  sectionsMax: number = DEFAULT_SECTIONS_MAX,
): Reach {
  const key = resolve(filePath);
  let size: number;
  let mtimeMs: number;
  try {
    const stat = statSync(key);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    cache.delete(key);
    return { reachable: false };
  }
  let entry = cache.get(key);
  if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) {
    let text: string;
    try {
      text = readFileSync(key, "utf-8");
    } catch {
      cache.delete(key);
      return { reachable: false, bytes: size };
    }
    const headings = scanHeadings(text);
    entry = {
      mtimeMs,
      size,
      reach: {
        reachable: true,
        lines: countLines(text),
        bytes: size,
        chars: text.length,
        estTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
        sectionCount: headings.length,
        sections: headings,
      },
    };
    cache.set(key, entry);
  }
  const { sections: all = [], ...scalars } = entry.reach;
  const cap = clampSectionsMax(sectionsMax);
  if (cap === 0) return scalars;
  return { ...scalars, sections: cap >= all.length ? all : all.slice(0, cap) };
}

/** Test seam: forget every memoized reach measurement. */
export function clearReachCache(): void {
  cache.clear();
}
