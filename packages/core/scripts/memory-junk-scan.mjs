#!/usr/bin/env node
/**
 * Memory junk scan: read-side classifier for the durable-write gate's
 * §B.6 row 2 ("under-gating leaves junk").
 *
 * Classifies every entry of episodes.jsonl (three-memory-stores retrospective
 * store) into exactly the design's Appendix A.1 partition:
 *
 *   sentinel          task == "session_outcome" (the 89% study definition)
 *   template-solution solution matches
 *                     ^(Outcome: (success|partial|failure)|Complete task:|Use .* approach)
 *   dual-field        everything else (task and solution both carry content)
 *
 * The classes sum to the total by construction. "Dead solution" is the
 * template-solution class; "junk" is sentinel + template-solution. The window
 * (--since, or the trailing --weeks) is the set of entries the design treats
 * as new writes; the pre-window remainder is the baseline.
 *
 * §B.6 row 2 alarm: the dead-solution share of window entries above 10%.
 * An empty window is a "no new entries" no-data state, never an alarm.
 *
 * Exact (task, solution) duplicate groups are counted stock-wide and
 * per-window: group count, surplus (entries minus one per group), per-group
 * sizes and the largest groups by content hash: the purge input, dry-run
 * only. This script NEVER writes or deletes anything; it reads one file.
 *
 * Report-only by design: this script is `memory:junk-scan`, an ops read, and
 * is deliberately NOT part of `ci:check`. Every read state (absent file,
 * empty file, malformed lines, no entries in the window) prints a report and
 * exits 0.
 *
 * Usage:
 *   node packages/core/scripts/memory-junk-scan.mjs [options]
 *
 * Options:
 *   --file <path>     episodes store to read (default ~/.pi/agent/braid/memory/episodes.jsonl)
 *   --since <date>    window start, inclusive, UTC (YYYY-MM-DD); takes precedence over --weeks
 *   --weeks <n>       trailing window in weeks when --since is absent (default 4, max 52)
 *   --json            machine-readable report (stable key order)
 *   --help            this text
 *
 * Exit codes: 0 = report produced (any read state); 2 = invalid usage.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  UsageError,
  parseArgs,
  round2,
  fmtPct,
  DEFAULT_WEEKS,
  MAX_WEEKS,
} from "./lib/report-args.mjs";

// Mirrors EPISODES_FILE in src/lib/config/braid-paths.ts. Kept literal here
// because this script runs as plain node, outside the built TypeScript tree.
const DEFAULT_STORE_FILE = join(homedir(), ".pi", "agent", "braid", "memory", "episodes.jsonl");

/** The 89% study's sentinel definition: task is the literal session_outcome. */
const SENTINEL_TASK = "session_outcome";

/** The design's dead-solution template (Appendix A.1 / B.1), first-match on the stripped solution. */
const TEMPLATE_SOLUTION_RE = /^(Outcome: (success|partial|failure)|Complete task:|Use .* approach)/;

/** Class order used everywhere: sentinel, template-solution, dual-field. */
const CLASSES = ["sentinel", "template", "dual"];

/** Human labels for the text report. */
const CLASS_LABELS = {
  sentinel: "sentinel",
  template: "template-solution",
  dual: "dual-field",
};

/** §B.6 row 2: dead-solution share of new writes above this percent alarms. */
const DEAD_SOLUTION_ALARM_PCT = 10;

/** Largest duplicate groups named in the report (hashes only, no content). */
const LARGEST_GROUPS = 10;

const DAY_MS = 86_400_000;

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage: node packages/core/scripts/memory-junk-scan.mjs [options]

Options:
  --file <path>     episodes store to read (default ${DEFAULT_STORE_FILE})
  --since <date>    window start, inclusive, UTC (YYYY-MM-DD); takes precedence over --weeks
  --weeks <n>       trailing window in weeks when --since is absent (default ${DEFAULT_WEEKS}, max ${MAX_WEEKS})
  --json            machine-readable report
  --help            show this text`;

// ── Reading and classifying ─────────────────────────────────────────────────

/** Sentinel first, template-solution second, dual-field for the rest. */
function classify(task, solution) {
  if (task === SENTINEL_TASK) return "sentinel";
  if (TEMPLATE_SOLUTION_RE.test(solution.trim())) return "template";
  return "dual";
}

/**
 * Read and classify the store. Tolerant by contract: non-JSON lines,
 * non-objects, and objects without a finite numeric timestamp are skipped and
 * counted. task/solution default to "" when absent, matching the design's
 * `e.get('task') or ''` handling (so they classify rather than drop).
 */
function readStore(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const code = err && typeof err === "object" ? err.code : undefined;
    if (code === "ENOENT") return { state: "absent", usable: [], malformed: 0, total: 0 };
    return {
      state: "unreadable",
      error: err instanceof Error ? err.message : String(err),
      usable: [],
      malformed: 0,
      total: 0,
    };
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const usable = [];
  let malformed = 0;
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformed++;
      continue;
    }
    if (typeof parsed.timestamp !== "number" || !Number.isFinite(parsed.timestamp)) {
      malformed++;
      continue;
    }
    const task = typeof parsed.task === "string" ? parsed.task : "";
    const solution = typeof parsed.solution === "string" ? parsed.solution : "";
    usable.push({
      ts: parsed.timestamp,
      task,
      solution,
      class: classify(task, solution),
    });
  }
  return { state: lines.length === 0 ? "empty" : "ok", usable, malformed, total: lines.length };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

/** Class counts and rates (percent, 2 decimals) over a set of entries. */
function classCounts(entries) {
  const classes = { sentinel: 0, template: 0, dual: 0 };
  for (const entry of entries) classes[entry.class]++;
  const total = entries.length;
  const rates = {};
  for (const cls of CLASSES) rates[cls] = total === 0 ? 0 : round2((classes[cls] / total) * 100);
  rates.junk = total === 0 ? 0 : round2(((classes.sentinel + classes.template) / total) * 100);
  return { total, classes, rates };
}

/** §B.6 row 2: template-solution share strictly above the threshold percent. */
function deadSolutionAlarm(counts) {
  const { total, classes } = counts;
  if (total === 0) {
    return { status: "no-data", deadSolutionRate: 0, thresholdPct: DEAD_SOLUTION_ALARM_PCT };
  }
  const dead = classes.template;
  const alarm = dead * 100 > total * DEAD_SOLUTION_ALARM_PCT;
  return {
    status: alarm ? "alarm" : "ok",
    deadSolutionRate: round2((dead / total) * 100),
    thresholdPct: DEAD_SOLUTION_ALARM_PCT,
  };
}

/** Stable content id for a (task, solution) group: sha1 of the pair, never the pair. */
function groupId(task, solution) {
  return createHash("sha1").update(`${task}\u0000${solution}`).digest("hex").slice(0, 12);
}

/**
 * Exact (task, solution) duplicate groups. Surplus = entries minus one per
 * group = the removable count a purge would take; groups are named by
 * content hash so the report can carry purge input without carrying content.
 */
function duplicateGroups(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.task}\u0000${entry.solution}`;
    let group = seen.get(key);
    if (!group) {
      group = { id: groupId(entry.task, entry.solution), size: 0 };
      seen.set(key, group);
    }
    group.size++;
  }
  let groups = 0;
  let groupedEntries = 0;
  let surplus = 0;
  const bySize = {};
  const largest = [];
  for (const group of seen.values()) {
    if (group.size < 2) continue;
    groups++;
    groupedEntries += group.size;
    surplus += group.size - 1;
    bySize[group.size] = (bySize[group.size] ?? 0) + 1;
    largest.push({ id: group.id, size: group.size });
  }
  largest.sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
  return {
    groups,
    groupedEntries,
    surplus,
    bySize,
    largest: largest.slice(0, LARGEST_GROUPS),
    largestTotal: largest.length,
  };
}

function dayKey(tsMs) {
  return new Date(tsMs).toISOString().slice(0, 10);
}

/**
 * Per-day counts (UTC) for the window's day span, zero-filled so gaps and
 * silence are visible. The span starts at the window start (clamped to the
 * first entry) and ends at the last entry in the window, and carries the
 * window's peak sentinel day.
 */
function buildTimeline(entries, windowStartMs) {
  if (entries.length === 0) {
    return { days: [], maxSentinelPerDay: null };
  }
  const byDay = new Map();
  for (const entry of entries) {
    const day = dayKey(entry.ts);
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = { date: day, total: 0, sentinel: 0, template: 0, dual: 0 };
      byDay.set(day, bucket);
    }
    bucket.total++;
    bucket[entry.class]++;
  }

  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const dayMs = (day) => new Date(`${day}T00:00:00.000Z`).getTime();
  // Both ends are midnight-aligned before the fill loop: a --weeks start is a
  // mid-day instant, and stepping DAY_MS from it would land past the last
  // day's midnight and silently drop trailing rows.
  const spanStart = Math.max(dayMs(dayKey(windowStartMs)), dayMs(days[0].date));
  const spanEnd = dayMs(days[days.length - 1].date);
  const full = [];
  const indexed = new Map(days.map((d) => [d.date, d]));
  for (let t = spanStart; t <= spanEnd; t += DAY_MS) {
    const day = dayKey(t);
    full.push(indexed.get(day) ?? { date: day, total: 0, sentinel: 0, template: 0, dual: 0 });
  }

  let peak = null;
  for (const day of full) {
    if (day.sentinel > 0 && (!peak || day.sentinel > peak.count)) {
      peak = { date: day.date, count: day.sentinel };
    }
  }

  return { days: full, maxSentinelPerDay: peak };
}

/**
 * Newest sentinel across the store (not just the window): the regression
 * check for §B.6 row 2's "any new sentinel write after coverage lands".
 */
function lastSentinelOf(entries, now) {
  let newest = null;
  for (const entry of entries) {
    if (entry.class !== "sentinel") continue;
    if (newest === null || entry.ts > newest) newest = entry.ts;
  }
  if (newest === null) return null;
  return {
    ts: new Date(newest).toISOString(),
    ageDays: round2((now.getTime() - newest) / DAY_MS),
  };
}

// ── Report ──────────────────────────────────────────────────────────────────

function buildReport(read, opts, now) {
  const windowStart = opts.since ?? new Date(now.getTime() - opts.weeks * 7 * DAY_MS);
  const windowEntries = read.usable.filter((entry) => entry.ts >= windowStart.getTime());
  const baselineEntries = read.usable.filter((entry) => entry.ts < windowStart.getTime());

  const windowCounts = classCounts(windowEntries);
  const window =
    read.state === "ok"
      ? {
          start: dayKey(windowStart.getTime()),
          startTs: windowStart.getTime(),
          source: opts.since ? "since" : "weeks",
          ...windowCounts,
          alarm: deadSolutionAlarm(windowCounts),
        }
      : null;

  const baseline = baselineEntries.length > 0 ? classCounts(baselineEntries) : null;

  const duplicates = {
    stock: duplicateGroups(read.usable),
    window: windowEntries.length > 0 ? duplicateGroups(windowEntries) : null,
  };

  const timeline = {
    ...buildTimeline(windowEntries, windowStart.getTime()),
    lastSentinel: lastSentinelOf(read.usable, now),
  };

  let state = read.state;
  if (state === "ok" && read.usable.length === 0) state = "no-usable-entries";
  if (state === "ok" && windowEntries.length === 0) state = "no-new-entries";

  return {
    file: opts.file,
    state,
    error: read.error ?? null,
    generatedAt: now.toISOString(),
    options: { since: opts.sinceRaw ?? null, weeks: opts.weeks },
    lines: {
      total: read.total,
      usable: read.usable.length,
      malformed: read.malformed,
    },
    window,
    baseline,
    duplicates,
    timeline,
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function classLines(counts, indent = "  ") {
  const lines = [];
  const pad = Math.max(...CLASSES.map((cls) => CLASS_LABELS[cls].length)) + 2;
  for (const cls of CLASSES) {
    lines.push(
      `${indent}${CLASS_LABELS[cls].padEnd(pad)}${String(counts.classes[cls]).padStart(6)}  ${fmtPct(counts.rates[cls]).padStart(7)}`,
    );
  }
  lines.push(
    `${indent}${"total".padEnd(pad)}${String(counts.total).padStart(6)}  ${fmtPct(100).padStart(7)}`,
  );
  lines.push(
    `${indent}junk (sentinel + template-solution): ${counts.classes.sentinel + counts.classes.template}/${counts.total} = ${fmtPct(counts.rates.junk)}`,
  );
  return lines;
}

function renderText(report) {
  const out = [];
  out.push("Memory junk scan (episodes.jsonl)");
  out.push(`  file:  ${report.file}`);

  if (report.state === "absent") {
    out.push("  state: no data (file not present)");
    out.push("");
    out.push(
      "  The scan reads the episodes store read-only; an absent file before first use is expected, not an alarm.",
    );
    return out.join("\n");
  }
  if (report.state === "unreadable") {
    out.push("  state: unreadable (read it as a file?)");
    out.push(`  error: ${report.error ?? "unknown read error"}`);
    return out.join("\n");
  }
  if (report.state === "empty") {
    out.push("  state: no data (file present, no lines)");
    out.push("");
    out.push("  Nothing to classify yet; not an alarm.");
    return out.join("\n");
  }
  if (report.state === "no-usable-entries") {
    out.push(`  state: no usable entries (${report.lines.total} lines, all malformed/skipped)`);
    out.push("");
    out.push("  Every line was skipped by the reader; check the store format before measuring.");
    return out.join("\n");
  }

  out.push(
    `  entries: ${report.lines.usable} usable, ${report.lines.malformed} malformed skipped (${report.lines.total} lines)`,
  );
  const window = report.window;
  const windowLabel =
    window.source === "since"
      ? `since ${window.start}`
      : `trailing ${report.options.weeks} week${report.options.weeks === 1 ? "" : "s"} (from ${window.start})`;
  out.push(`  window: ${windowLabel} (${window.total} entries)`);
  out.push("");

  // Classification over the window.
  out.push("Classification (window)");
  out.push(...classLines(window));
  out.push("");

  // §B.6 row 2 alarm.
  if (window.alarm.status === "no-data") {
    out.push(
      "Dead-solution share of new writes: no new entries in the window (no-data, not an alarm)",
    );
  } else {
    out.push(
      `Dead-solution share of new writes: ${fmtPct(window.alarm.deadSolutionRate)} (threshold: >${window.alarm.thresholdPct}%)`,
    );
    if (window.alarm.status === "alarm") {
      out.push(
        `  ALARM: dead-solution share of new writes ${fmtPct(window.alarm.deadSolutionRate)} > ${window.alarm.thresholdPct}%; §B.6 row 2 says the repair is not landing; audit the finalize write path before tuning`,
      );
    } else {
      out.push("  status: ok");
    }
  }
  out.push("");

  // Baseline (pre-window) when data allows.
  if (report.baseline) {
    out.push(`Baseline (pre-window: ${report.baseline.total} entries)`);
    out.push(...classLines(report.baseline));
    out.push("");
  } else {
    out.push("Baseline: no entries before the window (nothing to compare)");
    out.push("");
  }

  // Duplicates: stock is the purge input; window is the §B.6 new-write surplus.
  const stock = report.duplicates.stock;
  out.push("Duplicate groups (stock; dry-run purge input; nothing is ever deleted here)");
  if (stock.groups === 0) {
    out.push("  none");
  } else {
    const pct = report.lines.usable > 0 ? (stock.surplus / report.lines.usable) * 100 : 0;
    out.push(
      `  groups: ${stock.groups}; entries in groups: ${stock.groupedEntries}; surplus (removable): ${stock.surplus} (${fmtPct(pct)} of usable entries)`,
    );
    const sizes = stock.largest.map((group) => group.size).join(", ");
    out.push(
      `  largest group sizes: ${sizes}${stock.largestTotal > stock.largest.length ? ` (+${stock.largestTotal - stock.largest.length} more)` : ""}`,
    );
    const bySize = Object.entries(stock.bySize)
      .map(([size, n]) => `${size}x${n}`)
      .join(", ");
    out.push(`  by size: ${bySize}`);
    out.push(
      `  largest groups by content hash: ${stock.largest.map((group) => `${group.id} (${group.size})`).join(", ")}`,
    );
  }
  if (report.duplicates.window) {
    const win = report.duplicates.window;
    out.push(
      `  window duplicates: ${win.groups} group${win.groups === 1 ? "" : "s"}, surplus ${win.surplus}`,
    );
  }
  out.push("");

  // Sentinel timeline.
  out.push(
    `Sentinel timeline (per day, UTC; zero-filled over the window span${report.timeline.days.length === 0 ? "; no entries" : ""})`,
  );
  for (const day of report.timeline.days) {
    out.push(
      `  ${day.date}  ${String(day.total).padStart(4)} total, ${String(day.sentinel).padStart(3)} sentinel`,
    );
  }
  const last = report.timeline.lastSentinel;
  if (last) {
    out.push(`  last sentinel write: ${last.ts} (${last.ageDays} days before now)`);
  } else {
    out.push("  last sentinel write: none in the store");
  }
  const peak = report.timeline.maxSentinelPerDay;
  if (peak) out.push(`  peak sentinel day (window): ${peak.date} (${peak.count})`);
  return out.join("\n");
}

// ── Entry ───────────────────────────────────────────────────────────────────

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv, { file: DEFAULT_STORE_FILE });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\n`);
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const read = readStore(opts.file);
  const report = buildReport(read, opts, new Date());

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderText(report));
  }
}

main(process.argv.slice(2));
