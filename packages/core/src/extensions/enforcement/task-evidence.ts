/**
 * Task Evidence — verification judge evidence index.
 *
 * The verification judge audits work via a tool log built from enforcement
 * turnHistory, which is recorded only at turn_end. A turn BROKEN by a
 * wake-retry redelivery (a failed wake fire is re-delivered with bounded
 * backoff) therefore leaves the judge with only the redelivered tail
 * turn's log — finalize + response text. All earlier verification evidence
 * (bash/powershell runs with [OK]/[FAIL], telegram_send receipts, poller
 * enables, timer/agent lifecycle calls) goes invisible and the judge
 * false-alarms on work that WAS done (observed: WARN 62%,
 * FAIL 82%, FAIL 92%).
 *
 * This module rebuilds the evidence from the authoritative source instead:
 * the pi session store (sessionManager.getBranch()). The session store
 * persists every message and custom message with a timestamp regardless of
 * turn outcome, so it survives turn breaks, leaf switches, and reloads.
 *
 * Task boundary: the last REAL user message (type "message", role "user").
 * Injected braid traffic (whispers, timer fires, steers) is persisted as
 * custom_message entries and NEVER resets the boundary — it rides within
 * the task.
 *
 * Output: ordered, timestamped evidence lines (oldest first). When the log
 * outgrows TASK_EVIDENCE_CAP, summarizeTaskEvidence() keeps full-log
 * coverage by compacting older chunks with cheap LLM sub-summary calls
 * (the newest chunk stays raw); any sub-call failure degrades to the
 * legacy drop-oldest cap with an explicit count line — never silent
 * truncation.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSessionManager } from "../../lib/state/session-manager.js";
import { createLogger } from "../../lib/core/logger.js";
import { callLlm } from "./judge-utils.js";

const log = createLogger("enforcement:task-evidence");

/** Cap on evidence lines fed to the judge prompt (drop-oldest). */
export const TASK_EVIDENCE_CAP = 200;

/**
 * Options for collectTaskEvidence.
 */
export interface CollectTaskEvidenceOptions {
  /**
   * Apply the TASK_EVIDENCE_CAP drop-oldest truncation before returning.
   * Default true. Pass false when the caller will summarize the evidence
   * (summarizeTaskEvidence) and wants full-log coverage instead.
   */
  cap?: boolean;
}

/** Max chars of a tool result's text kept per evidence line (matches turn-end MAX_OUTPUT_CHARS). */
const MAX_OUTPUT_CHARS = 300;

/** Max chars of a toolCall's argument summary kept per evidence line. */
const MAX_ARGS_CHARS = 150;

/** Max chars of the boundary user-message excerpt. */
const MAX_BOUNDARY_CHARS = 120;

export interface TaskEvidence {
  /** Ordered lines (oldest first), each `HH:MM:SS ...`, incl. the boundary marker. */
  lines: string[];
  /** Entries dropped from the FRONT by the cap (rendered as an explicit count line). */
  truncatedCount: number;
}

/** A toolCall seen whose toolResult has not (yet) been persisted. */
interface PendingCall {
  name: string;
  args: string;
}

function hhmmss(iso: string | undefined): string {
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d.toTimeString().slice(0, 8);
  }
  return "--:--:--";
}

/** Collapse whitespace and truncate with an ellipsis marker. */
function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Summarize toolCall arguments: full command for command runners, compact JSON otherwise. */
function summarizeArgs(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (isRecord(input) && typeof input.command === "string") {
    return truncate(input.command, MAX_ARGS_CHARS);
  }
  try {
    return truncate(JSON.stringify(input), MAX_ARGS_CHARS);
  } catch {
    return "";
  }
}

/** Flatten a tool result content array to one bounded text snippet. */
function resultSnippet(content: unknown): string {
  if (!Array.isArray(content)) return "(no output)";
  const text = content
    .filter((c) => isRecord(c) && c.type === "text")
    .map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : ""))
    .join(" ");
  return text.trim() ? truncate(text, MAX_OUTPUT_CHARS) : "(no output)";
}

/** Flatten a user message content to one bounded text snippet. */
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => isRecord(c) && c.type === "text")
    .map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : ""))
    .join(" ");
}

/**
 * Collect task-wide evidence from the session store: everything since the
 * last real user message. Returns null when the session store is
 * unavailable (stale ctx / ephemeral session) — callers fall back to the
 * turnHistory-derived tool log.
 */
export function collectTaskEvidence(
  ctx: ExtensionContext,
  options: CollectTaskEvidenceOptions = {},
): TaskEvidence | null {
  try {
    const branch = getSessionManager(ctx).getBranch();

    const pending = new Map<string, PendingCall>();
    const collected: string[] = [];

    for (const rawEntry of branch) {
      // Narrow the pi SessionEntry union: not every member carries timestamp.
      const entry = rawEntry as { type: string; timestamp?: string; message?: unknown };
      if (entry.type !== "message") continue; // custom_message / custom / label: skip entirely
      const msg = entry.message;
      if (!isRecord(msg)) continue;
      const role = msg.role;

      if (role === "user") {
        // Task boundary: a real user message restarts the evidence window.
        // Injected traffic never lands here (it is persisted as
        // custom_message, which is skipped above).
        collected.length = 0;
        pending.clear();
        const text = userText(msg.content);
        collected.push(
          `${hhmmss(entry.timestamp)} ── task start: user ── ${truncate(text, MAX_BOUNDARY_CHARS)}`,
        );
        continue;
      }

      if (role === "assistant") {
        const content = msg.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          if (!isRecord(c) || c.type !== "toolCall") continue;
          const id = typeof c.id === "string" ? c.id : undefined;
          if (!id) continue;
          pending.set(id, {
            name: typeof c.name === "string" ? c.name : "tool",
            args: summarizeArgs(c.arguments),
          });
        }
        continue;
      }

      if (role === "toolResult") {
        const id = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
        const call = id ? pending.get(id) : undefined;
        if (id) pending.delete(id);
        const name = typeof msg.toolName === "string" ? msg.toolName : (call?.name ?? "tool");
        const isError = msg.isError === true;
        const status = isError ? "FAIL" : "OK";
        // Command runners: the command itself is the evidence — the result
        // snippet may only carry stdout. Everything else: result text
        // (telegram_send messageId/ok, poller enable results, agent
        // lifecycle lines all live in the result text).
        const argsPart =
          (name === "bash" || name === "powershell") && call?.args ? ` $ ${call.args}: ` : "";
        collected.push(
          `${hhmmss(entry.timestamp)} ${name} [${status}]: ${argsPart}${resultSnippet(msg.content)}`,
        );
      }
    }

    // Result-less toolCalls still in flight (the assistant message the judge
    // is currently auditing, e.g. the finalize call itself) — emit them so
    // the judge sees the calls of the very message under audit. Only when
    // they belong to the branch's last assistant message; older unresolved
    // calls (aborted turns) are stale and must not surface.
    const last = branch[branch.length - 1] as { type?: string; message?: unknown } | undefined;
    const lastMsgRole = isRecord(last?.message)
      ? (last!.message as { role?: unknown }).role
      : undefined;
    if (last?.type === "message" && lastMsgRole === "assistant" && pending.size > 0) {
      for (const call of pending.values()) {
        collected.push(
          `${hhmmss(undefined)} ${call.name} (in flight): ${call.args || "(no args)"}`,
        );
      }
    }

    if (collected.length === 0) return null;

    // Cap with explicit truncation count — never silent. Callers that
    // opted out of the cap hand the full log to summarizeTaskEvidence.
    let truncatedCount = 0;
    if ((options.cap ?? true) && collected.length > TASK_EVIDENCE_CAP) {
      truncatedCount = collected.length - TASK_EVIDENCE_CAP;
      collected.splice(0, truncatedCount);
    }
    return { lines: collected, truncatedCount };
  } catch (e) {
    log.debug(`task evidence unavailable: ${(e as Error).message}`);
    return null;
  }
}

/** The explicit "N older entries truncated" count line (never silent truncation). */
function truncationCountLine(truncatedCount: number, keptLines: number): string {
  return `(${truncatedCount} older evidence entries truncated — showing last ${TASK_EVIDENCE_CAP} of ${truncatedCount + keptLines})`;
}

/**
 * Render a TaskEvidence object into prompt lines the legacy way (shared by
 * the judge prompt builder and tests): drop-oldest truncation for logs over
 * the cap, optional explicit truncation count line first, then the ordered
 * evidence lines. This is also the fallback shape summarizeTaskEvidence
 * callers render when chunk sub-summaries fail.
 */
export function renderTaskEvidence(evidence: TaskEvidence): string[] {
  let lines = evidence.lines;
  let truncatedCount = evidence.truncatedCount;
  if (lines.length > TASK_EVIDENCE_CAP) {
    truncatedCount += lines.length - TASK_EVIDENCE_CAP;
    lines = lines.slice(lines.length - TASK_EVIDENCE_CAP);
  }
  if (truncatedCount > 0) {
    return [truncationCountLine(truncatedCount, lines.length), ...lines];
  }
  return lines;
}

// Chunked evidence summaries (map-reduce over the session model)

/**
 * Hard bound on chunk sub-summary LLM calls per render. Logs that would
 * need more sub-calls grow the chunk size instead, so the bound holds for
 * a log of any length.
 */
export const MAX_CHUNK_SUMMARIES = 6;

/** Target lines per evidence chunk (the raw newest chunk is also about this size). */
const CHUNK_TARGET_LINES = 150;

/** Wall-clock bound per sub-summary call; a miss degrades to the legacy cap render. */
const CHUNK_SUMMARY_TIMEOUT_MS = 15_000;

/** Defensive cap on one sub-summary's length (models occasionally overrun token instructions). */
const MAX_CHUNK_SUMMARY_CHARS = 600;

const CHUNK_SUMMARY_SYSTEM_PROMPT = `Compress one segment of an agent's task evidence log for a quality-audit prompt. Output plain text only, at most 60 tokens, no preamble. Preserve: per-tool counts of [OK] and [FAIL] results, key verification commands (tests, typecheck, build, git — include commit hashes when shown), sent-message receipts, and any failure text verbatim. Omit routine noise.`;

/** Seam for one chunk sub-summary call; mirrors the shared callLlm result shape. */
export type ChunkSummarizeLlm = (
  systemPrompt: string,
  userPrompt: string,
  options: { signal?: AbortSignal },
) => Promise<{ text: string } | { error: string }>;

export interface SummarizeTaskEvidenceOptions {
  /** Abort signal threaded into every sub-summary call (the same signal the judge itself honors). */
  signal?: AbortSignal;
  /**
   * LLM seam for the sub-summaries. Defaults to the shared callLlm wrapper
   * (utility → session model chain). Tests inject a stub here instead of
   * mocking modules.
   */
  summarizeLlm?: ChunkSummarizeLlm;
}

/**
 * Split evidence lines into chunks: the newest chunk stays raw, every older
 * chunk becomes one sub-summary. Chunk size targets CHUNK_TARGET_LINES but
 * grows when that would need more than MAX_CHUNK_SUMMARIES sub-calls, so
 * the bound holds for a log of any length.
 */
function splitEvidenceChunks(lines: string[]): string[][] {
  const summaryCount = Math.max(
    1,
    Math.min(MAX_CHUNK_SUMMARIES, Math.ceil(lines.length / CHUNK_TARGET_LINES) - 1),
  );
  const chunkSize = Math.ceil(lines.length / (summaryCount + 1));
  const chunks: string[][] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    chunks.push(lines.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Bound a sub-summary promise by a hard wall-clock timeout so a hung seam
 * can never stall the judge; rejects on timeout, otherwise resolves with
 * the seam's own { text } / { error } result.
 */
function withSubCallTimeout(
  call: Promise<{ text: string } | { error: string }>,
  label: string,
): Promise<{ text: string } | { error: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      CHUNK_SUMMARY_TIMEOUT_MS,
    );
    call.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Render task evidence into the judge's final prompt lines, keeping
 * full-log coverage when the log exceeds TASK_EVIDENCE_CAP:
 *
 * - At or under the cap: returns renderTaskEvidence(evidence) — no LLM
 *   calls, byte-identical to the legacy render.
 * - Over the cap: the log is split into chunks; each older chunk is
 *   compacted by one parallel LLM sub-summary call (bounded, signal-aware)
 *   and the newest chunk stays raw. The result is one numbered summary
 *   line per older chunk (oldest first), then the raw newest chunk, then —
 *   only when the caller passed pre-truncated evidence — the explicit
 *   count line.
 * - ANY sub-call failure (error, timeout, abort, empty output) logs and
 *   returns null: the caller falls back to renderTaskEvidence, whose
 *   drop-oldest render is the legacy behavior. Chunking never blocks or
 *   breaks the judge.
 */
export async function summarizeTaskEvidence(
  ctx: ExtensionContext,
  evidence: TaskEvidence,
  options: SummarizeTaskEvidenceOptions = {},
): Promise<string[] | null> {
  if (evidence.lines.length <= TASK_EVIDENCE_CAP) {
    return renderTaskEvidence(evidence);
  }

  const chunks = splitEvidenceChunks(evidence.lines);
  const summarize: ChunkSummarizeLlm =
    options.summarizeLlm ??
    ((systemPrompt, userPrompt, subOptions) =>
      callLlm(ctx, systemPrompt, userPrompt, {
        timeoutMs: CHUNK_SUMMARY_TIMEOUT_MS,
        maxRetries: 0, // best-effort sub-calls: fail fast into the fallback instead of retrying
        ...(subOptions.signal ? { signal: subOptions.signal } : {}),
      }));

  // Line range (1-based) each chunk covers, for the sub-summary prompts.
  const ranges: string[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    ranges.push(`${offset + 1}-${offset + chunk.length}`);
    offset += chunk.length;
  }

  try {
    // Map: one sub-summary per older chunk, all in parallel; each bounded
    // by the hard timeout so a slow model cannot outlive the judge budget.
    const summaries = await Promise.all(
      chunks.slice(0, -1).map((chunk, i) =>
        withSubCallTimeout(
          summarize(
            CHUNK_SUMMARY_SYSTEM_PROMPT,
            `Evidence lines ${ranges[i]} of ${evidence.lines.length} (oldest first):\n${chunk.join("\n")}`,
            { signal: options.signal },
          ),
          `evidence chunk ${i + 1}/${chunks.length - 1} summary`,
        ).then((result) => {
          if ("error" in result) {
            throw new Error(`chunk ${i + 1} summary failed: ${result.error}`);
          }
          const text = result.text.trim();
          if (!text) {
            throw new Error(`chunk ${i + 1} summary was empty`);
          }
          return text.length > MAX_CHUNK_SUMMARY_CHARS
            ? text.slice(0, MAX_CHUNK_SUMMARY_CHARS) + "…"
            : text;
        }),
      ),
    );

    // Reduce: numbered summaries oldest-first, then the raw newest chunk.
    const rendered: string[] = [];
    chunks.forEach((chunk, i) => {
      if (i < chunks.length - 1) {
        rendered.push(`(chunk ${i + 1}/${chunks.length} summary) ${summaries[i]}`);
      } else {
        rendered.push(...chunk);
      }
    });
    // Pre-truncated evidence (entries the summarizer never saw) keeps the
    // explicit count line; the wired call site collects uncapped, so this
    // is a defensive branch only.
    if (evidence.truncatedCount > 0) {
      rendered.push(truncationCountLine(evidence.truncatedCount, evidence.lines.length));
    }
    return rendered;
  } catch (e) {
    const message = (e as Error).message;
    if (/abort/i.test(message)) {
      log.debug(`task evidence chunk summaries aborted (${message}); using drop-oldest truncation`);
    } else {
      log.warn(`task evidence chunk summaries failed (${message}); using drop-oldest truncation`);
    }
    return null;
  }
}
