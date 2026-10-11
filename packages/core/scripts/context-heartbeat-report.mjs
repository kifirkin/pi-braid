#!/usr/bin/env node
/**
 * context-heartbeat-report.mjs — read the context-heartbeat telemetry sink.
 *
 * The producer (src/lib/telemetry/context-heartbeat.ts) appends one scalar
 * JSONL line per heartbeat tick and had no reader. This script is that
 * reader: it summarizes what the producer actually records, per session.
 *
 *   node packages/core/scripts/context-heartbeat-report.mjs
 *   node packages/core/scripts/context-heartbeat-report.mjs --file <path>
 *   node packages/core/scripts/context-heartbeat-report.mjs --session <id>
 *   node packages/core/scripts/context-heartbeat-report.mjs --json
 *
 * What it surfaces, per session:
 *   - tick count, first/last heartbeat, wall-clock age of the last one, and
 *     the inter-tick cadence (median/min/max) — the liveness view.
 *   - context budget trend: first/last/peak tokens, the effective window, and
 *     the last tick's percent.
 *   - context drops: ticks whose contextTokensDelta is negative (compaction or
 *     an archive slide), with the largest drop — the compaction view.
 *   - RSS first/last/peak and session-file growth.
 *   - throughput (tokensPerSec, tpsEma), cache-hit share, whisper pressure,
 *     entry count, and the source/health-mode mix.
 *
 * A field the producer did not report stays "n/a" — never a fabricated zero.
 * Malformed lines are counted and skipped, not silently dropped.
 *
 * Exit codes: 0 — a report was produced (a missing sink is reported as such,
 * it is not an error: a fresh install has not ticked yet); 2 — bad usage or
 * an unreadable sink.
 *
 * This is an advisory reader, not a gate: it is named `report:` in
 * package.json and is not a member of the ci:check chain.
 *
 * The default path mirrors the producer's module-local CONTEXT_HEARTBEAT_FILE
 * constant (that constant is a candidate to move to braid-paths; see the
 * producer's header). test-context-heartbeat-report.mjs pins the two together,
 * so the mirror cannot drift silently.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CONTEXT_HEARTBEAT_FILE = join(
  homedir(),
  ".pi",
  "agent",
  "braid",
  "telemetry",
  "context-heartbeat.jsonl",
);

const USAGE = `Usage: node packages/core/scripts/context-heartbeat-report.mjs [options]

  --file <path>       heartbeat JSONL to read (default: the producer's sink)
  --session <id>      only sessions whose id contains <id> (repeatable)
  --limit <n>         sessions to render, newest first (default 5; 0 = all)
  --json              machine-readable summary instead of the text rendering
  -h, --help          this text`;

// ── parse ───────────────────────────────────────────────────────────────────

/** Parse JSONL text into entries. A blank line is ignored; a line that is not
 *  a JSON object is counted as malformed and skipped. */
export function parseHeartbeatLines(text) {
  const entries = [];
  let malformed = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
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
    entries.push(parsed);
  }
  return { entries, malformed };
}

// ── summarize ───────────────────────────────────────────────────────────────

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function tally(entries, field) {
  const counts = new Map();
  for (const entry of entries) {
    const value = entry[field];
    if (value === null || value === undefined || value === "") continue;
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

/** First/last/peak of a numeric field across ticks, or null when never set. */
function range(entries, field) {
  const values = entries.map((e) => num(e[field])).filter((v) => v !== null);
  if (values.length === 0) return null;
  return {
    first: values[0],
    last: values[values.length - 1],
    peak: Math.max(...values),
    trough: Math.min(...values),
    samples: values.length,
  };
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sessionSummary(sessionId, entries) {
  const ts = entries.map((e) => num(e.ts)).filter((v) => v !== null);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (gap >= 0) gaps.push(gap);
  }

  // A negative contextTokensDelta means context shrank between ticks: pi-core
  // compaction, or a braid archive/slide. The producer records the delta, not
  // the cause, so the summary says "drop", not "compaction".
  const drops = [];
  for (const entry of entries) {
    const delta = num(entry.contextTokensDelta);
    if (delta !== null && delta < 0) drops.push({ ts: num(entry.ts), delta });
  }
  const largestDrop = drops.length > 0 ? Math.min(...drops.map((d) => d.delta)) : null;

  const cacheShares = entries.map((e) => num(e.cacheHitShare)).filter((v) => v !== null);

  return {
    sessionId,
    ticks: entries.length,
    firstTs: ts.length > 0 ? ts[0] : null,
    lastTs: ts.length > 0 ? ts[ts.length - 1] : null,
    cadenceMs: {
      median: median(gaps),
      min: gaps.length > 0 ? Math.min(...gaps) : null,
      max: gaps.length > 0 ? Math.max(...gaps) : null,
      samples: gaps.length,
    },
    contextTokens: range(entries, "contextTokens"),
    contextWindow: range(entries, "contextWindow"),
    contextPercentLast: range(entries, "contextPercent")?.last ?? null,
    drops: {
      count: drops.length,
      largestDrop,
      totalDrop: drops.length > 0 ? drops.reduce((a, d) => a + d.delta, 0) : null,
      at: drops.map((d) => d.ts),
    },
    rssBytes: range(entries, "rssBytes"),
    heapUsed: range(entries, "heapUsed")?.last ?? null,
    sessionFileSizeBytes: range(entries, "sessionFileSizeBytes"),
    tokensPerSecLast: range(entries, "tokensPerSec")?.last ?? null,
    tpsEmaLast: range(entries, "tpsEma")?.last ?? null,
    cacheHitShareMean: mean(cacheShares),
    cacheHitShareSamples: cacheShares.length,
    whisperCountTotal: range(entries, "whisperCountTotal")?.last ?? null,
    whisperCharsDeltaSum: entries.reduce((a, e) => a + (num(e.whisperCharsDelta) ?? 0), 0),
    assistantCharsDeltaSum: entries.reduce((a, e) => a + (num(e.assistantCharsDelta) ?? 0), 0),
    messageCount: range(entries, "messageCount"),
    models: tally(entries, "model"),
    sources: tally(entries, "source"),
    healthModes: tally(entries, "healthMode"),
  };
}

/** Group entries per sessionId and summarize each. Sessions are ordered by
 *  their last heartbeat, newest first. */
export function summarizeHeartbeats(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const id =
      typeof entry.sessionId === "string" && entry.sessionId !== "" ? entry.sessionId : "unknown";
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(entry);
  }
  const sessions = [...groups.entries()]
    .map(([id, group]) => sessionSummary(id, group))
    .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  const allTs = entries.map((e) => num(e.ts)).filter((v) => v !== null);
  return {
    lines: entries.length,
    sessions,
    window: {
      first: allTs.length > 0 ? Math.min(...allTs) : null,
      last: allTs.length > 0 ? Math.max(...allTs) : null,
    },
  };
}

// ── render ──────────────────────────────────────────────────────────────────

function fmtCount(v) {
  if (v === null || v === undefined) return "n/a";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function fmtBytes(v) {
  if (v === null || v === undefined) return "n/a";
  const mb = v / 1048576;
  if (Math.abs(mb) >= 1024) return `${(mb / 1024).toFixed(2)}GB`;
  if (Math.abs(mb) >= 1) return `${mb.toFixed(1)}MB`;
  if (Math.abs(v) >= 1024) return `${(v / 1024).toFixed(1)}KB`;
  return `${v}B`;
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return "n/a";
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)}s`;
  if (s < 5400) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function fmtTime(ts) {
  return ts === null || ts === undefined ? "n/a" : new Date(ts).toISOString();
}

function fmtAge(ts, now) {
  if (ts === null || ts === undefined) return "n/a";
  return `${fmtDuration(now - ts)} ago`;
}

function fmtPct(v) {
  return v === null || v === undefined ? "n/a" : `${v.toFixed(1)}%`;
}

function fmtRate(v) {
  return v === null || v === undefined ? "n/a" : `${v.toFixed(1)} tok/s`;
}

export function renderReport(summary, { file, malformed = 0, now = Date.now(), limit = 5 } = {}) {
  const out = [];
  out.push(`Context heartbeat report — ${file}`);
  if (summary.lines === 0) {
    out.push("  no heartbeat lines yet (the producer has not ticked, or writes elsewhere)");
    return out.join("\n");
  }
  const totalTicks = summary.sessions.reduce((a, s) => a + s.ticks, 0);
  const totalDrops = summary.sessions.reduce((a, s) => a + s.drops.count, 0);
  out.push(
    `  lines: ${summary.lines} in ${summary.sessions.length} session(s)` +
      (malformed > 0 ? `, malformed: ${malformed}` : ""),
  );
  out.push(
    `  ticks: ${totalTicks}, context drops: ${totalDrops}, window: ${fmtTime(
      summary.window.first,
    )} .. ${fmtTime(summary.window.last)}`,
  );

  const shown = limit > 0 ? summary.sessions.slice(0, limit) : summary.sessions;
  for (const s of shown) {
    out.push("");
    out.push(`  session ${s.sessionId}`);
    out.push(
      `    ticks: ${s.ticks} (${Object.entries(s.sources)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")})`,
    );
    out.push(`    model: ${Object.keys(s.models).join(", ") || "n/a"}`);
    out.push(
      `    last heartbeat: ${fmtTime(s.lastTs)} (${fmtAge(s.lastTs, now)})` +
        `, cadence median ${fmtDuration(s.cadenceMs.median)}` +
        ` (min ${fmtDuration(s.cadenceMs.min)}, max ${fmtDuration(s.cadenceMs.max)})`,
    );
    const ct = s.contextTokens;
    out.push(
      `    context: ${ct ? fmtCount(ct.first) : "n/a"} -> ${ct ? fmtCount(ct.last) : "n/a"}` +
        `, peak ${ct ? fmtCount(ct.peak) : "n/a"}` +
        `, window ${fmtCount(s.contextWindow?.last)}` +
        `, last tick ${fmtPct(s.contextPercentLast)}`,
    );
    out.push(
      `    context drops (compaction/archive): ${s.drops.count}` +
        (s.drops.count > 0
          ? `, largest ${fmtCount(s.drops.largestDrop)}, net ${fmtCount(s.drops.totalDrop)}` +
            `, at ${s.drops.at.map(fmtTime).join(" ")}`
          : ""),
    );
    out.push(
      `    rss: ${fmtBytes(s.rssBytes?.first)} -> ${fmtBytes(s.rssBytes?.last)}` +
        `, peak ${fmtBytes(s.rssBytes?.peak)}; heap ${fmtBytes(s.heapUsed)}`,
    );
    out.push(
      `    session file: ${fmtBytes(s.sessionFileSizeBytes?.first)} -> ${fmtBytes(
        s.sessionFileSizeBytes?.last,
      )}; entries ${
        s.messageCount === null ? "n/a" : `${s.messageCount.first} -> ${s.messageCount.last}`
      }`,
    );
    out.push(
      `    throughput: last ${fmtRate(s.tokensPerSecLast)}, ema ${fmtRate(s.tpsEmaLast)},` +
        ` cache hit ${fmtPct(s.cacheHitShareMean)} (${s.cacheHitShareSamples} sample(s))`,
    );
    out.push(
      `    pressure: whispers ${s.whisperCountTotal ?? "n/a"} total (+${fmtCount(
        s.whisperCharsDeltaSum,
      )} chars since first tick), assistant +${fmtCount(s.assistantCharsDeltaSum)} chars`,
    );
    const modes = Object.entries(s.healthModes);
    if (modes.length > 0) {
      out.push(`    health modes: ${modes.map(([k, v]) => `${k} ${v}`).join(", ")}`);
    }
  }
  if (shown.length < summary.sessions.length) {
    out.push(
      `\n  showing ${shown.length} of ${summary.sessions.length} session(s) by last heartbeat;` +
        ` raise with --limit <n> (0 = all), or filter with --session <id>`,
    );
  }
  return out.join("\n");
}

// ── cli ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { file: CONTEXT_HEARTBEAT_FILE, sessions: [], json: false, limit: 5 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--file") opts.file = argv[++i];
    else if (arg === "--session") opts.sessions.push(argv[++i]);
    else if (arg === "--limit") opts.limit = Number(argv[++i]);
    else if (arg === "--json") opts.json = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else return { error: `unknown argument: ${arg}` };
  }
  if (opts.file === undefined) return { error: "--file needs a path" };
  if (opts.sessions.some((s) => s === undefined)) return { error: "--session needs an id" };
  if (!Number.isInteger(opts.limit) || opts.limit < 0) {
    return { error: "--limit needs a non-negative integer" };
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`context-heartbeat-report: ${opts.error}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  let text = "";
  let missing = false;
  try {
    text = readFileSync(opts.file, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`context-heartbeat-report: cannot read ${opts.file}: ${err.message}`);
      process.exit(2);
    }
    missing = true;
  }

  const { entries, malformed } = missing
    ? { entries: [], malformed: 0 }
    : parseHeartbeatLines(text);
  const selected = entries.filter((e) =>
    opts.sessions.length === 0
      ? true
      : opts.sessions.some((needle) => String(e.sessionId ?? "").includes(needle)),
  );

  const summary = summarizeHeartbeats(selected);
  summary.file = opts.file;
  summary.fileExists = !missing;
  summary.fileSizeBytes = missing ? null : statSync(opts.file).size;
  summary.malformedLines = malformed;

  if (opts.json) {
    console.log(
      JSON.stringify(
        { generatedAt: new Date().toISOString(), ...summary },
        null,
        2,
      ),
    );
    return;
  }

  if (missing) {
    console.log(`Context heartbeat report — ${opts.file}`);
    console.log("  no heartbeat file at this path (nothing written yet)");
    return;
  }
  console.log(renderReport(summary, { file: opts.file, malformed, limit: opts.limit }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
