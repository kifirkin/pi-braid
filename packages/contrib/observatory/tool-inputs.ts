/**
 * Input resolution for the observatory tool's event tail.
 *
 * Why this module exists: `Type.Optional(Type.Integer())` passes through the
 * framework's validation unchanged for a positive value, but Convert rewrites
 * a blank string to 0 before the schema check. `Math.min(params.limit ?? 20,
 * 200)` then handed 0 to the tail, which took no events and returned an empty
 * list, so the tool reported "(no events recorded yet)" for a system whose
 * log had events. A negative count behaves the same way.
 *
 * The rule: only a finite positive count selects events; anything else means
 * the documented default of 20, still capped at the documented maximum. A
 * zero-length tail is not a request anyone can act on, and blank is
 * indistinguishable from a typed 0 once it reaches the handler.
 */

/** Events returned when no count was provided, as documented on the schema. */
const DEFAULT_EVENT_LIMIT = 20;

/** The schema's documented ceiling for one tail. */
const MAX_EVENT_LIMIT = 200;

/**
 * Number of recent events to return (default: 20, capped at 200). Absent,
 * blank (already converted to 0), negative, NaN and Infinity all mean the
 * default.
 */
export function resolveEventLimit(value: unknown): number {
  const requested =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_EVENT_LIMIT;
  return Math.min(requested, MAX_EVENT_LIMIT);
}
