// Fixture reader for the schema gate tests. Mirrors the braid reader shape:
// a DEFAULTS-style constant (with a leading JSDoc) plus a key-path read.

export const CAP_DEFAULTS = {
  /** Gate on by default. */
  enabled: true,
  maxChars: 4_000,
  windowMs: 20 * 60 * 1000,
} as const;

export const CAP_LIMIT = 1234;

export function readCap(parsed: { braid?: { ctx?: { cap?: unknown } } }) {
  return parsed.braid?.ctx?.cap;
}
