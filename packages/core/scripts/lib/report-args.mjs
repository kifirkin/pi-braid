/**
 * Shared CLI parsing and number formatting for the memory report scripts
 * (memory-junk-scan.mjs, memory-write-log-metrics.mjs).
 *
 * Both scripts expose the same option shape: --file, --since, --weeks,
 * --json, --help, with the same exit contract (2 = invalid usage). Each
 * script keeps its own default file and usage text; the parsing rules and
 * the week bounds live here so the two cannot drift apart.
 */

/** Invalid usage is the one non-zero exit: the caller asked for something that has no report. */
export class UsageError extends Error {}

/** Default trailing window for the weekly tables, weeks. */
export const DEFAULT_WEEKS = 4;

/** Maximum trailing window the weekly tables accept, weeks. */
export const MAX_WEEKS = 52;

export function parseWeeks(value, maxWeeks = MAX_WEEKS) {
  if (!/^\d+$/.test(value ?? ""))
    throw new UsageError(`--weeks expects a positive integer, got '${value ?? ""}'`);
  const n = Number(value);
  if (n < 1 || n > maxWeeks) throw new UsageError(`--weeks expects 1..${maxWeeks}, got ${n}`);
  return n;
}

export function parseSince(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? ""))
    throw new UsageError(`--since expects YYYY-MM-DD, got '${value ?? ""}'`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new UsageError(`--since is not a real date: ${value}`);
  return date;
}

/**
 * Parse argv. `defaults` carries the script-specific option values that
 * differ between callers (today: `file`); the shared options use their
 * documented defaults. `--since` also records `sinceRaw`, the same instant
 * as a UTC calendar date, because both reports print the window boundary.
 */
export function parseArgs(argv, defaults = {}) {
  const opts = {
    file: defaults.file,
    since: null,
    weeks: DEFAULT_WEEKS,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const takeValue = () => {
      if (inline !== null) return inline;
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${name} expects a value`);
      return value;
    };
    switch (name) {
      case "--file":
        opts.file = takeValue();
        break;
      case "--since":
        opts.since = parseSince(takeValue());
        opts.sinceRaw = opts.since.toISOString().slice(0, 10);
        break;
      case "--weeks":
        opts.weeks = parseWeeks(takeValue());
        break;
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }
  return opts;
}

/** Round to two decimals. */
export function round2(value) {
  return Math.round(value * 100) / 100;
}

/** Percent to one decimal, unsigned. Values are always finite at call sites. */
export function fmtPct(value) {
  return `${value.toFixed(1)}%`;
}

/**
 * Week-over-week change to one decimal: "+" on gains, "n/a" when the
 * baseline had no writes to compare against.
 */
export function fmtDeltaPct(value) {
  if (value === null || value === undefined) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}
