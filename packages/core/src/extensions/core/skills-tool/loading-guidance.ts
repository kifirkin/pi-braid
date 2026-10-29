/**
 * Skills floor, owned by the skills-tool module: the visible catalog section
 * and the drift trigger that re-points at it.
 *
 * prompt-builder imports the section text and renders it as the
 * "skills-loading" section ONLY when both `read` and `list_skills` are active
 * tools.
 *
 * Why the catalog is rendered instead of described. A pointer the model has
 * to redeem with a tool call is a probability, not a mechanism: the first
 * prompt of a resumed session is thin ("let's pick up where we left off"),
 * the catalog is one call away, and nothing in a thin prompt demands it.
 * Rendering every visible skill as one `- name: description` row removes the
 * redemption step, so a domain match needs only the task text in front of the
 * model, not a decision to go look. The row is metadata; the file is still
 * the knowledge, and the rule below says so.
 *
 * The read path is derived from the entries' own paths, never hardcoded: the
 * same text renders for a checkout, an npm install tree, or a worktree. A
 * catalog installed from more than one pack has no single root, so each
 * directory heads its own group of rows instead of one root being named for
 * all of them (a root that resolves for 22 rows and misdirects the other 5 is
 * worse than no root at all).
 *
 * The mechanical trigger's worked examples are derived at assembly time from
 * the live tool and skill names: a tool's family token paired with an
 * installed visible skill's dash-token. The text never hardcodes a tool or
 * skill name, so it cannot name a pair that does not exist in the running
 * session; when no pair computes, the sentence renders without a
 * parenthetical.
 *
 * The same module owns the drift trigger (below): work that moves to a new
 * directory is the moment a visible catalog stops matching the task text in
 * view, and the trigger re-points at the catalog with one line. Its state is
 * plain data and its decisions are pure functions, so the wiring lives in
 * auto-inject.ts and the reasoning stays testable here.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { toolFamilyToken } from "./skill-families.js";

/** One visible skill as the floor renders it. */
export interface CatalogEntry {
  name: string;
  description: string;
  filePath: string;
}

/**
 * Paragraph 1: what the catalog is, where the bodies live, and the obligation.
 *
 * `readRoot` is the single pack directory the rule can state; `grouped` says
 * the rows are rendered under directory headings instead, so the rule points
 * at the heading rather than at a root that does not exist. Neither given (a
 * catalog whose bodies carry no pack) leaves the location unstated, which is
 * the honest answer when the paths cannot be derived.
 */
export function skillsCatalogRule(readRoot: string, grouped = false): string {
  const readPath = readRoot
    ? ` Each row's body is at \`${readRoot}/<name>/SKILL.md\`.`
    : grouped
      ? ` Each row's body is at \`<dir>/<name>/SKILL.md\`, where \`<dir>\` is the row's directory heading.`
      : "";
  return `This catalog is every installed skill: one row per skill, name and description.${readPath} When the task enters a listed skill's domain, read the WHOLE SKILL.md before acting in that domain; never act from memory of a skill's contents.`;
}

/** Paragraph 2: the pointer rule (pinned verbatim by test-prompt-budget.mjs). */
export const SKILLS_POINTER_RULE = `Pointer rule: the catalog one-liner is metadata, not content — the SKILL.md path is the knowledge. The prompt already covering the domain is the only reason to skip the read.`;

const MECHANICAL_TRIGGER_LEAD = `Mechanical trigger, no judgment call: about to use a tool family whose word appears in a skill's name`;
const MECHANICAL_TRIGGER_TAIL = `→ read that SKILL.md before the first call in the family.`;

/** Forward-slash form of a path, for segment arithmetic on either platform. */
function toSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Sorted by name, byte-comparison so the order never depends on the locale. */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One directory a catalog's bodies live in, with the skills filed under it. */
export interface CatalogGroup {
  /** The pack directory itself, in forward-slash form. */
  dir: string;
  skills: CatalogEntry[];
}

/**
 * The pack directory a skill's body sits in. pi's layout is
 * `<pack>/<skill-name>/SKILL.md`, so the pack is two levels above the file;
 * the row's stated path is `<pack>/<name>/SKILL.md`. A path too short to have
 * a pack reports "", and its group renders without a heading.
 */
function packOf(filePath: string): string {
  const parts = toSlashes(filePath ?? "").split("/");
  if (parts.length < 3) return "";
  return parts.slice(0, -2).join("/");
}

/**
 * File the entries by the pack their own SKILL.md lives in: the braid pack
 * plus the user-global directory is two groups in one catalog. Groups and
 * rows are sorted, so identical catalogs render byte-identical text in any
 * cache order. Pure.
 */
export function catalogGroups(skills: CatalogEntry[]): CatalogGroup[] {
  const byDir = new Map<string, CatalogEntry[]>();
  for (const skill of skills) {
    const dir = packOf(skill.filePath ?? "");
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(skill);
    else byDir.set(dir, [skill]);
  }
  return [...byDir.keys()].sort(byName).map((dir) => ({ dir, skills: byDir.get(dir) ?? [] }));
}

/**
 * The one directory every entry lives under, or "" when they do not share
 * one: a single root is a fact a caller may state, and a common ancestor of
 * two packs is not. Pure.
 */
export function skillReadRoot(skills: CatalogEntry[]): string {
  const groups = catalogGroups(skills);
  return groups.length === 1 ? groups[0].dir : "";
}

/**
 * One row per skill: `- name: description`, whitespace collapsed to a single
 * line. Descriptions are NOT clipped: the row is the whole reason the floor
 * works, and a clipped description is what a model would have to guess from.
 * Pure.
 */
export function catalogRows(skills: CatalogEntry[]): string[] {
  return [...skills]
    .sort((a, b) => byName(a.name, b.name))
    .map((s) => {
      const description = (s.description ?? "").replace(/\s+/g, " ").trim();
      return description ? `- ${s.name}: ${description}` : `- ${s.name}`;
    });
}

/**
 * Worked examples for the mechanical trigger, derived from the live inputs.
 *
 * A pair exists when a tool's family token (the first underscore-delimited
 * token of the tool name: `widget_open` → `widget`) equals a dash-delimited
 * token of a skill name (`widget-map` → `widget`), case-insensitively.
 * One example renders per distinct family token: the trigger fires per
 * family ("before the first call in the family"), so enumerating every tool
 * in a family would restate one fact; the representative tool is the
 * lexicographically smallest active tool carrying that token. The arrow
 * target keeps the skill's own casing. Sorted by family token, so identical
 * inputs render byte-identical text in any input order, and no tool or skill
 * outside the inputs is ever named.
 */
export function mechanicalTriggerExamples(toolNames: string[], skillNames: string[]): string[] {
  // Family token (lowercased) -> lexicographically smallest active tool name.
  const familyTool = new Map<string, string>();
  for (const tool of toolNames) {
    const family = toolFamilyToken(tool);
    const incumbent = familyTool.get(family);
    if (incumbent === undefined || tool < incumbent) familyTool.set(family, tool);
  }
  // Family token (lowercased) -> the matched skill token in the skill's own
  // casing, taken from the lexicographically smallest matching skill name
  // (order-independent when several skills spell the token differently).
  const tokenCasing = new Map<string, { casing: string; skill: string }>();
  for (const skill of skillNames) {
    for (const token of skill.split("-")) {
      if (!token) continue;
      const family = token.toLowerCase();
      if (!familyTool.has(family)) continue;
      const incumbent = tokenCasing.get(family);
      if (incumbent === undefined || skill < incumbent.skill) {
        tokenCasing.set(family, { casing: token, skill });
      }
    }
  }
  return [...tokenCasing.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([family, { casing }]) => `\`${familyTool.get(family)}\` → ${casing}`);
}

/**
 * The full skills-loading section: catalog rule (with the derived read path),
 * pointer rule, one row per visible skill, and the mechanical trigger with
 * only the pairs computed from the given tool and skill names.
 *
 * prompt-builder feeds it the active tool names and the skills-tool module's
 * visible catalog. An empty catalog renders no section: the floor is a
 * catalog, and a section claiming to list every skill while listing none
 * would be a lie the model has no way to check.
 *
 * One pack renders its root in the rule; several packs render a directory
 * heading before each group of rows, because no single root describes them.
 */
export function skillsLoadingText(toolNames: string[], skills: CatalogEntry[]): string {
  if (!skills.length) return "";
  const examples = mechanicalTriggerExamples(
    toolNames,
    skills.map((s) => s.name),
  );
  const trigger =
    examples.length > 0
      ? `${MECHANICAL_TRIGGER_LEAD} (${examples.join(", ")}) ${MECHANICAL_TRIGGER_TAIL}`
      : `${MECHANICAL_TRIGGER_LEAD} ${MECHANICAL_TRIGGER_TAIL}`;
  const groups = catalogGroups(skills);
  const grouped = groups.length > 1;
  const rows = grouped
    ? groups
        .map((g) =>
          g.dir
            ? `${g.dir}\n${catalogRows(g.skills).join("\n")}`
            : catalogRows(g.skills).join("\n"),
        )
        .join("\n\n")
    : catalogRows(groups[0].skills).join("\n");
  return `${skillsCatalogRule(skillReadRoot(skills), grouped)}\n\n${SKILLS_POINTER_RULE}\n\n${rows}\n\n${trigger}\n`;
}

// Drift trigger
//
// The floor is a snapshot: the catalog does not change mid-session, but the
// work does. A session that starts in one directory and moves to another has
// its catalog in view and its task text elsewhere, which is the same silent
// prompt the floor exists for. The trigger watches where the path-taking
// tools actually write and reads, and when a new directory accumulates
// entries it says so in one line, pointing back at the catalog.
//
// Bounds, all deliberate:
//   - two entries in one directory before it counts: a single stray read is
//     not where the work is.
//   - at most one fire per DRIFT_WINDOW_CALLS tool calls, and quiet for the
//     same window after any skill surface (a suggestion or a SKILL.md read),
//     because a surface that just landed is the pointer the trigger exists to
//     supply.
//   - at most DRIFT_MAX_FIRES per session, so the line stays a signal.
//   - a directory is announced once; the entry counts restart after a fire,
//     so the budget is spent on directories the session has not been told
//     about.
//   - paths with fewer than two directory segments are ignored: repo-root
//     files and top-level directories are where a session starts, not where
//     it moved to.

/** The path-taking tools whose calls describe where the work is. */
export const DRIFT_PATH_TOOLS = ["read", "edit", "write"] as const;

/** Tool calls that must pass between fires, and after any skill surface. */
export const DRIFT_WINDOW_CALLS = 12;

/** Fires per session. */
export const DRIFT_MAX_FIRES = 3;

/** Entries in one directory before it counts as where the work is. */
export const DRIFT_ENTRIES = 2;

/** Directory segments a path must carry before it can name a work area. */
export const DRIFT_MIN_SEGMENTS = 2;

/** Drift state, session-scoped plain data (see auto-inject.ts for the holder). */
export interface DriftTracker {
  /** Tool results seen this session: the clock both window guards read. */
  calls: number;
  /** Call index of the last fire; null before the first. */
  lastFire: number | null;
  /** Fires this session. */
  fires: number;
  /** Call index of the last skill surface; null before the first. */
  lastSurface: number | null;
  /** Directory -> entries seen since the last fire. */
  entries: Record<string, number>;
  /** Directories already announced (each is announced once). */
  announced: string[];
}

/** Fresh drift state for a session. */
export function initialDrift(): DriftTracker {
  return { calls: 0, lastFire: null, fires: 0, lastSurface: null, entries: {}, announced: [] };
}

/**
 * The work area a finished tool call touched: the first two directory
 * segments of its path, relative to the session's project root. Undefined for
 * a tool that takes no path, a path outside the project, and a path with
 * fewer than DRIFT_MIN_SEGMENTS directories. Pure.
 */
export function driftDirectoryFor(
  toolName: string | undefined,
  inputPath: string | undefined,
  cwd: string,
): string | undefined {
  if (!toolName || !(DRIFT_PATH_TOOLS as readonly string[]).includes(toolName)) return undefined;
  if (!inputPath || !cwd) return undefined;
  const root = resolve(cwd);
  const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  const inside = relative(root, absolute);
  const segments = inside.split(sep).filter(Boolean);
  if (!segments.length || segments[0] === "..") return undefined;
  const directories = segments.slice(0, -1);
  if (directories.length < DRIFT_MIN_SEGMENTS) return undefined;
  return directories.slice(0, DRIFT_MIN_SEGMENTS).join("/");
}

/**
 * Count one finished tool call and answer whether it is a fire.
 *
 * Returns the work area to announce, or null. The caller fires the line and
 * then calls recordDriftFire (on delivery) or recordDriftDrop (when the
 * whisper was suppressed), so a dropped line never spends the budget. The
 * tracker is the session's own mutable state; the answer is a pure function
 * of its contents.
 */
export function advanceDrift(tracker: DriftTracker, directory: string | undefined): string | null {
  tracker.calls++;
  if (!directory) return null;
  if (tracker.fires >= DRIFT_MAX_FIRES) return null;
  const entries = (tracker.entries[directory] ?? 0) + 1;
  tracker.entries[directory] = entries;
  if (entries < DRIFT_ENTRIES) return null;
  if (tracker.announced.includes(directory)) return null;
  if (tracker.lastFire !== null && tracker.calls - tracker.lastFire < DRIFT_WINDOW_CALLS)
    return null;
  if (tracker.lastSurface !== null && tracker.calls - tracker.lastSurface < DRIFT_WINDOW_CALLS) {
    return null;
  }
  return directory;
}

/** Mark a fire at the current call: spends one fire, announces, restarts counts. */
export function recordDriftFire(tracker: DriftTracker, directory: string): void {
  tracker.fires++;
  tracker.lastFire = tracker.calls;
  if (!tracker.announced.includes(directory)) tracker.announced.push(directory);
  tracker.entries = {};
}

/**
 * Mark a fire attempt whose whisper was suppressed: no fire is spent and the
 * directory is not announced, but the counts restart and the window opens, so
 * a suppressed line is retried only after the session has done more work.
 */
export function recordDriftDrop(tracker: DriftTracker): void {
  tracker.lastFire = tracker.calls;
  tracker.entries = {};
}

/** Note that a skill surface (a suggestion or a SKILL.md read) just landed. */
export function noteDriftSurface(tracker: DriftTracker): void {
  tracker.lastSurface = tracker.calls;
}

/**
 * The one-line steer: the work area and a pointer back at the catalog in the
 * prompt. `readRoot` empty (several packs, see skillReadRoot) drops the path
 * clause instead of naming a path that may not resolve.
 */
export function driftPayload(directory: string, readRoot: string): string {
  const pointer = readRoot
    ? `read \`${readRoot}/<name>/SKILL.md\``
    : `read the matching skill's SKILL.md`;
  return `[SKILL INDEX] work is in ${directory}. Catalog above; ${pointer}.`;
}
