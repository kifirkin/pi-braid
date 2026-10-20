/**
 * Input resolution for the browser tools' numeric selectors.
 *
 * Why this module exists: pi validates a tool call before a handler runs, and
 * that validation rewrites blanks. `validateToolArguments` runs TypeBox
 * `Value.Convert` over the raw arguments, and Convert turns a blank string
 * into the number 0 for `Type.Optional(Type.Number())`; the converted value
 * then passes the schema check. A handler therefore cannot tell a blank key
 * (a client that emits every schema key sends "") from a typed 0, and
 * `params.x ?? default` keeps that 0 as a real selector. That produced a
 * root-only DOM snapshot, a browser_tabs_wait timeout that never waited, a
 * navigation that skipped its settle wait, and a 0-quality JPEG.
 *
 * The rule these resolvers encode: a blank, absent or non-positive selector
 * means "use the documented default", and only a finite positive number is a
 * selector. Because blank and typed 0 are indistinguishable once they reach a
 * handler, a typed 0 is read as the default too. That is deliberate: none of
 * these parameters has a useful 0. A zero deadline reports a timeout that
 * never elapsed, a zero DOM depth asks Chrome to retrieve no children, and a
 * zero-quality JPEG is not a usable artifact; a caller that wants the
 * smallest real value asks for 1.
 *
 * Every resolver is pure so the test can drive it without a browser, and
 * `positiveNumber` is the single guard they all share.
 */
import { DEFAULT_JPEG_QUALITY } from "./capture-plan.js";

/**
 * Read a numeric selector. Absent, blank (already converted to 0), negative,
 * NaN and Infinity are all "not provided"; only a finite positive number is
 * present.
 */
export function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** A CDP document depth of -1 asks for the whole subtree. */
const UNLIMITED_DOM_DEPTH = -1;

/** Render cap for the DOM tree's indentation when no depth was requested. */
const DEFAULT_INDENT_CAP = 10;

/** CDP document depth for browser_snapshot (default: the whole subtree). */
export function resolveSnapshotDepth(value: unknown): number {
  return positiveNumber(value) ?? UNLIMITED_DOM_DEPTH;
}

/**
 * Indentation cap for the rendered snapshot. Same selector as the CDP depth,
 * but the unlimited depth cannot be used as a cap: the tree is rendered with
 * DEFAULT_INDENT_CAP levels when the caller asked for everything.
 */
export function resolveSnapshotIndent(value: unknown): number {
  return positiveNumber(value) ?? DEFAULT_INDENT_CAP;
}

/** browser_tabs_wait's documented wait budget. */
const TABS_WAIT_TIMEOUT_MS = 30000;

/** Wait budget for browser_tabs_wait (default: 30000ms). */
export function resolveTabsWaitTimeoutMs(value: unknown): number {
  return positiveNumber(value) ?? TABS_WAIT_TIMEOUT_MS;
}

/**
 * The post-navigation settle wait, which is also its cap. browser_navigate
 * shares the `timeout` parameter with the other tools (documented 30000ms),
 * but this site never waits longer than 2000ms, so an absent value settles on
 * the cap and a longer request is still reduced to it.
 */
const NAVIGATE_SETTLE_MS = 2000;

/** Settle wait for browser_navigate (default 2000ms, capped at 2000ms). */
export function resolveNavigateSettleMs(value: unknown): number {
  return Math.min(
    positiveNumber(value) ?? NAVIGATE_SETTLE_MS,
    NAVIGATE_SETTLE_MS,
  );
}

/**
 * JPEG quality: only the presence test moves, the clamp stays as it was. A
 * fractional value below 0.5 therefore still rounds down to 0, which is the
 * clamp's own long-standing behaviour and not the blank path this fix closes.
 */
export function resolveJpegQuality(value: unknown): number {
  const quality = positiveNumber(value) ?? DEFAULT_JPEG_QUALITY;
  return Math.min(100, Math.max(0, Math.round(quality)));
}
