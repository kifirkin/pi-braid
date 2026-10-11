// Emergency context-window offloader.
//
// Oversized toolResults (screenshot/base64 class payloads) make every
// provider request return 413 payload-too-large. The agent-loop auto-retry
// re-sends the SAME oversized payload in a loop, burning quota, while the
// machinery that could shrink the request (compaction, heartbeat
// consolidation) is gated OFF by the session health the 413 itself caused
// (mode "context_overflow").
//
// This module is the health-gate exception:
//   1. `runContextEmergencyOffload(ctx, reason)` — error-driven, deterministic
//      (pure char-count, no LLM): plans the LARGEST eligible toolResults,
//      flushes their FULL content (JSON, lossless — text and images) to disk
//      under OFFLOAD_DIR, and records a stub for each into CmState.
//   2. A `context` event handler applies those stubs to the PER-REQUEST
//      context on every LLM call (pi-core's transformContext path, same
//      proven mechanism as the stale offloader). The session file stays
//      append-only — the shrink is a substitution view, lossless by
//      construction, and survives the retry that re-reads the branch.
//
// The runner is published into the process-global slot
// (CONTEXT_EMERGENCY_OFFLOAD_RUNNER_KEY) so consumers outside the
// context-manager tree (llm-call retry path, heartbeat consolidation gate,
// compaction context-window handler, providers pre-send guard) can trigger
// it without an import-cycle.
//
// Setting: braid.context.contextEmergencyOffload (default ON — a 413 loop
// burns quota; the offload is lossless). Skips isError results (decision-
// relevant), internal-tool results, and already-stubbed entries. Unlike the
// Age-based offloader, non-text (image) blocks are ELIGIBLE here — an
// emergency is exactly when a base64 blob must go to disk.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getContextEmergencyOffloadConfig,
  type ResolvedContextEmergencyOffloadConfig,
} from "../../../../lib/config/braid-settings.js";
import { getOffloadFilePath, OFFLOAD_DIR } from "../../../../lib/config/braid-paths.js";
import {
  setContextEmergencyOffloadRunner,
  type ContextEmergencyOffloadResult,
} from "../../../../lib/state/global-state.js";
import { getCmState, isInternal, log } from "./shared.js";
import { STALE_OFFLOAD_STUB_PREFIX } from "./offload.js";

/** Shared stub-family prefix — both offloaders recognize each other's stubs. */
export const EMERGENCY_OFFLOAD_STUB_PREFIX = STALE_OFFLOAD_STUB_PREFIX;

/** First N chars of text kept inline in the stub for orientation. */
export const EMERGENCY_STUB_INLINE_CHARS = 500;

/** One toolResult selected for emergency offload. */
export interface EmergencyOffloadPlanItem {
  /** Position in the scanned message array (diagnostics). */
  index: number;
  toolCallId: string;
  toolName: string;
  /** Estimated in-context chars the stub replaces. */
  chars: number;
}

/**
 * Estimate the in-context size of one message's content in chars:
 * text blocks contribute their text length; image blocks contribute their
 * base64 data length (the actual payload a 413 chokes on); unknown blocks
 * contribute their JSON length. Non-array content falls back to its JSON
 * length.
 */
export function estimateMessageChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) {
    if (content == null) return 0;
    try {
      return JSON.stringify(content).length;
    } catch {
      return 0;
    }
  }
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: unknown; data?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      total += b.text.length;
    } else if (b.type === "image" && typeof b.data === "string") {
      total += b.data.length;
    } else if (b.type != null) {
      try {
        total += JSON.stringify(block).length;
      } catch {
        /* unserializable block — ignore */
      }
    }
  }
  return total;
}

/** Recognize an already-offloaded entry (this offloader's or 's stub). */
function isStubbed(msg: { content?: unknown }): boolean {
  if (!Array.isArray(msg.content) || msg.content.length === 0) return false;
  const first = msg.content[0] as { type?: string; text?: unknown } | undefined;
  return (
    first?.type === "text" &&
    typeof first.text === "string" &&
    first.text.startsWith(EMERGENCY_OFFLOAD_STUB_PREFIX)
  );
}

/**
 * Deterministic planning pass for the emergency offload. Pure char-count +
 * recency logic: no LLM, no I/O.
 *
 * Eligibility (ALL required):
 *   - role === "toolResult", not isError, not already stubbed;
 *   - toolName not an internal braid tool (shared.ts INTERNAL_TOOLS);
 *   - chars >= minChars;
 *   - age >= keepRecentTurns (rank among toolResults from the end — the
 *     immediately-latest result stays visible so the agent keeps the
 *     freshest decision evidence; configurable, hard floor at 0);
 *   - cumulative chars fit within maxCharsPerRun, LARGEST FIRST (the
 *     emergency is about shrinking: the biggest blob goes first).
 *
 * Unlike the planner, non-text (image) content is eligible: a base64
 * payload is precisely the 413 source this module exists for, and the flush
 * is JSON-lossless.
 */
export function planContextEmergencyOffloads(
  messages: AgentMessage[],
  cfg: ResolvedContextEmergencyOffloadConfig,
): { plan: EmergencyOffloadPlanItem[]; alreadyStubbed: number } {
  // Rank from end among tool results (0 = most recent tool result).
  const ranks = new Map<number, number>();
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string } | undefined;
    if (msg?.role === "toolResult") {
      ranks.set(i, seen);
      seen++;
    }
  }

  const candidates: EmergencyOffloadPlanItem[] = [];
  let alreadyStubbed = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as {
      role?: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      content?: unknown;
    };
    if (msg?.role !== "toolResult") continue;
    if (msg.isError === true) continue;
    if (isStubbed(msg)) {
      alreadyStubbed++;
      continue;
    }
    if (isInternal(String(msg.toolName ?? ""))) continue;
    const chars = estimateMessageChars(msg.content);
    if (chars < cfg.minChars) continue;
    if ((ranks.get(i) ?? 0) < cfg.keepRecentTurns) continue;
    candidates.push({
      index: i,
      toolCallId: String(msg.toolCallId ?? `idx-${i}`),
      toolName: String(msg.toolName ?? "unknown"),
      chars,
    });
  }

  // Largest first; a single item larger than the whole budget is still
  // planned ALONE if nothing else fits — in an emergency the biggest blob
  // is the primary suspect and must go even if the budget cannot admit more.
  candidates.sort((a, b) => b.chars - a.chars);
  const plan: EmergencyOffloadPlanItem[] = [];
  const budget = cfg.maxCharsPerRun;
  let budgetUsed = 0;
  for (const item of candidates) {
    if (plan.length === 0) {
      plan.push(item); // first (largest) always goes
      budgetUsed = item.chars;
      continue;
    }
    if (budgetUsed + item.chars > budget) continue;
    plan.push(item);
    budgetUsed += item.chars;
  }
  return { plan, alreadyStubbed };
}

/** IO seam for the emergency apply (injected in tests). */
export interface EmergencyOffloadIo {
  nowIso(): string;
  exists(path: string): boolean;
  /** mkdir -p + write the full JSON content. Throws on failure. */
  flush(path: string, contentJson: string): void;
  flushPath(sessionId: string, toolCallId: string, toolName: string): string;
}

/** Persistent per-session stub record stored in CmState. */
export interface EmergencyStubRecord {
  stub: string;
  /** In-context chars the stub replaces. */
  chars: number;
  /** ISO timestamp of the first flush (stub stability across calls). */
  iso: string;
  /** Flush file path (recovery = read it). */
  path: string;
}

/**
 * Build the stub text for one offloaded entry. Brief format:
 * `[offloaded: <tool> result, N chars, <iso> — full text flushed to disk
 * (JSON): <path>]`, plus the first ~500 chars inline for text content so the
 * agent retains a hint of what was in the result.
 */
export function buildEmergencyStub(
  toolName: string,
  chars: number,
  iso: string,
  path: string,
  inlineText?: string,
): string {
  let stub =
    `[offloaded: ${toolName} result, ${chars} chars, ${iso} — ` +
    `full text flushed to disk (JSON): ${path}]`;
  if (inlineText) {
    const head = inlineText.slice(0, EMERGENCY_STUB_INLINE_CHARS);
    stub += `\n[first ${head.length} chars: ${head}]`;
  }
  return stub;
}

export interface EmergencyApplyResult {
  /** toolCallId → stub record (caller persists into CmState). */
  stubs: Record<string, EmergencyStubRecord>;
  /** Entries actually flushed + stubbed this run. */
  offloaded: number;
  /** In-context chars freed once the stubs are applied. */
  charsSaved: number;
  /** Entries whose flush failed — left untouched (never stub without flush). */
  skipped: number;
}

/**
 * Execute a plan: for each item, ensure the lossless JSON flush exists
 * (write when missing; skip the write when the file already exists), then
 * produce the stub record. A flush write that THROWS is counted as skipped
 * and the entry is left unstubbed (never stub without a verified flush).
 * Pure with respect to the messages array — substitution happens per-request
 * in the `context` handler via applyEmergencyStubs().
 */
export function applyContextEmergencyOffloads(
  messages: AgentMessage[],
  plan: EmergencyOffloadPlanItem[],
  io: EmergencyOffloadIo,
  deps: { sessionId: string },
): EmergencyApplyResult {
  const result: EmergencyApplyResult = { stubs: {}, offloaded: 0, charsSaved: 0, skipped: 0 };
  if (plan.length === 0) return result;

  for (const item of plan) {
    const msg = messages[item.index] as
      | {
          role?: string;
          toolCallId?: string;
          toolName?: string;
          content?: unknown;
        }
      | undefined;
    if (!msg || msg.role !== "toolResult") continue;

    const path = io.flushPath(deps.sessionId, item.toolCallId, item.toolName);
    try {
      if (!io.exists(path)) {
        io.flush(path, JSON.stringify(msg.content ?? []));
      }
    } catch {
      result.skipped++;
      continue; // NEVER stub without a verified flush.
    }

    const iso = io.nowIso();
    // Inline hint: first text block's text, when the content is text-only.
    let inline: string | undefined;
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const first = msg.content[0] as { type?: string; text?: unknown } | undefined;
      if (first?.type === "text" && typeof first.text === "string") inline = first.text;
    }
    const stub = buildEmergencyStub(item.toolName, item.chars, iso, path, inline);
    result.stubs[item.toolCallId] = { stub, chars: item.chars, iso, path };
    result.offloaded++;
    result.charsSaved += item.chars;
  }
  return result;
}

/**
 * Per-request substitution: replace the content of every toolResult whose
 * toolCallId has a stub record. Pure: input array never mutated; a new array
 * is returned only when at least one entry was substituted. Already-stubbed
 * entries are left alone (idempotence — double substitution is a no-op).
 */
export function applyEmergencyStubs(
  messages: AgentMessage[],
  stubs: Record<string, EmergencyStubRecord>,
): AgentMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    const msg = m as { role?: string; toolCallId?: string; content?: unknown };
    if (msg?.role !== "toolResult") return m;
    if (isStubbed(msg)) return m;
    const rec = stubs[String(msg.toolCallId ?? "")];
    if (!rec) return m;
    changed = true;
    // Preserve ALL original ToolResultMessage fields (toolCallId pairing,
    // isError, timestamp, details) — only the content body becomes the stub.
    return {
      ...(msg as unknown as Record<string, unknown>),
      content: [{ type: "text" as const, text: rec.stub }],
    } as AgentMessage;
  });
  return changed ? out : (messages as AgentMessage[]);
}

// Telemetry (owner metric rule: every innovation needs a counter)

export interface EmergencyOffloaderHealth {
  /** Emergency runs that actually stubbed at least one entry. */
  totalRuns: number;
  /** Lifetime count of emergency-stubbed tool results. */
  totalOffloaded: number;
  /** In-context chars freed across all runs. */
  totalCharsSaved: number;
  /** Runs that failed (flush error, missing session) — context untouched. */
  totalErrors: number;
}

const emergencyHealth: EmergencyOffloaderHealth = {
  totalRuns: 0,
  totalOffloaded: 0,
  totalCharsSaved: 0,
  totalErrors: 0,
};

export function getEmergencyOffloaderHealth(): EmergencyOffloaderHealth {
  return emergencyHealth;
}

/** Reset all emergency counters. Used by tests. */
export function resetEmergencyOffloaderHealth(): void {
  emergencyHealth.totalRuns = 0;
  emergencyHealth.totalOffloaded = 0;
  emergencyHealth.totalCharsSaved = 0;
  emergencyHealth.totalErrors = 0;
}

// Runner (published to the process-global slot)

const defaultIo: EmergencyOffloadIo = {
  nowIso: () => new Date().toISOString(),
  exists: (path) => existsSync(path),
  flush: (path, contentJson) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contentJson, "utf-8");
  },
  flushPath: (sessionId, toolCallId, toolName) =>
    getOffloadFilePath(sessionId, toolCallId, toolName),
};

/** The published runner signature (see global-state.ts). */
export async function runContextEmergencyOffload(
  ctx: unknown,
  reason: string,
): Promise<ContextEmergencyOffloadResult> {
  try {
    const cfg = getContextEmergencyOffloadConfig();
    if (!cfg.enabled) {
      return { offloaded: 0, charsSaved: 0, error: "disabled" };
    }
    const sm = (ctx as { sessionManager?: any })?.sessionManager;
    if (!sm || typeof sm.getBranch !== "function") {
      emergencyHealth.totalErrors++;
      return { offloaded: 0, charsSaved: 0, error: "no sessionManager" };
    }

    // Extract the live branch messages (append-only source of truth).
    const branch = sm.getBranch() as Array<{ type?: string; message?: unknown }>;
    const messages: AgentMessage[] = [];
    for (const entry of branch) {
      if (entry?.type === "message" && entry.message) {
        messages.push(entry.message as AgentMessage);
      }
    }

    const { plan } = planContextEmergencyOffloads(messages, cfg);
    if (plan.length === 0) return { offloaded: 0, charsSaved: 0 };

    const cmState = getCmState(ctx as never);
    if (!cmState.emergencyStubsByToolCallId) cmState.emergencyStubsByToolCallId = {};
    const stubs = cmState.emergencyStubsByToolCallId as Record<string, EmergencyStubRecord>;

    // Idempotence: candidates whose stub is already recorded are excluded —
    // a second run (same 413, retry path) flushes nothing new and never
    // rewrites an existing stub (byte-stability across LLM calls).
    const fresh = plan.filter((p) => !stubs[p.toolCallId]);
    if (fresh.length === 0) return { offloaded: 0, charsSaved: 0 };

    const sessionId = (sm as { getSessionId?: () => string }).getSessionId?.() ?? "anonymous";

    const applied = applyContextEmergencyOffloads(messages, fresh, defaultIo, { sessionId });
    if (applied.offloaded === 0) {
      return { offloaded: 0, charsSaved: 0, error: "flush failed" };
    }

    // Persist stubs (idempotent: existing records are never overwritten —
    // the stub stays byte-identical across LLM calls).
    for (const [id, rec] of Object.entries(applied.stubs)) {
      if (!stubs[id]) stubs[id] = rec;
    }

    emergencyHealth.totalRuns++;
    emergencyHealth.totalOffloaded += applied.offloaded;
    emergencyHealth.totalCharsSaved += applied.charsSaved;
    log.info(
      `[context-emergency] (${reason}) offloaded ${applied.offloaded} oversized ` +
        `toolResult(s): ${applied.charsSaved} in-context chars freed. ` +
        `Full content flushed to ${OFFLOAD_DIR}. The next LLM call sends stubs.`,
    );
    return { offloaded: applied.offloaded, charsSaved: applied.charsSaved };
  } catch (err) {
    emergencyHealth.totalErrors++;
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[context-emergency] (${reason}) failed - context untouched: ${message}`);
    return { offloaded: 0, charsSaved: 0, error: message };
  }
}

/**
 * Publish the runner into the process-global slot AND register the
 * per-request `context` handler that applies recorded stubs. The handler is
 * a pure substitution pass driven by CmState.emergencyStubsByToolCallId —
 * it runs on every LLM call but is a no-op (returns undefined) until an
 * emergency run records stubs. Never throws into pi's event pipeline.
 */
export function registerContextEmergencyOffloader(pi: ExtensionAPI): void {
  setContextEmergencyOffloadRunner(runContextEmergencyOffload);

  pi.on("context", async (event: any, ctx: any) => {
    try {
      const cmState = getCmState(ctx);
      const stubs = cmState.emergencyStubsByToolCallId as
        | Record<string, EmergencyStubRecord>
        | undefined;
      if (!stubs || Object.keys(stubs).length === 0) return undefined; // no emergency this session
      const messages = applyEmergencyStubs(event.messages as AgentMessage[], stubs);
      if (messages === event.messages) return undefined;
      log.debug(
        `[context-emergency] applied ${Object.keys(stubs).length} recorded stub(s) to the per-request context`,
      );
      return { messages };
    } catch (err) {
      log.warn("[context-emergency] stub application failed - context untouched", err);
      return undefined;
    }
  });
}
