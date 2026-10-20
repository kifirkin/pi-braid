/**
 * Input resolution for the repl tool's numeric limits.
 *
 * Why this module exists: pi validates a tool call before the handler runs,
 * and that validation runs TypeBox `Value.Convert` over the raw arguments.
 * Convert turns a blank string into the number 0 for
 * `Type.Optional(Type.Number())`, and the converted value then passes the
 * schema check. A handler therefore cannot tell a blank key (a client that
 * emits every schema key sends "") from a typed 0, and
 * `params.timeout_ms ?? 30000` kept that 0 as a real deadline: the evaluation
 * rejected with "Execution timed out after 0ms" before the code ran.
 * `params.max_calls ?? 10` set the recursion bound to 0, so the first
 * `ctx.subCall` threw "Max recursion depth (0) exceeded" at depth 0.
 *
 * The rule these resolvers encode: only a finite positive number is a limit.
 * Anything else is "not provided" and the documented default applies. Neither
 * parameter has a useful 0: a zero deadline reports a timeout that never
 * elapsed, and a zero sub-call bound forbids the recursion RLM mode exists
 * for. Because blank and typed 0 are indistinguishable once they reach a
 * handler, a typed 0 is read as the default too.
 */

/** Max recursive sub-calls per RLM invocation, as documented on the schema. */
const DEFAULT_MAX_CALLS = 10;

/** Evaluation deadline in milliseconds, as documented on the schema. */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Read a numeric limit. Absent, blank (already converted to 0), negative,
 * NaN and Infinity are all "not provided"; only a finite positive number is
 * present.
 */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** Recursion bound for `ctx.subCall` (default: 10). */
export function resolveMaxCalls(value: unknown): number {
  return positiveNumber(value) ?? DEFAULT_MAX_CALLS;
}

/** Evaluation deadline in milliseconds (default: 30000). */
export function resolveTimeoutMs(value: unknown): number {
  return positiveNumber(value) ?? DEFAULT_TIMEOUT_MS;
}
