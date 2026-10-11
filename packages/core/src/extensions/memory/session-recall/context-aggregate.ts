/**
 * Session Recall - context adoption aggregate
 *
 * Cross-session aggregation of the context-management counters
 * (loss / coverage / adoption). Scans session files over a window and
 * reports:
 *   - compaction events (type:"compaction" entries)
 *   - verify/rollback loss (empty/boilerplate compaction summaries —
 *     the signal; the in-memory totalVerifyFailures counter
 *     manifests in files as lossy summaries on the coherence path)
 *   - archives written (coverage: context_compression /
 *     context_compress_slide custom entries + on-disk originals archives)
 *   - navigation adoption (tag/checkout/log via label / branch_summary /
 *     context_navigate tool calls)
 *   - an adoption_rate (loss-preferring navigation vs destructive compact)
 *
 * Pure read-only scan: never mutates session files, caps the scan
 * (max files, max file size). Testable against fixture session files.
 */

import { readFile, stat } from "node:fs/promises";
import { sep } from "node:path";
import { walkJsonlFiles, dateFromPath, pathMatchesProject, projectFromPath } from "./search.js";

/** Default window: recent 7 days. */
export const DEFAULT_WINDOW_DAYS = 7;
/** Default cap on the number of session files scanned. */
export const DEFAULT_MAX_FILES = 200;
/** Skip session files larger than this (keeps the scan cheap). */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Cheap boilerplate signatures for compaction summaries (the
 * signal: a "successful" compaction that destroyed context by summarizing
 * nothing). Deliberately a small regex set — keep it cheap, don't
 * over-engineer. Matches the observed empty-batch boilerplate family
 * ("No conversation content exists", "nothing — the conversation is
 * empty", "No decisions recorded", ...).
 */
const BOILERPLATE_PATTERNS: RegExp[] = [
  /no conversation content exists/i,
  /no user goal to summarize/i,
  /nothing (?:—|-|:).*the conversation is empty/i,
  /no decisions recorded/i,
  /await actual conversation content/i,
  /the <conversation> block in the input was empty/i,
  /there are no messages/i,
  /conversation is empty/i,
];

export interface ContextAggregateOptions {
  /** Window start, YYYY-MM-DD inclusive. Defaults to 7 days ago. */
  since?: string;
  /** Window end, YYYY-MM-DD inclusive. Defaults to today. */
  until?: string;
  /** Project filter (substring on the session path). null = all. */
  project?: string | null;
  /** Cap on the number of session files scanned. Default 200. */
  maxFiles?: number;
  /** Skip session files larger than this many bytes. Default 5 MB. */
  maxFileSizeBytes?: number;
}

export interface ContextAggregateResult {
  window: { since: string; until: string };
  scanned: {
    files: number;
    totalAvailable: number;
    skippedOversize: number;
    projects: string[];
  };
  compaction: {
    events: number;
    lossy: number;
  };
  coverage: {
    archives: number;
    slides: number;
    deepCleans: number;
    originalsArchives: number;
  };
  adoption: {
    tags: number;
    checkouts: number;
    logs: number;
    archives: number;
    slides: number;
    deepCleans: number;
  };
  /** Loss-preferring navigation actions (tag/checkout/log/archive/slide/deep-clean). */
  navigationActions: number;
  /** Destructive compactions (durable type:"compaction" entries). */
  compactions: number;
  /** adoption_rate = navigation / (navigation + compactions); null when idle. */
  adoptionRate: number | null;
  /** Sessions that adopted ≥1 navigation action. */
  adoptingSessions: number;
  /** Sessions that compacted ≥1 time. */
  compactingSessions: number;
  /** One-line trend read. */
  trend: string;
}

/**
 * True when a compaction summary is empty or matches the boilerplate
 * family (the compaction loss signal). Cheap by design.
 */
export function isBoilerplateSummary(summary: string | undefined | null): boolean {
  const text = (summary ?? "").trim();
  if (text.length === 0) return true;
  return BOILERPLATE_PATTERNS.some((p) => p.test(text));
}

/**
 * Aggregate the §8 signals of a single session file. Parses each JSONL
 * line and counts the durable markers:
 *   - type:"compaction"      -> compaction event (lossy when boilerplate)
 *   - type:"custom"          -> context_compression (archive/deep-clean) /
 *                               context_compress_slide (slide)
 *   - type:"label"           -> tag
 *   - type:"branch_summary"  -> checkout
 *   - assistant toolCall     -> context_navigate(action=log) -> log
 * Returns null for unreadable files (caller decides how to count them).
 */
export async function aggregateSessionFile(filePath: string): Promise<{
  compactions: number;
  lossy: number;
  archives: number;
  slides: number;
  deepCleans: number;
  tags: number;
  checkouts: number;
  logs: number;
} | null> {
  const counts = {
    compactions: 0,
    lossy: 0,
    archives: 0,
    slides: 0,
    deepCleans: 0,
    tags: 0,
    checkouts: 0,
    logs: 0,
  };
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const type = entry.type;
    if (type === "compaction") {
      counts.compactions++;
      if (isBoilerplateSummary(entry.summary)) counts.lossy++;
    } else if (type === "custom") {
      if (entry.customType === "context_compression") {
        counts.archives++;
        if (entry.data?.fromDeepClean === true) counts.deepCleans++;
      } else if (entry.customType === "context_compress_slide") {
        counts.slides++;
      }
    } else if (type === "label") {
      counts.tags++;
    } else if (type === "branch_summary") {
      counts.checkouts++;
    } else if (type === "message") {
      const msg = entry.message;
      if (msg?.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "toolCall" && block.name === "context_navigate") {
            const args =
              typeof block.arguments === "string"
                ? safeParseArgs(block.arguments)
                : block.arguments;
            if (args?.action === "log") counts.logs++;
          }
        }
      }
    }
  }
  return counts;
}

function safeParseArgs(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function dateToTs(dateStr: string): number {
  return new Date(dateStr + "T00:00:00.000Z").getTime();
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Scan session files under `sessionsDir` over the window and aggregate the
 * §8 context-management counters. Pure and read-only: never mutates files,
 * caps the scan (maxFiles, maxFileSizeBytes). Originals archives on disk
 * (<dir>/archives/*.jsonl) are counted separately as coverage.
 */
export async function aggregateContextAdoption(
  sessionsDir: string,
  options: ContextAggregateOptions = {},
): Promise<ContextAggregateResult> {
  const since = options.since ?? daysAgoStr(DEFAULT_WINDOW_DAYS);
  const until = options.until ?? todayStr();
  const sinceTs = dateToTs(since);
  const untilTs = dateToTs(until) + 24 * 60 * 60 * 1000 - 1;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const projectFilter = options.project ?? null;

  const allFiles = await walkJsonlFiles(sessionsDir);
  const totalAvailable = allFiles.length;

  // Partition: originals archives (<dir>/archives/*.jsonl) are coverage,
  // not sessions.
  const archiveFiles: string[] = [];
  const sessionFiles: string[] = [];
  const archiveMarker = `${sep}archives${sep}`;
  for (const f of allFiles) {
    if (f.includes(archiveMarker)) archiveFiles.push(f);
    else sessionFiles.push(f);
  }

  const result: ContextAggregateResult = {
    window: { since, until },
    scanned: { files: 0, totalAvailable, skippedOversize: 0, projects: [] },
    compaction: { events: 0, lossy: 0 },
    coverage: { archives: 0, slides: 0, deepCleans: 0, originalsArchives: 0 },
    adoption: { tags: 0, checkouts: 0, logs: 0, archives: 0, slides: 0, deepCleans: 0 },
    navigationActions: 0,
    compactions: 0,
    adoptionRate: null,
    adoptingSessions: 0,
    compactingSessions: 0,
    trend: "",
  };

  const projects = new Set<string>();
  let scanned = 0;
  let skippedOversize = 0;

  for (const filePath of sessionFiles) {
    if (scanned >= maxFiles) break;
    const dateStr = dateFromPath(filePath);
    if (dateStr === "unknown") continue;
    const fileTs = dateToTs(dateStr);
    if (fileTs < sinceTs || fileTs > untilTs) continue;
    if (projectFilter && !pathMatchesProject(filePath, projectFilter)) continue;

    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      continue;
    }
    if (size > maxFileSizeBytes) {
      skippedOversize++;
      continue;
    }

    const counts = await aggregateSessionFile(filePath);
    if (!counts) continue;
    scanned++;
    projects.add(projectFromPath(filePath));

    result.compaction.events += counts.compactions;
    result.compaction.lossy += counts.lossy;
    result.coverage.archives += counts.archives;
    result.coverage.slides += counts.slides;
    result.coverage.deepCleans += counts.deepCleans;
    result.adoption.tags += counts.tags;
    result.adoption.checkouts += counts.checkouts;
    result.adoption.logs += counts.logs;
    result.adoption.archives += counts.archives;
    result.adoption.slides += counts.slides;
    result.adoption.deepCleans += counts.deepCleans;

    const nav =
      counts.tags +
      counts.checkouts +
      counts.logs +
      counts.archives +
      counts.slides +
      counts.deepCleans;
    if (nav > 0) result.adoptingSessions++;
    if (counts.compactions > 0) result.compactingSessions++;
  }

  // On-disk originals archives (coverage): filter by the epoch in the
  // filename (<sessionId>-<leafId>-<epoch>.jsonl) within the window.
  for (const f of archiveFiles) {
    const epochMatch = f.match(/(\d{13})\.jsonl$/);
    if (!epochMatch) continue;
    const epoch = parseInt(epochMatch[1], 10);
    if (epoch >= sinceTs && epoch <= untilTs) {
      if (projectFilter && !pathMatchesProject(f, projectFilter)) continue;
      result.coverage.originalsArchives++;
    }
  }

  result.scanned.files = scanned;
  result.scanned.skippedOversize = skippedOversize;
  result.scanned.projects = [...projects].sort();

  result.navigationActions =
    result.adoption.tags +
    result.adoption.checkouts +
    result.adoption.logs +
    result.adoption.archives +
    result.adoption.slides +
    result.adoption.deepCleans;
  result.compactions = result.compaction.events;

  const total = result.navigationActions + result.compactions;
  if (total > 0) {
    result.adoptionRate = result.navigationActions / total;
  }

  result.trend = computeTrend(result);
  return result;
}

function computeTrend(r: ContextAggregateResult): string {
  if (r.compaction.events === 0 && r.navigationActions === 0) {
    return "no §8 activity in window";
  }
  if (r.compaction.lossy > 0) {
    return `lossy compactions ${r.compaction.lossy}/${r.compaction.events} — verify/rollback stage is the loss gate`;
  }
  if (r.adoptionRate === null) return "no context-management activity in window";
  if (r.adoptionRate >= 0.6)
    return `adoption ${(r.adoptionRate * 100).toFixed(0)}% — navigation-first steering dominant`;
  if (r.adoptionRate >= 0.3)
    return `adoption ${(r.adoptionRate * 100).toFixed(0)}% — mixed steering, compaction still frequent`;
  return `adoption ${(r.adoptionRate * 100).toFixed(0)}% — compaction-dominant, navigation adoption low`;
}

/**
 * Format the aggregate as a concise summary block (≤ ~40 lines).
 */
export function formatContextAggregate(r: ContextAggregateResult): string {
  const rate =
    r.adoptionRate === null ? "n/a (no activity)" : `${(r.adoptionRate * 100).toFixed(0)}%`;
  const lines: string[] = [
    `## Option B §8 — Cross-Session Context Adoption`,
    `**Window:** ${r.window.since} .. ${r.window.until}`,
    ``,
    `**Scanned:** ${r.scanned.files} session(s) of ${r.scanned.totalAvailable} available (cap ${r.scanned.files === 0 ? "n/a" : "applied"}) · ${r.scanned.skippedOversize} skipped oversized · projects: ${r.scanned.projects.join(", ") || "none"}`,
    ``,
    `**Compaction:** ${r.compaction.events} event(s) · ${r.compaction.lossy} lossy (empty/boilerplate summary)`,
    `**Coverage:** ${r.coverage.archives} archive(s) declared · ${r.coverage.slides} slide(s) · ${r.coverage.deepCleans} deep-clean(s) · ${r.coverage.originalsArchives} originals archive(s) on disk`,
    `**Navigation adoption:** ${r.adoption.tags} tag(s) · ${r.adoption.checkouts} checkout(s) · ${r.adoption.logs} log(s)`,
    `**Adoption rate:** ${rate} (${r.navigationActions} loss-preferring navigation vs ${r.compactions} compact(s))`,
    `**Sessions:** ${r.adoptingSessions} adopted navigation · ${r.compactingSessions} compacted`,
    ``,
    `**Trend:** ${r.trend}`,
  ];
  return lines.join("\n");
}
