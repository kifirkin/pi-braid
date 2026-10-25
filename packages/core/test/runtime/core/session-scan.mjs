#!/usr/bin/env node
/**
 * session-scan.mjs — the three numbers the skills floor is argued from.
 *
 * The skills question is measured, not felt: a session that never loads a
 * skill is indistinguishable from a session whose work needed none unless
 * something counts sessions. This reads the session logs pi already writes and
 * reports the numbers below. It is a REPORTING instrument: read-only, no
 * import from production code, no state, nothing that can fail a run.
 *
 *   M1 — thin-prompt read rate. Sessions with at least LONG_SESSION_CALLS tool
 *        calls whose first user prompt is shorter than THIN_PROMPT_CHARS: how
 *        many of them read at least one SKILL.md. A thin opening prompt
 *        carries no domain vocabulary, so a matcher-based suggestion channel
 *        has nothing to match; this number is what a keyword-ranked
 *        suggester can and cannot reach.
 *
 *   M2 — drift latency. A session whose path-taking calls (read/edit/write)
 *        touch a second work area after the first: the number of tool calls
 *        between the first call in that second area and the next skill
 *        surface (a suggestion whisper or a SKILL.md read). Sessions with no
 *        surface after the move report Infinity and count as uncovered. This
 *        is the number the prompt-visible catalog and its drift trigger aim
 *        at.
 *
 *   M3 — injected surface bytes. Bytes of skill-surface injection per
 *        session (suggestion and drift whispers), as median and p90, plus
 *        the share of long sessions that received a suggestion. The floor
 *        must not pay for its prompt visibility with a louder whisper
 *        channel.
 *
 * A work area is the first two directory segments of a path relative to the
 * session's own cwd (the directory the session opened in), so "the work moved
 * to another area" means the same thing here as it does in the trigger.
 *
 * Usage (the instrument acts only when asked, so a test-suite run of this
 * file does nothing):
 *   node test/runtime/core/session-scan.mjs --dir <sessions-root> [--days <n>] [--json]
 *
 * --dir defaults to <agent dir>/sessions (~/.pi/agent/sessions) once any flag
 * is given. --days filters on the session file's mtime. --json prints the raw
 *report object instead of the summary lines.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** A session with fewer tool calls is a conversation, not a work session. */
export const LONG_SESSION_CALLS = 20;

/** A first prompt this short names no domain: "continue where we left off". */
export const THIN_PROMPT_CHARS = 120;

/** Tools whose path argument says where the work is. */
const PATH_TOOLS = new Set(["read", "edit", "write"]);

/** Path-taking tools whose call can name a work area. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** The first user prompt of a session, in characters. */
function firstUserPrompt(entries) {
  for (const entry of entries) {
    const message = entry?.message;
    if (entry?.type !== "message" || message?.role !== "user") continue;
    const text = textOf(message.content).trim();
    if (text) return text;
    // Whispers and system-shaped user entries carry no task; keep looking.
  }
  return "";
}

/** The work area a tool call names, relative to the session's cwd. */
export function workArea(toolName, args, cwd) {
  if (!PATH_TOOLS.has(toolName) || !cwd) return undefined;
  const input = args?.path;
  if (typeof input !== "string" || !input) return undefined;
  const root = resolve(cwd);
  const absolute = resolve(root, input);
  const inside = relative(root, absolute);
  const segments = inside.split(sep).filter(Boolean);
  if (!segments.length || segments[0] === "..") return undefined;
  const directories = segments.slice(0, -1);
  if (directories.length < 2) return undefined;
  return directories.slice(0, 2).join("/");
}

/** True when a read-tool path names a SKILL.md. */
function isSkillRead(toolName, args) {
  return toolName === "read" && typeof args?.path === "string" && /SKILL\.md$/i.test(args.path);
}

/**
 * Read one session log into the facts the three metrics need. Never throws: a
 * truncated or hand-edited line is skipped, not fatal, and a file without a
 * session header is not a session.
 */
function parseSession(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partially written line is a crash artifact, not a metric.
    }
  }
  const session = entries.find((e) => e?.type === "session");
  if (!session) return undefined;
  return { entries, session };
}

/** One session's metrics, or undefined when the log is unreadable. */
export function sessionMetrics(filePath) {
  const parsed = parseSession(filePath);
  if (!parsed) return undefined;
  const { entries, session } = parsed;
  const cwd = typeof session.cwd === "string" ? session.cwd : "";

  let calls = 0;
  let skillReads = 0;
  let listSkillsCalls = 0;
  let suggestions = 0;
  let driftSurfaces = 0;
  let surfaceBytes = 0;
  /** Distinct work areas in first-touched order. */
  const areas = [];
  /** Call index at which each skill surface landed (whispers carry no call). */
  const surfaces = [];
  let driftCall = null;

  for (const entry of entries) {
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      const content = Array.isArray(entry.message.content) ? entry.message.content : [];
      for (const block of content) {
        if (block?.type !== "toolCall") continue;
        calls++;
        if (block.name === "list_skills") listSkillsCalls++;
        if (isSkillRead(block.name, block.arguments)) {
          skillReads++;
          surfaces.push(calls);
        }
        const area = workArea(block.name, block.arguments, cwd);
        if (area && !areas.includes(area)) {
          areas.push(area);
          // The call that first touched a second area is the drift point.
          if (areas.length === 2) driftCall = calls;
        }
      }
      continue;
    }
    if (entry?.type !== "custom_message") continue;
    const isSuggestion = entry.customType === "skills-suggestion";
    const isDrift = entry.customType === "skills-drift";
    if (!isSuggestion && !isDrift) continue;
    if (isSuggestion) suggestions++;
    else driftSurfaces++;
    surfaceBytes += Buffer.byteLength(textOf(entry.content), "utf8");
    surfaces.push(calls);
  }

  const prompt = firstUserPrompt(entries);
  let latency = null;
  if (driftCall !== null) {
    const next = surfaces.find((call) => call >= driftCall);
    latency = next === undefined ? null : next - driftCall;
  }

  return {
    file: filePath,
    startedAt: typeof session.timestamp === "string" ? session.timestamp : "",
    cwd,
    promptChars: prompt.length,
    calls,
    skillReads,
    listSkillsCalls,
    suggestions,
    driftSurfaces,
    surfaceBytes,
    areas,
    long: calls >= LONG_SESSION_CALLS,
    thin: prompt.length > 0 && prompt.length < THIN_PROMPT_CHARS,
    readSkill: skillReads > 0,
    drifted: driftCall !== null,
    driftLatency: latency,
    driftUncovered: driftCall !== null && latency === null,
  };
}

/** Every *.jsonl session file under a sessions root, one level of grouping. */
export function sessionFiles(root) {
  const files = [];
  let groups;
  try {
    groups = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const group of groups) {
    if (!group.isDirectory()) {
      if (group.name.endsWith(".jsonl")) files.push(join(root, group.name));
      continue;
    }
    const dir = join(root, group.name);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) if (name.endsWith(".jsonl")) files.push(join(dir, name));
  }
  return files;
}

/** The agent directory pi uses, honouring the same environment override. */
export function defaultSessionsRoot(env = process.env) {
  const agentDir = env.PI_AGENT_DIR
    ? env.PI_AGENT_DIR
    : join(env.HOME || homedir(), ".pi", "agent");
  return join(agentDir, "sessions");
}

/** Median of a sorted copy; null for an empty list. */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** p90 of a sorted copy; null for an empty list. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/**
 * Aggregate the three metrics over a sessions root. Pure given the files:
 * every number below is a count or a share of a population named beside it.
 */
export function scanSessions(root, options = {}) {
  const days = typeof options.days === "number" ? options.days : undefined;
  const since =
    days === undefined ? undefined : Date.now() - days * 24 * 60 * 60 * 1000;
  const sessions = [];
  for (const file of sessionFiles(root)) {
    if (since !== undefined) {
      let stats;
      try {
        stats = statSync(file);
      } catch {
        continue;
      }
      if (stats.mtimeMs < since) continue;
    }
    const metrics = sessionMetrics(file);
    if (metrics) sessions.push(metrics);
  }

  const long = sessions.filter((s) => s.long);
  const thinLong = long.filter((s) => s.thin);
  const thinLongRead = thinLong.filter((s) => s.readSkill);
  const drifted = sessions.filter((s) => s.drifted);
  const latencies = drifted
    .map((s) => s.driftLatency)
    .filter((value) => typeof value === "number");
  const surfaceBytes = sessions.map((s) => s.surfaceBytes).filter((n) => n > 0);

  return {
    root,
    population: {
      sessions: sessions.length,
      long: long.length,
      filesScanned: sessionFiles(root).length,
    },
    m1: {
      thinLong: thinLong.length,
      thinLongRead: thinLongRead.length,
      rate: thinLong.length ? thinLongRead.length / thinLong.length : null,
      thinLongWithListSkills: thinLong.filter((s) => s.listSkillsCalls > 0).length,
    },
    m2: {
      drifted: drifted.length,
      covered: latencies.length,
      uncovered: drifted.filter((s) => s.driftUncovered).length,
      medianCalls: median(latencies),
      p90Calls: percentile(latencies, 90),
      withinWindow: latencies.filter((value) => value <= 12).length,
    },
    m3: {
      sessionsWithSurface: surfaceBytes.length,
      medianBytes: median(surfaceBytes),
      p90Bytes: percentile(surfaceBytes, 90),
      maxBytes: surfaceBytes.length ? Math.max(...surfaceBytes) : null,
      suggestionRate: long.length ? long.filter((s) => s.suggestions > 0).length / long.length : null,
      driftLines: sessions.reduce((n, s) => n + s.driftSurfaces, 0),
    },
    sessions,
  };
}

/** Human-readable report; one block per metric, each naming its population. */
export function formatReport(report) {
  const pct = (value) => (value === null || value === undefined ? "n/a" : `${(100 * value).toFixed(1)}%`);
  const num = (value) => (value === null || value === undefined ? "n/a" : String(value));
  const lines = [];
  lines.push(`sessions: ${report.population.sessions} read from ${report.root}`);
  lines.push(
    `M1 thin-prompt read rate: ${report.m1.thinLongRead}/${report.m1.thinLong} = ${pct(report.m1.rate)}` +
      ` (long sessions with a <120-char first prompt; list_skills called in ${report.m1.thinLongWithListSkills})`,
  );
  lines.push(
    `M2 drift latency: ${report.m2.drifted} sessions moved work area, ${report.m2.covered} saw a skill surface after` +
      ` (median ${num(report.m2.medianCalls)} calls, p90 ${num(report.m2.p90Calls)},` +
      ` within 12 calls ${report.m2.covered ? report.m2.withinWindow : 0}); uncovered ${report.m2.uncovered}`,
  );
  lines.push(
    `M3 injected surface: median ${num(report.m3.medianBytes)} bytes, p90 ${num(report.m3.p90Bytes)},` +
      ` max ${num(report.m3.maxBytes)}; suggestion rate in long sessions ${pct(report.m3.suggestionRate)};` +
      ` drift lines ${report.m3.driftLines}`,
  );
  return lines.join("\n");
}

// CLI

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main(argv) {
  const dir = argValue(argv, "--dir");
  const daysRaw = argValue(argv, "--days");
  const json = argv.includes("--json");
  if (!dir && daysRaw === undefined && !json) {
    process.stdout.write(
      "session-scan: pass --dir <sessions-root> or --days <n> to scan (--json for machine output)\n",
    );
    return;
  }
  const days = daysRaw === undefined ? undefined : Number(daysRaw);
  const root = dir ? resolve(dir) : defaultSessionsRoot();
  const report = scanSessions(root, { days: Number.isFinite(days) ? days : undefined });
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatReport(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
