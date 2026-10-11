// presend-guard.ts — pre-send payload guard.
//
// Oversized toolResults (screenshot/base64-class
// payloads) can make every provider request physically un-sendable, and the
// agent-loop retry keeps re-sending the SAME oversized body — burning quota.
// This guard runs at the LAST seam before the HTTP call
// (before_provider_request): it estimates the outgoing payload (chars/4
// token heuristic) against the model's catalog context window; when the
// request is DOOMED (estimated tokens > 90% of the window), the largest
// oversized strings (>256KB — base64 blobs, dumped file contents) are
// flushed to disk losslessly and replaced with stubs IN THE REQUEST BODY.
//
// Seam note: the runner-level shrink (core's context-emergency offloader,
// keyed by toolCallId, session-persistent) cannot act here — providers is a
// standalone package (no pi-core import, deliberate architecture). This
// guard is request-local: the session entry keeps the original content, so
// the shrink is lossless by construction and the NEXT request recomputes it.
//
// Honest failure mode: a `before_provider_request` handler CANNOT cancel a
// send (pi-core applies only the returned payload; a thrown handler error is
// logged by the runner and the unmodified payload is sent anyway). So when
// the shrink cannot get under the limit, the guard logs an explicit ERROR
// (honest fail-fast signal) and returns the maximally shrunk payload — the
// provider remains the final arbiter, and llm-call's emergency retry
// owns the aftermath.
//
// Setting: braid.context.presendGuard { enabled } — default ON (read fresh
// per request from the same settings.json the ring fallback reads). Only
// models known to the providers catalog (venice-catalog.ts) are guarded:
// an unknown model's context window is unknown, and guessing it would either
// no-op or shrink legitimate large-window requests.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { providerLog } from "./log";

/** Scope for providerLog lines from this guard. */
const SCOPE = "providers/presend-guard";

/** Default ON — a doomed send is exactly what burned the quota. */
const PRESGUARD_DEFAULT_ENABLED = true;

/** Strings above this size are stub-worthy (a base64-class blob). */
const SHRINK_MIN_CHARS = 262_144; // 256KB, mirrors core's capture cap

/** Headroom against the model context window (token estimate). */
const CONTEXT_HEADROOM = 0.9;

/** chars → tokens heuristic (conservative for English/code prose). */
const CHARS_PER_TOKEN = 4;

/** Canonical offload dir (core's braid-paths OFFLOAD_DIR; seam-duplicated). */
function presendOffloadDir(): string {
  return join(homedir(), ".pi", "agent", "braid", "offload", "presend");
}

/** Read braid.context.presendGuard.enabled fresh from settings.json. */
export function isPresendGuardEnabled(settingsPath?: string): boolean {
  try {
    const p = settingsPath ?? join(homedir(), ".pi", "agent", "settings.json");
    if (!existsSync(p)) return PRESGUARD_DEFAULT_ENABLED;
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const enabled = raw?.braid?.context?.presendGuard?.enabled;
    return typeof enabled === "boolean" ? enabled : PRESGUARD_DEFAULT_ENABLED;
  } catch {
    return PRESGUARD_DEFAULT_ENABLED;
  }
}

/**
 * Estimate the char size of one message content (string or block array).
 * Text blocks count their text; image_url blocks count their URL string
 * (base64 data URLs dominate real 413 bodies); unknown shapes fall back to
 * their JSON length.
 */
export function estimateMessageContentChars(content: unknown): number {
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
    const b = block as {
      type?: string;
      text?: unknown;
      image_url?: { url?: unknown };
      data?: unknown;
    };
    if (b.type === "text" && typeof b.text === "string") total += b.text.length;
    else if (b.type === "image_url" && typeof b.image_url?.url === "string")
      total += b.image_url.url.length;
    else if (b.type === "image" && typeof b.data === "string")
      total += b.data.length;
    else if (b.type != null) {
      try {
        total += JSON.stringify(block).length;
      } catch {
        /* unserializable block — ignore */
      }
    }
  }
  return total;
}

/** Estimate the whole payload's char size (messages array; JSON fallback). */
export function estimatePayloadChars(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const messages = (payload as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) {
    try {
      return JSON.stringify(payload).length;
    } catch {
      return 0;
    }
  }
  let total = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    total += estimateMessageContentChars(
      (msg as Record<string, unknown>).content,
    );
  }
  return total;
}

/** Build the stub text for one shrunk string (brief format, ~500 char head). */
export function buildPresendStub(
  label: string,
  bytes: number,
  path: string,
  text: string,
): string {
  let stub = `[offloaded: ${label} result, ${bytes} bytes — flushed to disk: ${path}]`;
  const head = text.slice(0, 500);
  if (head) stub += `\n[first ${head.length} chars: ${head}]`;
  return stub;
}

/** One oversized string found in a request message. */
interface OversizedString {
  messageIndex: number;
  blockIndex: number; // -1 → the whole content is this string
  text: string;
  kind: "text" | "image-url";
}

function collectOversizedStrings(messages: unknown[]): OversizedString[] {
  const found: OversizedString[] = [];
  messages.forEach((msg, messageIndex) => {
    if (!msg || typeof msg !== "object") return;
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === "string") {
      if (
        content.length >= SHRINK_MIN_CHARS &&
        !content.startsWith("[offloaded:")
      ) {
        found.push({
          messageIndex,
          blockIndex: -1,
          text: content,
          kind: "text",
        });
      }
    } else if (Array.isArray(content)) {
      (content as unknown[]).forEach((block, blockIndex) => {
        if (!block || typeof block !== "object") return;
        const b = block as {
          type?: string;
          text?: unknown;
          image_url?: { url?: unknown };
        };
        if (
          b.type === "text" &&
          typeof b.text === "string" &&
          b.text.length >= SHRINK_MIN_CHARS
        ) {
          found.push({ messageIndex, blockIndex, text: b.text, kind: "text" });
        } else if (
          b.type === "image_url" &&
          typeof b.image_url?.url === "string" &&
          b.image_url.url.length >= SHRINK_MIN_CHARS
        ) {
          found.push({
            messageIndex,
            blockIndex,
            text: b.image_url.url,
            kind: "image-url",
          });
        }
      });
    }
  });
  found.sort((a, b) => b.text.length - a.text.length);
  return found;
}

/** Apply one stub to a cloned message at (messageIndex, blockIndex). */
function stubMessage(
  messages: unknown[],
  cand: OversizedString,
  stub: string,
): void {
  const original = messages[cand.messageIndex] as
    | Record<string, unknown>
    | undefined;
  if (!original || typeof original !== "object") return;
  if (cand.blockIndex === -1) {
    messages[cand.messageIndex] = { ...original, content: stub };
    return;
  }
  const content = original.content;
  if (!Array.isArray(content)) return;
  const blocks = [...(content as unknown[])];
  const block = blocks[cand.blockIndex];
  if (!block || typeof block !== "object") return;
  // A base64 image block is REPLACED (type + body change); a text block keeps
  // its other fields (toolCallId-adjacent metadata never rides on blocks).
  blocks[cand.blockIndex] =
    cand.kind === "text"
      ? { ...(block as object), text: stub }
      : { type: "text", text: stub };
  messages[cand.messageIndex] = { ...original, content: blocks };
}

export interface PresendGuardResult {
  /** Modified payload (undefined → caller sends the original). */
  payload?: unknown;
  /** Strings flushed + stubbed (0 when the guard no-opped). */
  shrunk: number;
  /** True when the estimate was over budget BEFORE the guard ran. */
  wasDoomed: boolean;
  /** True when the shrunk payload is STILL over budget (honest error logged). */
  stillOver: boolean;
  /** Human-readable reason for a no-op (diagnostics/tests). */
  reason?: string;
}

/**
 * Guard over one provider payload. `resolveContextWindow` maps the request's
 * model id to its catalog context window; unknown models no-op (only shrink
 * when the window is KNOWN — guessing would shrink legitimate large-window
 * requests). Flush failure on one string leaves that string untouched (never
 * stub without a verified flush); other candidates still shrink. The input
 * payload object is never mutated — a shallow clone with a new messages
 * array is returned when something shrank.
 */
export function shrinkDoomedPayload(
  payload: unknown,
  deps: {
    resolveContextWindow(modelId: string): number | undefined;
    flush?: (path: string, text: string) => void;
    clock?: () => number;
  },
): PresendGuardResult {
  if (!payload || typeof payload !== "object") {
    return {
      wasDoomed: false,
      stillOver: false,
      shrunk: 0,
      reason: "payload not an object",
    };
  }
  const rec = payload as Record<string, unknown>;
  const modelId = typeof rec.model === "string" ? rec.model : undefined;
  if (!modelId)
    return {
      wasDoomed: false,
      stillOver: false,
      shrunk: 0,
      reason: "no model id",
    };
  const contextWindow = deps.resolveContextWindow(modelId);
  if (!contextWindow || contextWindow <= 0) {
    return {
      wasDoomed: false,
      stillOver: false,
      shrunk: 0,
      reason: `unknown context window for ${modelId}`,
    };
  }
  const messages = rec.messages;
  if (!Array.isArray(messages)) {
    return {
      wasDoomed: false,
      stillOver: false,
      shrunk: 0,
      reason: "no messages array",
    };
  }

  const estChars = estimatePayloadChars(payload);
  const estTokens = Math.ceil(estChars / CHARS_PER_TOKEN);
  const budgetTokens = Math.floor(contextWindow * CONTEXT_HEADROOM);
  if (estTokens <= budgetTokens) {
    return {
      wasDoomed: false,
      stillOver: false,
      shrunk: 0,
      reason: `estimate ${estTokens}t <= budget ${budgetTokens}t`,
    };
  }

  // Doomed: stub the largest oversized strings until under budget
  const clock = deps.clock ?? (() => Date.now());
  const flush =
    deps.flush ??
    ((path: string, text: string) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text, "utf-8");
    });

  const candidates = collectOversizedStrings(messages as unknown[]);
  if (candidates.length === 0) {
    return {
      wasDoomed: true,
      stillOver: true,
      shrunk: 0,
      reason: `doomed (${estTokens}t > budget ${budgetTokens}t) but nothing oversized to stub`,
    };
  }

  const stamp = clock().toString(36);
  const modelSlug = modelId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const offloadDir = presendOffloadDir();
  const newMessages = [...(messages as unknown[])];
  let tokens = estTokens;
  let shrunk = 0;
  let flushedBytes = 0;

  for (const cand of candidates) {
    if (tokens <= budgetTokens) break;
    const path = join(offloadDir, `${stamp}-${shrunk}-${modelSlug}.txt`);
    try {
      if (!existsSync(path)) flush(path, cand.text);
    } catch {
      continue; // never stub without a verified flush
    }
    const bytes = Buffer.byteLength(cand.text, "utf-8");
    const stub = buildPresendStub(cand.kind, bytes, path, cand.text);
    stubMessage(newMessages, cand, stub);
    tokens -= Math.ceil((cand.text.length - stub.length) / CHARS_PER_TOKEN);
    shrunk++;
    flushedBytes += bytes;
  }

  const stillOver = tokens > budgetTokens;
  if (shrunk > 0) {
    providerLog(
      "info",
      SCOPE,
      `payload was over budget (${estTokens}t > ${budgetTokens}t for ${modelId}): ` +
        `stubbed ${shrunk} oversized string(s), ${flushedBytes} bytes flushed to disk; ` +
        `new estimate ~${tokens}t`,
    );
  }
  if (stillOver) {
    providerLog(
      "error",
      SCOPE,
      `payload for ${modelId} is STILL over budget after shrink (~${tokens}t > ` +
        `${budgetTokens}t) — sending anyway (handler cannot cancel a send); ` +
        `llm-call's emergency retry owns the aftermath`,
    );
  }
  if (shrunk === 0) return { wasDoomed: true, stillOver, shrunk: 0 };
  return {
    payload: { ...rec, messages: newMessages },
    shrunk,
    wasDoomed: true,
    stillOver,
  };
}
