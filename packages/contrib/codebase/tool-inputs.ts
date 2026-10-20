/**
 * Input resolution for the codebase tool's tree depth and graph filter.
 *
 * Why this module exists: `Type.Optional(Type.Integer())` converts a blank
 * string to 0 before the schema check, so `Math.min(params.maxDepth ?? 3, 10)`
 * produced a depth of 0 and the tree stopped at the root entry. The graph
 * filter had the mirror problem with strings: `params.find ?? "all"` keeps a
 * blank, and a blank selects no section, leaving a header-only graph.
 *
 * The rules: a depth is a finite positive integer, anything else means the
 * documented default (3), and the documented ceiling still caps it. A find
 * mode is one of the five the schema accepts; blank or absent means "all".
 * A typed 0 depth is read as the default too, because Convert makes it
 * indistinguishable from a blank key, and the schema documents no zero-depth
 * tree.
 */

/** Depth walked when no depth was provided, as documented on the schema. */
export const DEFAULT_MAX_DEPTH = 3;

/** The schema's documented ceiling on the walked depth. */
export const MAX_MAX_DEPTH = 10;

/** The graph filters the schema accepts. */
export const FIND_MODES = [
  "dead-ends",
  "orphans",
  "hubs",
  "cycles",
  "all",
] as const;

export type FindMode = (typeof FIND_MODES)[number];

/**
 * Tree depth to walk (default: 3, capped at 10). Absent, blank (already
 * converted to 0), negative, fractional, NaN and Infinity mean the default.
 */
export function resolveMaxDepth(value: unknown): number {
  const requested =
    typeof value === "number" && Number.isInteger(value) && value > 0
      ? value
      : DEFAULT_MAX_DEPTH;
  return Math.min(requested, MAX_MAX_DEPTH);
}

/**
 * Graph filter (default: "all"). Blank or absent means the default; the schema
 * is a closed union, so a value outside it is refused before this runs and
 * "all" is only the backstop for a handler called directly.
 */
export function resolveFind(value: unknown): FindMode {
  return typeof value === "string" &&
    (FIND_MODES as readonly string[]).includes(value)
    ? (value as FindMode)
    : "all";
}
