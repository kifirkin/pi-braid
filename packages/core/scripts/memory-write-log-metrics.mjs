#!/usr/bin/env node
/**
 * Memory write-log metrics: the read side of the durable-write gate's
 * measurement hook.
 *
 * write-log.jsonl (lib/memory/write-log.ts) carries one JSON line per
 * gated write decision: {ts, site, id?, decision, reason, taskHash,
 * solutionHash, mode}. This report turns that append-only log into the §B.6
 * gate-health readings:
 *
 *   1. per-site writes per ISO week (accept/repair under enforce; under warn
 *      every recorded decision is a write, because warn applies nothing), with
 *      the week-over-week drop check the design uses to trigger per-site
 *      rollback ("finalize writes drop >50% w/w -> flip that site to
 *      mode:'warn'");
 *   2. decision mix (accept/repair/reject/skip-dup counts and rates) and mode
 *      split (enforce vs warn), so a warn-mode rollout window is readable;
 *   3. silence detector: writes per day over the trailing seven days
 *      (relative to now, not to the newest line), ALARM when the average is
 *      below one write per day, the §B.6 "gate rejects everything" signal.
 *      An absent or empty log is a "no data" state, never an alarm: the log
 *      fills only once a session runs with the log-wired build.
 *   4. rejection sample: the latest reject/repair lines, reasons only. The
 *      log is content-free by construction (hashes, static reasons), so the
 *      sample is safe to read, paste and diff.
 *
 * Report-only by design: this script is `memory:metrics`, an ops read, and is
 * deliberately NOT part of `ci:check`. Every read state (absent file, empty
 * file, malformed lines, no lines in the window) prints a report and exits 0.
 *
 * Usage:
 *   node packages/core/scripts/memory-write-log-metrics.mjs [options]
 *
 * Options:
 *   --file <path>     log to read (default ~/.pi/agent/braid/memory/write-log.jsonl)
 *   --since <date>    only count lines with ts >= date, UTC (YYYY-MM-DD)
 *   --weeks <n>       weeks in the weekly table (default 4, max 52)
 *   --json            machine-readable report (stable key order)
 *   --help            this text
 *
 * Exit codes: 0 = report produced (any read state); 2 = invalid usage.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError, parseArgs, round2, fmtDeltaPct } from "./lib/report-args.mjs";

// Mirrors WRITE_LOG_FILE in src/lib/config/braid-paths.ts. Kept literal here
// because this script runs as plain node, outside the built TypeScript tree.
const DEFAULT_LOG_FILE = join(homedir(), ".pi", "agent", "braid", "memory", "write-log.jsonl");

/** Gate sites in WRITE_GATE_SITES order; unknown future sites sort after. */
const KNOWN_SITES = [
  "heartbeat",
  "finalize",
  "memoryStoreTwin",
  "episodesAdd",
  "reasoningChains",
  "mars",
];

/** Gate decisions (write-quality.ts WriteDecision actions). */
const DECISIONS = ["accept", "repair", "reject", "skip-dup"];

/** §B.6 row 1: a complete-week drop this far below the week before flags the site. */
const WOW_DROP_FLAG = 0.5;

/** §B.6 row 3: writes below this daily average over the trailing week alarm. */
const SILENCE_ALARM_PER_DAY = 1;

/** Trailing window for the silence detector, days. */
const SILENCE_WINDOW_DAYS = 7;

/** Default and maximum size of the rejection sample. */
const DEFAULT_SAMPLE = 10;

const DAY_MS = 86_400_000;

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage: node packages/core/scripts/memory-write-log-metrics.mjs [options]

Options:
  --file <path>     log to read (default ${DEFAULT_LOG_FILE})
  --since <date>    only count lines with ts >= date, UTC (YYYY-MM-DD)
  --weeks <n>       weeks in the weekly table (default 4, max 52)
  --json            machine-readable report
  --help            show this text`;

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Read and parse the log. Tolerant by contract: unparseable or
 * schema-incomplete lines are skipped and counted, never thrown.
 *
 * A line is usable when it is a JSON object with a parseable ts, a non-empty
 * site and a known decision. Everything else (missing reason/mode/hashes,
 * extra fields) degrades gracefully in the report instead of dropping the
 * line: those fields are presentation, not counting, inputs.
 */
function readLog(file) {
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
    const ts = typeof parsed.ts === "string" ? new Date(parsed.ts) : null;
    const site =
      typeof parsed.site === "string" && parsed.site.trim().length > 0 ? parsed.site : null;
    const decision = DECISIONS.includes(parsed.decision) ? parsed.decision : null;
    if (!ts || Number.isNaN(ts.getTime()) || !site || !decision) {
      malformed++;
      continue;
    }
    usable.push({
      ts,
      site,
      decision,
      reason: typeof parsed.reason === "string" ? parsed.reason : "(no reason recorded)",
      mode: parsed.mode === "enforce" || parsed.mode === "warn" ? parsed.mode : "unknown",
    });
  }
  return { state: lines.length === 0 ? "empty" : "ok", usable, malformed, total: lines.length };
}

// ── Time bucketing (UTC; the log's ts is ISO-8601) ──────────────────────────

/** ISO week of a date: key 'YYYY-Www' and the Monday that starts it. */
function isoWeek(date) {
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = thursday.getUTCDay() || 7; // Mon=1 .. Sun=7
  thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday - yearStart) / DAY_MS + 1) / 7);
  return { key: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, week };
}

/** Monday 00:00 UTC that starts the ISO week containing `date`. */
function isoWeekStart(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dayNum - 1));
  return d;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// ── Report ──────────────────────────────────────────────────────────────────

/**
 * "Writes" are decisions that reach the store. In enforce mode that is
 * accept + repair; in warn mode the gate returns write:true for every
 * decision, so every recorded warn line is a write. The decision mix stays
 * the raw counts, so suppressions remain visible next to the write counts.
 */
function isWrite(line) {
  return line.decision === "accept" || line.decision === "repair" || line.mode === "warn";
}

function emptySiteCounts() {
  return Object.fromEntries(KNOWN_SITES.map((site) => [site, 0]));
}

function buildReport(read, opts, now) {
  const lines = opts.since ? read.usable.filter((line) => line.ts >= opts.since) : read.usable;
  const sinceLabel = opts.since ? opts.sinceRaw : null;

  // Decision mix and mode split over the whole window.
  const decisions = Object.fromEntries(DECISIONS.map((d) => [d, 0]));
  const modes = { enforce: 0, warn: 0, unknown: 0 };
  for (const line of lines) {
    decisions[line.decision]++;
    modes[line.mode]++;
  }

  // Weekly buckets, keyed by ISO week; only writes counted per site.
  const byWeek = new Map();
  for (const line of lines) {
    const week = isoWeek(line.ts).key;
    let bucket = byWeek.get(week);
    if (!bucket) {
      const start = isoWeekStart(line.ts);
      bucket = {
        week,
        start: dateKey(start),
        startDate: start,
        bySite: emptySiteCounts(),
        writes: 0,
        decisions: Object.fromEntries(DECISIONS.map((d) => [d, 0])),
        modes: { enforce: 0, warn: 0, unknown: 0 },
      };
      byWeek.set(week, bucket);
    }
    bucket.decisions[line.decision]++;
    bucket.modes[line.mode]++;
    if (isWrite(line)) {
      bucket.bySite[line.site] = (bucket.bySite[line.site] ?? 0) + 1;
      bucket.writes++;
    }
  }

  const allWeeks = [...byWeek.values()].sort((a, b) => a.startDate - b.startDate);
  const currentWeekKey = isoWeek(now).key;
  for (const bucket of allWeeks) bucket.partial = bucket.week === currentWeekKey;

  // Window: the last `weeks` ISO weeks up to the newest week with data,
  // clamped at the oldest week with data (no pre-log zero rows), with
  // interior weeks present as zero rows so a gap cannot hide.
  let weekly = [];
  if (allWeeks.length > 0) {
    const latest = allWeeks[allWeeks.length - 1].startDate;
    const first = allWeeks[0].startDate;
    let rangeStart = new Date(latest.getTime() - (opts.weeks - 1) * 7 * DAY_MS);
    if (rangeStart < first) rangeStart = first;
    for (let t = rangeStart.getTime(); t <= latest.getTime(); t += 7 * DAY_MS) {
      const start = new Date(t);
      const bucket = allWeeks.find((w) => w.startDate.getTime() === start.getTime());
      if (bucket) {
        weekly.push(bucket);
      } else {
        const week = isoWeek(start);
        weekly.push({
          week: week.key,
          start: dateKey(start),
          startDate: start,
          bySite: emptySiteCounts(),
          writes: 0,
          decisions: Object.fromEntries(DECISIONS.map((d) => [d, 0])),
          modes: { enforce: 0, warn: 0, unknown: 0 },
          partial: week.key === currentWeekKey,
        });
      }
    }
  }

  // Sites to show: every site that wrote anywhere in the window.
  const activeSites = KNOWN_SITES.filter((site) => weekly.some((w) => (w.bySite[site] ?? 0) > 0));
  const unknownSites = [
    ...new Set(
      weekly.flatMap((w) =>
        Object.keys(w.bySite).filter((s) => (w.bySite[s] ?? 0) > 0 && !KNOWN_SITES.includes(s)),
      ),
    ),
  ].sort();
  const sites = [...activeSites, ...unknownSites];

  // Week over week: compare consecutive COMPLETE weeks only (the current
  // week is partial; comparing it to a full week manufactures drops). The
  // delta column reports the newest complete transition; a flag is the §B.6
  // row 1 condition (a complete week below half of the week before).
  const completeWeeks = weekly.filter((w) => !w.partial);
  const wow = sites.map((site) => {
    const counts = Object.fromEntries(weekly.map((w) => [w.week, w.bySite[site] ?? 0]));
    let latestChange = null;
    if (completeWeeks.length >= 2) {
      const prev = completeWeeks[completeWeeks.length - 2].bySite[site] ?? 0;
      const cur = completeWeeks[completeWeeks.length - 1].bySite[site] ?? 0;
      latestChange = {
        prev,
        cur,
        change: cur - prev,
        changePct: prev > 0 ? round2(((cur - prev) / prev) * 100) : null,
      };
    }
    const flags = [];
    for (let i = 1; i < completeWeeks.length; i++) {
      const prev = completeWeeks[i - 1].bySite[site] ?? 0;
      const cur = completeWeeks[i].bySite[site] ?? 0;
      if (prev > 0 && cur < WOW_DROP_FLAG * prev) {
        flags.push({
          from: completeWeeks[i - 1].week,
          to: completeWeeks[i].week,
          fromCount: prev,
          toCount: cur,
          changePct: round2(((cur - prev) / prev) * 100),
        });
      }
    }
    return { site, counts, latestChange, flags };
  });

  // Silence: writes per day over the trailing seven UTC days, relative to
  // now (not to the newest line; a stale log is exactly what this detects).
  const perDay = [];
  for (let i = SILENCE_WINDOW_DAYS - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * DAY_MS);
    perDay.push({ date: dateKey(day), writes: 0 });
  }
  const byDay = new Map(perDay.map((d) => [d.date, d]));
  for (const line of lines) {
    if (!isWrite(line)) continue;
    const bucket = byDay.get(dateKey(line.ts));
    if (bucket) bucket.writes++;
  }
  const windowWrites = perDay.reduce((sum, d) => sum + d.writes, 0);
  const trailingAverage = windowWrites / SILENCE_WINDOW_DAYS;

  // Rejection sample: newest reject/repair lines first, reasons only.
  const sample = lines
    .filter((line) => line.decision === "reject" || line.decision === "repair")
    .slice(-DEFAULT_SAMPLE)
    .reverse()
    .map((line) => ({
      ts: line.ts.toISOString(),
      site: line.site,
      decision: line.decision,
      reason: line.reason,
      mode: line.mode,
    }));

  const total = lines.length;
  const noData =
    read.state === "absent" || read.state === "empty" || read.state === "unreadable" || total === 0;
  return {
    file: opts.file,
    state: read.state === "ok" && total === 0 ? "no-lines-in-window" : read.state,
    error: read.error ?? null,
    generatedAt: now.toISOString(),
    weeks: opts.weeks,
    since: sinceLabel,
    lines: {
      total: read.total,
      usable: read.usable.length,
      inWindow: total,
      malformed: read.malformed,
    },
    window:
      weekly.length > 0
        ? { firstWeekStart: weekly[0].start, lastWeekStart: weekly[weekly.length - 1].start }
        : null,
    activeSites: sites,
    decisions: { counts: decisions, total, rates: rateMap(decisions, total) },
    modes: { counts: modes, total },
    weekly: weekly.map((w) => ({
      week: w.week,
      start: w.start,
      partial: w.partial,
      writes: w.writes,
      bySite: w.bySite,
    })),
    wow,
    silence: {
      status: noData ? "no-data" : trailingAverage < SILENCE_ALARM_PER_DAY ? "alarm" : "ok",
      perDay,
      windowWrites,
      trailingAverage: round2(trailingAverage),
      thresholdPerDay: SILENCE_ALARM_PER_DAY,
    },
    sample,
    sampleLimit: DEFAULT_SAMPLE,
  };
}

function rateMap(counts, total) {
  return Object.fromEntries(
    Object.entries(counts).map(([key, count]) => [
      key,
      total === 0 ? 0 : round2((count / total) * 100),
    ]),
  );
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderText(report) {
  const out = [];
  out.push("Memory write-log metrics");
  out.push(`  file:  ${report.file}`);

  if (report.state === "absent") {
    out.push("  state: no data (file not present)");
    out.push("");
    out.push("  The log fills once a running session uses the log-wired build;");
    out.push("  an absent file before first use is expected, not an alarm.");
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
    out.push("  No gated decision has been recorded yet; not an alarm.");
    return out.join("\n");
  }
  if (report.state === "no-lines-in-window") {
    out.push(`  state: no usable lines in window${report.since ? ` (since ${report.since})` : ""}`);
    out.push(
      `  lines: ${report.lines.total} total, ${report.lines.usable} usable, ${report.lines.malformed} malformed (skipped)`,
    );
    out.push("");
    out.push("  Nothing to measure in the selected window; widen --since or drop it.");
    return out.join("\n");
  }

  out.push(
    `  lines: ${report.lines.inWindow} in window` +
      (report.since ? ` (since ${report.since})` : "") +
      `; ${report.lines.malformed} malformed skipped`,
  );
  out.push("");

  // Weekly writes table.
  out.push("Writes per ISO week (per site; accept+repair under enforce, all decisions under warn)");
  const siteWidth = Math.max(4, ...report.activeSites.map((s) => s.length)) + 2;
  const header = [
    "site".padEnd(siteWidth),
    ...report.weekly.map((w) => `${w.week}${w.partial ? "*" : ""}`.padStart(11)),
  ];
  out.push("  " + header.join(" "));
  for (const site of report.activeSites) {
    const cells = report.weekly.map((w) => String(w.bySite[site] ?? 0).padStart(11));
    out.push("  " + site.padEnd(siteWidth) + " " + cells.join(" "));
  }
  const totals = report.weekly.map((w) => String(w.writes).padStart(11));
  out.push("  " + "TOTAL".padEnd(siteWidth) + " " + totals.join(" "));
  if (report.weekly.some((w) => w.partial))
    out.push("  * current week (partial; week-over-week math uses complete weeks only)");
  out.push("");

  // Week-over-week checks.
  const checks = (report.wow ?? []).filter((row) => row.latestChange);
  if (checks.length > 0) {
    out.push("Week-over-week (newest complete pair)");
    for (const row of checks) {
      const c = row.latestChange;
      out.push(
        `  ${row.site.padEnd(siteWidth)}${String(c.prev).padStart(6)} -> ${String(c.cur).padStart(6)}  ${fmtDeltaPct(c.changePct)}`,
      );
    }
    const flagged = (report.wow ?? []).flatMap((row) =>
      row.flags.map((f) => ({ site: row.site, ...f })),
    );
    for (const f of flagged) {
      out.push(
        `  ALARM ${f.site}: writes dropped from ${f.fromCount} (${f.from}) to ${f.toCount} (${f.to}) = ${fmtDeltaPct(f.changePct)}; over the >50% w/w threshold (flip to mode:"warn" and audit the sample)`,
      );
    }
    out.push("");
  }

  // Decision mix.
  out.push("Decision mix (all usable lines in window)");
  for (const [decision, count] of Object.entries(report.decisions.counts)) {
    out.push(
      `  ${decision.padEnd(10)}${String(count).padStart(6)}  ${report.decisions.rates[decision].toFixed(1)}%`,
    );
  }
  out.push(`  ${"total".padEnd(10)}${String(report.decisions.total).padStart(6)}`);
  out.push("");

  // Mode split.
  out.push("Mode split");
  out.push(`  enforce   ${String(report.modes.counts.enforce).padStart(6)}`);
  out.push(`  warn      ${String(report.modes.counts.warn).padStart(6)}`);
  if (report.modes.counts.unknown > 0)
    out.push(`  unknown   ${String(report.modes.counts.unknown).padStart(6)}`);
  out.push("");

  // Silence.
  out.push(`Writes per day (trailing ${SILENCE_WINDOW_DAYS} UTC days)`);
  for (const day of report.silence.perDay) {
    const marker =
      day.date === report.silence.perDay[report.silence.perDay.length - 1].date ? "  (today)" : "";
    out.push(`  ${day.date}  ${String(day.writes).padStart(4)}${marker}`);
  }
  out.push(
    `  average: ${report.silence.trailingAverage.toFixed(2)}/day (alarm threshold: <${SILENCE_ALARM_PER_DAY}/day)`,
  );
  if (report.silence.status === "alarm") {
    out.push(
      `  ALARM: fewer than ${SILENCE_ALARM_PER_DAY} write/day over the trailing ${SILENCE_WINDOW_DAYS} days; §B.6 row 3 treats this as an instrumentation/gate bug, investigate before tuning`,
    );
  } else {
    out.push("  status: ok");
  }
  out.push("");

  // Rejection sample.
  out.push(`Rejection sample (latest ${DEFAULT_SAMPLE} reject/repair lines, reasons only)`);
  if (report.sample.length === 0) {
    out.push("  none");
  } else {
    for (const line of report.sample) {
      out.push(
        `  ${line.ts}  ${line.site.padEnd(16)} ${line.decision.padEnd(6)} ${line.mode.padEnd(8)} ${line.reason}`,
      );
    }
  }
  return out.join("\n");
}

// ── Entry ───────────────────────────────────────────────────────────────────

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv, { file: DEFAULT_LOG_FILE });
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

  const read = readLog(opts.file);
  const report = buildReport(read, opts, new Date());

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderText(report));
  }
}

main(process.argv.slice(2));
