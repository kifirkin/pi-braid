// Stale toolResult offloader.
//
// Setting-gated (braid.context.staleToolResultOffload, default OFF), fully
// deterministic (char-count + age, no LLM) offloader for stale large
// toolResults: the full original text is flushed losslessly to disk BEFORE any
// substitution, and the per-request context carries a stub pointing at the
// flush file. Recovery = read the file.
//
// Mechanism: registered as a `context` event handler — pi-core's
// transformContext path. The installed pi-core applies a handler's returned
// { messages } once per LLM call, BEFORE convertToLlm (emitContext
// structuredClones the live session messages). The session file itself is
// append-only and is never touched, so the offloader is lossless by
// construction and naturally idempotent (the substitution is recomputed from
// the append-only original on every call; the flush is guarded by file
// existence). This is NOT the disabled registerContextPruningHandler path
// (see index.ts NOTE): that handler's semantics (per-streaming compaction
// prep) are unrelated to a per-request substitution.
//
// Safety choices (v1): skip isError results, internal-tool results,
// bashExecution messages, and any result containing non-text (image) blocks.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getStaleToolResultOffloadConfig,
  type ResolvedStaleToolResultOffloadConfig,
} from "../../../../lib/config/braid-settings.js";
import { getOffloadFilePath } from "../../../../lib/config/braid-paths.js";
import { getCmState, isInternal, log } from "./shared.js";

/** Stub prefix — recognizable marker for already-offloaded entries. */
export const STALE_OFFLOAD_STUB_PREFIX = "[offloaded:";

/** One toolResult selected for offload in a single planning pass. */
export interface OffloadPlanItem {
  /** Position of the message in the context array. */
  index: number;
  toolCallId: string;
  toolName: string;
  /** Char count of the text that will be replaced by the stub. */
  chars: number;
}

/**
 * Deterministic planning pass over the per-request context. Pure char-count +
 * age logic: no LLM, no I/O. Age is measured in toolResult rank from the end
 * of the context (0 = most recent tool result), matching the repo's
 * tool-result volume/recency conventions.
 *
 * Eligibility (ALL required):
 *   - role === "toolResult", not isError, not already stubbed;
 *   - toolName not an internal braid tool (shared.ts INTERNAL_TOOLS);
 *   - content is all-text and non-empty;
 *   - chars >= minChars;
 *   - age >= stalenessTurns AND age >= keepRecentTurns (the keep-recent
 *     guard is a hard floor: recency always wins);
 *   - cumulative chars fit within maxOffloadCharsPerRun (oldest-first; a
 *     single item larger than the whole budget is never planned).
 *
 * Returns the plan oldest-first plus the count of already-stubbed entries
 * (idempotence signal for tests/telemetry).
 */
export function planStaleToolResultOffloads(
  messages: AgentMessage[],
  cfg: ResolvedStaleToolResultOffloadConfig,
): { plan: OffloadPlanItem[]; alreadyStubbed: number } {
  // Rank from end among tool results: one reverse pass.
  const ranks = new Map<number, number>();
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string } | undefined;
    if (msg?.role === "toolResult") {
      ranks.set(i, seen);
      seen++;
    }
  }

  const plan: OffloadPlanItem[] = [];
  let alreadyStubbed = 0;
  let budget = cfg.maxOffloadCharsPerRun;
  const minAge = Math.max(cfg.stalenessTurns, cfg.keepRecentTurns);
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
    if (isStubbed(msg.content)) {
      alreadyStubbed++;
      continue;
    }
    if (isInternal(String(msg.toolName ?? ""))) continue;
    const { text, hasNonText } = extractToolResultText(msg.content);
    if (hasNonText || text.length === 0) continue;
    if (text.length < cfg.minChars) continue;
    const age = ranks.get(i) ?? 0;
    if (age < minAge) continue;
    if (text.length > budget) continue; // bounded work: skip, keep scanning
    plan.push({
      index: i,
      toolCallId: String(msg.toolCallId ?? `idx-${i}`),
      toolName: String(msg.toolName ?? "unknown"),
      chars: text.length,
    });
    budget -= text.length;
  }
  return { plan, alreadyStubbed };
}

/** Extract concatenated text of a toolResult's text blocks ("" if none). */
function extractToolResultText(content: unknown): { text: string; hasNonText: boolean } {
  if (!Array.isArray(content)) return { text: "", hasNonText: false };
  let text = "";
  let hasNonText = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      text += b.text;
    } else if (b.type && b.type !== "text") {
      hasNonText = true;
    }
  }
  return { text, hasNonText };
}

function isStubbed(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  const first = content[0] as { type?: string; text?: unknown } | undefined;
  return (
    first?.type === "text" &&
    typeof first.text === "string" &&
    first.text.startsWith(STALE_OFFLOAD_STUB_PREFIX)
  );
}

export interface OffloadIo {
  nowIso(): string;
  exists(path: string): boolean;
  /** mkdir -p + write the full original text. Throws on failure. */
  flush(path: string, text: string): void;
  flushPath(sessionId: string, toolCallId: string, toolName: string): string;
}

export interface OffloadApplyDeps {
  sessionId: string;
  /** toolCallId → ISO timestamp of the first flush (stub stability across calls). */
  isoByToolCallId?: Record<string, string>;
}

export interface OffloadApplyResult {
  /** New message array (same reference when nothing changed). */
  messages: AgentMessage[];
  /** Entries actually stubbed this run. */
  offloaded: number;
  /** Gross in-context chars freed by stubbing. */
  charsSaved: number;
  /** Stub overhead added to the context. */
  stubChars: number;
  /** Bytes actually written to disk this run (0 when flushes were deduped). */
  bytesFlushed: number;
  /** Entries whose flush failed — left untouched (never stub without flush). */
  skipped: number;
}

/**
 * Apply a plan: for each item, ensure the lossless flush exists (write when
 * missing; skip the write when the file already exists — idempotent), then
 * replace the in-context body with the stub. A flush write that THROWS is
 * counted as skipped and the item is left untouched (never stub without a
 * verified flush). Double-offload is a no-op: the plan excludes stubbed
 * entries, and the flush is exists-guarded. The input array is never mutated;
 * a new array is returned only when at least one entry was stubbed.
 */
export function applyStaleToolResultOffloads(
  messages: AgentMessage[],
  plan: OffloadPlanItem[],
  io: OffloadIo,
  deps: OffloadApplyDeps,
): OffloadApplyResult {
  const result: OffloadApplyResult = {
    messages,
    offloaded: 0,
    charsSaved: 0,
    stubChars: 0,
    bytesFlushed: 0,
    skipped: 0,
  };
  if (plan.length === 0) return result;

  const output = [...messages];
  for (const item of plan) {
    const msg = output[item.index] as {
      role?: string;
      toolCallId?: string;
      toolName?: string;
      content?: unknown;
    };
    if (!msg || msg.role !== "toolResult") continue;
    const { text } = extractToolResultText(msg.content);
    if (text.length === 0) continue;

    const path = io.flushPath(deps.sessionId, item.toolCallId, item.toolName);
    let written = 0;
    try {
      if (!io.exists(path)) {
        io.flush(path, text);
        written = Buffer.byteLength(text, "utf-8");
      }
    } catch {
      result.skipped++;
      continue; // NEVER stub without a verified flush.
    }

    const iso = (deps.isoByToolCallId && deps.isoByToolCallId[item.toolCallId]) || io.nowIso();
    const stub = `[offloaded: ${item.toolName} result, ${item.chars} chars, ${iso} — full text: ${path}]`;
    // Preserve ALL original ToolResultMessage fields (toolCallId pairing,
    // isError, timestamp, details) — only the content body becomes the stub.
    output[item.index] = {
      ...(msg as unknown as Record<string, unknown>),
      content: [{ type: "text" as const, text: stub }],
    } as AgentMessage;
    result.offloaded++;
    result.charsSaved += item.chars;
    result.stubChars += stub.length;
    result.bytesFlushed += written;
    if (deps.isoByToolCallId && !deps.isoByToolCallId[item.toolCallId]) {
      deps.isoByToolCallId[item.toolCallId] = iso;
    }
  }
  result.messages = result.offloaded > 0 ? output : messages;
  return result;
}

// Telemetry (owner metric rule: every innovation needs a counter)

export interface OffloaderHealth {
  /** Runs (LLM calls) that actually offloaded at least one entry. */
  totalRuns: number;
  /** Lifetime count of stubbed tool results. */
  totalOffloaded: number;
  /** Gross in-context chars freed across all runs. */
  totalCharsSaved: number;
  /** Stub overhead added across runs. */
  totalStubChars: number;
  /** Bytes written to flush files across runs. */
  totalBytesFlushed: number;
}

const offloaderHealth: OffloaderHealth = {
  totalRuns: 0,
  totalOffloaded: 0,
  totalCharsSaved: 0,
  totalStubChars: 0,
  totalBytesFlushed: 0,
};

export function getOffloaderHealth(): OffloaderHealth {
  return offloaderHealth;
}

const defaultIo: OffloadIo = {
  nowIso: () => new Date().toISOString(),
  exists: (path) => existsSync(path),
  flush: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf-8");
  },
  flushPath: (sessionId, toolCallId, toolName) =>
    getOffloadFilePath(sessionId, toolCallId, toolName),
};

/**
 * Register the stale-toolResult offloader on the `context` event
 * (transformContext path). Reads the setting FRESH on every call; when the
 * setting is OFF (the default) the handler returns undefined immediately —
 * provably zero behavior change. Never throws into pi's event pipeline.
 */
export function registerStaleToolResultOffloader(pi: ExtensionAPI): void {
  pi.on("context", async (event: any, ctx: any) => {
    let cfg: ResolvedStaleToolResultOffloadConfig;
    try {
      cfg = getStaleToolResultOffloadConfig();
    } catch {
      return undefined;
    }
    if (!cfg.enabled) return undefined; // default-off fast path: no-op
    try {
      const { plan } = planStaleToolResultOffloads(event.messages as AgentMessage[], cfg);
      if (plan.length === 0) return undefined;

      const cmState = getCmState(ctx);
      if (!cmState.offloadIsoByToolCallId) cmState.offloadIsoByToolCallId = {};
      const sessionId =
        (
          ctx as { sessionManager?: { getSessionId?: () => string } }
        )?.sessionManager?.getSessionId?.() ?? "anonymous";

      const result = applyStaleToolResultOffloads(event.messages, plan, defaultIo, {
        sessionId,
        isoByToolCallId: cmState.offloadIsoByToolCallId,
      });
      if (result.offloaded === 0) return undefined;

      // Telemetry: lifetime counters + per-run log line.
      offloaderHealth.totalRuns++;
      offloaderHealth.totalOffloaded += result.offloaded;
      offloaderHealth.totalCharsSaved += result.charsSaved;
      offloaderHealth.totalStubChars += result.stubChars;
      offloaderHealth.totalBytesFlushed += result.bytesFlushed;
      log.info(
        `[offload] ${result.offloaded} stale toolResult(s) offloaded: ` +
          `${result.charsSaved} in-context chars freed ` +
          `(stub overhead ${result.stubChars}), ${result.bytesFlushed} bytes flushed to disk`,
      );
      return { messages: result.messages };
    } catch (err) {
      log.warn("[offload] stale toolResult offload failed - context untouched", err);
      return undefined;
    }
  });
}
