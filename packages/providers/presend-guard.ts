// presend-guard.ts — pre-send payload guard.
//
// Oversized toolResults (screenshot/base64-class
// payloads) can make every provider request physically un-sendable, and the
// agent-loop retry keeps re-sending the SAME oversized body — burning quota.
// This guard runs at the LAST seam before the HTTP call
// (before_provider_request): it estimates the outgoing payload (chars/4
// token heuristic) against the model's catalog context window, and its BYTES
// against a cap the operator declared; a request DOOMED on either budget has
// its largest oversized strings (>256KB — base64 blobs, dumped file contents)
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
// Settings: braid.context.presendGuard { enabled, maxRequestBytes,
// reportBytesAbove }, read fresh per request from the same settings.json the
// ring fallback reads. Only models known to the providers catalog
// (venice-catalog.ts) are guarded: an unknown model's context window is
// unknown, and guessing it would either no-op or shrink legitimate requests.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { providerLog } from "./log";
import { braidDataRoot } from "./state-paths";

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

/** Presend flush root: the `presend/` subdirectory of the same offload root
 *  core writes into (core's getOffloadFilePath resolves `braidDir()/offload`),
 *  so a pinned BRAID_HOME moves both roots together and an unpinned process
 *  resolves the directory it always did. `null` when no absolute braid data
 *  root can be resolved: the caller then skips the flush rather than writing
 *  one beside the cwd. */
function presendOffloadDir(): string | null {
  const root = braidDataRoot();
  return root === null ? null : join(root, "offload", "presend");
}

/** Warned once per process: a request loop must not repeat this line. */
let warnedNoFlushRoot = false;

/** The refusal a missing (non-absolute) braid data root produces. */
function warnNoFlushRoot(): void {
  if (warnedNoFlushRoot) return;
  warnedNoFlushRoot = true;
  providerLog(
    "warn",
    SCOPE,
    "BRAID_HOME is unset and no absolute home resolves: the presend flush root " +
      "is underivable, so this payload was not flushed (writing it would land " +
      "beside the cwd). Set BRAID_HOME to an absolute directory to restore " +
      "the lossless flush.",
  );
}

/** Read the presend guard's policy fresh from settings.json. */
export function readPresendPolicy(settingsPath?: string): PresendPolicy {
  try {
    const p = settingsPath ?? join(homedir(), ".pi", "agent", "settings.json");
    if (!existsSync(p)) return PRESEND_POLICY_DEFAULT;
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const enabled = raw?.braid?.context?.presendGuard?.enabled;
    // `enabled` stays a direct read of the published expression: the generated
    // settings schema cites that exact text as this key's source, so the block
    // is cloned beside it rather than replacing it
    // (packages/core/scripts/gen-braid-schema.mjs resolves evidence, not a
    // line).
    const block = (raw?.braid?.context?.presendGuard ?? {}) as Record<
      string,
      unknown
    >;
    return {
      enabled:
        typeof enabled === "boolean" ? enabled : PRESGUARD_DEFAULT_ENABLED,
      maxRequestBytes: positiveNumber(block.maxRequestBytes),
      reportBytesAbove: nonNegativeNumber(
        block.reportBytesAbove,
        REPORT_BYTES_ABOVE_DEFAULT,
      ),
    };
  } catch {
    return PRESEND_POLICY_DEFAULT;
  }
}

/** Read braid.context.presendGuard.enabled fresh from settings.json. */
export function isPresendGuardEnabled(settingsPath?: string): boolean {
  return readPresendPolicy(settingsPath).enabled;
}

/** Report a request's byte count above this size; `0` disables the line. */
export const REPORT_BYTES_ABOVE_DEFAULT = 2_000_000;

/** One settings consultation's answer: the switch, the declared cap, and the
 *  report threshold. `maxRequestBytes` absent means the operator declared no
 *  cap, so the byte arm stays out of the way. */
export interface PresendPolicy {
  enabled: boolean;
  maxRequestBytes?: number;
  reportBytesAbove: number;
}

/** Everything unset: the guard is ON, no byte cap, the default report line. */
const PRESEND_POLICY_DEFAULT: PresendPolicy = {
  enabled: PRESGUARD_DEFAULT_ENABLED,
  reportBytesAbove: REPORT_BYTES_ABOVE_DEFAULT,
};

/** A declared size, kept only when it is a positive finite number. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** A size that may legitimately be zero (the off switch); otherwise `fallback`. */
function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/** One catalog model's id/window pair, as the catalog declares them. */
export interface CatalogWindowEntry {
  id?: unknown;
  contextWindow?: unknown;
}

/** The guard's window lookup over one catalog. */
export interface ContextWindowIndex {
  resolve(modelId: string): number | undefined;
}

/**
 * Normalized form of a model id: lowercase, dots → dashes.
 *
 * A route may spell a catalog id with dots (`deepseek-v4.1-flash`) while the
 * catalog spells it with dashes (`deepseek-v4-1-flash`); it is the same model
 * with the same window, so the join has to survive the spelling.
 */
export function normalizeModelId(modelId: string): string {
  return modelId.toLowerCase().replace(/\./g, "-");
}

/**
 * Build the model-id → context-window index from one catalog: the exact id
 * (unchanged), plus a normalized key for every catalog id. A dot-form request
 * id resolves into the normalized key of the dash-form catalog id it names.
 *
 * Ambiguity rule: when two catalog models share a normalized key but declare
 * different windows, neither is added to the normalized index. Resolving a
 * collision by picking one would shrink requests for a large-window model
 * against a small window's budget — worse than not shrinking. Exact ids keep
 * resolving, including the two that collided, so a precise spelling is never
 * lost. Lookup order is exact, then normalized; an id neither index knows
 * stays `undefined` and the caller's guard no-ops.
 */
export function buildContextWindowIndex(
  models: readonly CatalogWindowEntry[],
): ContextWindowIndex {
  const exact = new Map<string, number>();
  for (const model of models) {
    const id = model?.id;
    const window = model?.contextWindow;
    if (typeof id !== "string" || id === "") continue;
    if (typeof window !== "number" || !Number.isFinite(window) || window <= 0)
      continue;
    exact.set(id, window);
  }
  const normalized = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const [id, window] of exact) {
    const key = normalizeModelId(id);
    // Another catalog id is spelled exactly like this key (a dash id, when the
    // id itself is already normalized): the two windows would answer the same
    // lookup. `owner` is this id's own window when the id is its own key.
    const owner = exact.get(key);
    if (owner !== undefined && owner !== window) {
      ambiguous.add(key);
      continue;
    }
    const prior = normalized.get(key);
    if (prior !== undefined && prior !== window) {
      ambiguous.add(key);
      continue;
    }
    // Every id gets a normalized entry, including one already in normalized
    // form: that identity entry is what a dot-form request id resolves into.
    normalized.set(key, window);
  }
  for (const key of ambiguous) normalized.delete(key);
  return {
    resolve(modelId: string): number | undefined {
      return exact.get(modelId) ?? normalized.get(normalizeModelId(modelId));
    },
  };
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

/** The byte arm: a 413 measures SERIALIZED BYTES, so a body far inside the
 *  token budget can still be refused, and the token arm can never fire for it.
 *  It acts only against a cap the operator declared — inventing a byte number
 *  would shrink legitimate large-window requests, a worse failure than a loud
 *  413. Below this share of the cap the char estimate is trusted: a char is
 *  one UTF-16 unit while the UTF-8 byte count of the same text is at least as
 *  large, so the estimate is a lower bound and no serialization is spent. */
const BYTE_MEASURE_FRACTION = 0.6;

/** Byte-arm candidate floor. The token arm's 256KB floor leaves every mid-size
 *  tool result in place, and a megabyte of 20-100KB results is exactly the
 *  body a transport refuses. */
const BYTE_SHRINK_MIN_CHARS = 8_192;

/** A payload's size on the wire, and whether it was serialized to find it. */
interface PayloadSize {
  bytes: number;
  measured: boolean;
}

/** Measure a payload in bytes. Above `exactAbove` the payload is serialized
 *  once and its UTF-8 JSON length used; below it the char estimate stands as a
 *  lower bound and no serialization is spent. */
function measurePayloadBytes(
  payload: unknown,
  estChars: number,
  exactAbove: number,
): PayloadSize {
  if (!(estChars > exactAbove)) return { bytes: estChars, measured: false };
  try {
    const json = JSON.stringify(payload);
    if (typeof json !== "string") return { bytes: estChars, measured: false };
    return { bytes: Buffer.byteLength(json, "utf8"), measured: true };
  } catch {
    return { bytes: estChars, measured: false };
  }
}

/** The single line a request above the report threshold writes. */
function reportPayloadBytes(
  modelId: string | undefined,
  size: PayloadSize,
  cap: number | undefined,
  reportAbove: number,
): void {
  providerLog(
    "warn",
    SCOPE,
    `request payload is ${size.bytes} bytes for ${modelId ?? "(no model id)"} ` +
      `(${size.measured ? "measured as UTF-8 JSON" : "char estimate, a lower bound"}), ` +
      `above the ${reportAbove}-byte report threshold; ` +
      (cap === undefined
        ? "no byte cap is declared (braid.context.presendGuard, field maxRequestBytes)"
        : `declared cap is ${cap} bytes`),
  );
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

/** Strings of at least `floorChars` in the messages, largest first. */
function collectOversizedStrings(
  messages: unknown[],
  floorChars: number,
): OversizedString[] {
  const found: OversizedString[] = [];
  messages.forEach((msg, messageIndex) => {
    if (!msg || typeof msg !== "object") return;
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === "string") {
      if (content.length >= floorChars && !content.startsWith("[offloaded:")) {
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
          b.text.length >= floorChars
        ) {
          found.push({ messageIndex, blockIndex, text: b.text, kind: "text" });
        } else if (
          b.type === "image_url" &&
          typeof b.image_url?.url === "string" &&
          b.image_url.url.length >= floorChars
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
  /** True when a budget was exceeded BEFORE the guard ran. */
  wasDoomed: boolean;
  /** True when the shrunk payload is STILL over a budget (honest error logged). */
  stillOver: boolean;
  /** Payload size in bytes after the guard ran: re-serialized when a byte cap
   *  was declared and something was stubbed, otherwise the estimate minus what
   *  the stubs freed. */
  bytes: number;
  /** True when `bytes` came from serializing the payload. */
  measured: boolean;
  /** Human-readable reason for a no-op (diagnostics/tests). */
  reason?: string;
}

/**
 * Guard over one provider payload. `resolveContextWindow` maps the request's
 * model id to its catalog context window; unknown models get no token arm
 * (only shrink when the window is KNOWN — guessing would shrink legitimate
 * large-window requests). `maxRequestBytes` is the operator's declared byte
 * cap: absent means no byte arm, and the payload path is then unchanged apart
 * from the report line. `reportBytesAbove` (default
 * `REPORT_BYTES_ABOVE_DEFAULT`, `0` disables) writes one warn line per request
 * above it, cap or no cap, and never alters the payload.
 *
 * Flush failure on one string leaves that string untouched (never stub without
 * a verified flush); other candidates still shrink. The input payload object is
 * never mutated — a shallow clone with a new messages array is returned when
 * something shrank.
 */
export function shrinkDoomedPayload(
  payload: unknown,
  deps: {
    resolveContextWindow(modelId: string): number | undefined;
    maxRequestBytes?: number;
    reportBytesAbove?: number;
    flush?: (path: string, text: string) => void;
    clock?: () => number;
  },
): PresendGuardResult {
  if (!payload || typeof payload !== "object") {
    return {
      wasDoomed: false,
      stillOver: false,
      shrunk: 0,
      bytes: 0,
      measured: false,
      reason: "payload not an object",
    };
  }
  const rec = payload as Record<string, unknown>;
  const modelId = typeof rec.model === "string" ? rec.model : undefined;

  // Size first: the report line must land even when the window lookup cannot
  // answer, which is the shape that hid the missing number behind a 413.
  const estChars = estimatePayloadChars(payload);
  const cap = positiveNumber(deps.maxRequestBytes);
  const reportAbove =
    deps.reportBytesAbove === undefined
      ? REPORT_BYTES_ABOVE_DEFAULT
      : nonNegativeNumber(deps.reportBytesAbove, REPORT_BYTES_ABOVE_DEFAULT);
  const exactAbove = Math.min(
    cap === undefined ? Number.POSITIVE_INFINITY : cap * BYTE_MEASURE_FRACTION,
    reportAbove > 0 ? reportAbove : Number.POSITIVE_INFINITY,
  );
  const size = measurePayloadBytes(payload, estChars, exactAbove);
  if (reportAbove > 0 && size.bytes > reportAbove) {
    reportPayloadBytes(modelId, size, cap, reportAbove);
  }

  if (!modelId)
    return {
      wasDoomed: false,
      stillOver: false,
      shrunk: 0,
      bytes: size.bytes,
      measured: size.measured,
      reason: "no model id",
    };
  const messages = rec.messages;
  if (!Array.isArray(messages)) {
    return {
      wasDoomed: false,
      stillOver: false,
      shrunk: 0,
      bytes: size.bytes,
      measured: size.measured,
      reason: "no messages array",
    };
  }

  const contextWindow = deps.resolveContextWindow(modelId);
  const tokenBudget =
    typeof contextWindow === "number" && contextWindow > 0
      ? Math.floor(contextWindow * CONTEXT_HEADROOM)
      : undefined;
  const estTokens = Math.ceil(estChars / CHARS_PER_TOKEN);
  let tokens = estTokens;
  let bytes = size.bytes;
  const tokenOver = tokenBudget !== undefined && tokens > tokenBudget;
  const byteOver = cap !== undefined && bytes > cap;
  if (!tokenOver && !byteOver) {
    return {
      wasDoomed: false,
      stillOver: false,
      shrunk: 0,
      bytes,
      measured: size.measured,
      reason:
        tokenBudget === undefined
          ? `unknown context window for ${modelId}`
          : `estimate ${estTokens}t <= budget ${tokenBudget}t`,
    };
  }

  // Doomed: stub the largest oversized strings of each exceeded budget.
  const clock = deps.clock ?? (() => Date.now());
  const flush =
    deps.flush ??
    ((path: string, text: string) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text, "utf-8");
    });
  const offloadDir = presendOffloadDir();
  if (offloadDir === null) {
    warnNoFlushRoot();
    return {
      wasDoomed: true,
      stillOver: true,
      shrunk: 0,
      bytes,
      measured: size.measured,
      reason: "no absolute braid data root to flush to",
    };
  }
  const stamp = clock().toString(36);
  const modelSlug = modelId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const newMessages = [...(messages as unknown[])];
  let shrunk = 0;
  let flushedBytes = 0;
  let sawCandidate = false;

  /** Stub candidates above `floorChars`, largest first, until `over()` clears. */
  const shrinkUntilUnder = (over: () => boolean, floorChars: number): void => {
    if (!over()) return;
    for (const cand of collectOversizedStrings(newMessages, floorChars)) {
      sawCandidate = true;
      if (!over()) break;
      const path = join(offloadDir, `${stamp}-${shrunk}-${modelSlug}.txt`);
      try {
        if (!existsSync(path)) flush(path, cand.text);
      } catch {
        continue; // never stub without a verified flush
      }
      const candBytes = Buffer.byteLength(cand.text, "utf-8");
      const stub = buildPresendStub(cand.kind, candBytes, path, cand.text);
      stubMessage(newMessages, cand, stub);
      tokens -= Math.ceil((cand.text.length - stub.length) / CHARS_PER_TOKEN);
      bytes -= Math.max(0, candBytes - Buffer.byteLength(stub, "utf-8"));
      shrunk++;
      flushedBytes += candBytes;
    }
  };

  // The byte arm runs first with its own floor: mid-size results are what add
  // up on the wire, and a token-arm stub of the same message may then be moot.
  shrinkUntilUnder(
    () => cap !== undefined && bytes > cap,
    BYTE_SHRINK_MIN_CHARS,
  );
  shrinkUntilUnder(
    () => tokenBudget !== undefined && tokens > tokenBudget,
    SHRINK_MIN_CHARS,
  );

  // With a declared cap the honest post-shrink number is the serialized one;
  // the per-string decrement above only drove the loop's progress check.
  let measured = size.measured;
  if (cap !== undefined && shrunk > 0) {
    try {
      const json = JSON.stringify({ ...rec, messages: newMessages });
      if (typeof json === "string") {
        bytes = Buffer.byteLength(json, "utf8");
        measured = true;
      }
    } catch {
      /* keep the decremented estimate */
    }
  }

  const stillOver =
    (tokenBudget !== undefined && tokens > tokenBudget) ||
    (cap !== undefined && bytes > cap);
  const budgets: string[] = [];
  if (tokenOver && tokenBudget !== undefined)
    budgets.push(`${estTokens}t > ${tokenBudget}t`);
  if (byteOver && cap !== undefined)
    budgets.push(`${size.bytes} bytes > ${cap}`);
  if (shrunk > 0) {
    providerLog(
      "info",
      SCOPE,
      `payload was over budget for ${modelId} (${budgets.join("; ")}): ` +
        `stubbed ${shrunk} oversized string(s), ${flushedBytes} bytes flushed to disk; ` +
        `new estimate ~${tokens}t / ${bytes} bytes`,
    );
  }
  if (stillOver) {
    providerLog(
      "error",
      SCOPE,
      `payload for ${modelId} is STILL over budget after shrink (~${tokens}t, ` +
        `${bytes} bytes) — sending anyway (handler cannot cancel a send); ` +
        `llm-call's emergency retry owns the aftermath`,
    );
  }
  if (shrunk === 0)
    return {
      wasDoomed: true,
      stillOver,
      shrunk: 0,
      bytes,
      measured,
      reason: sawCandidate
        ? "every oversized candidate's flush failed"
        : `doomed (${budgets.join("; ")}) but nothing oversized to stub`,
    };
  return {
    payload: { ...rec, messages: newMessages },
    shrunk,
    wasDoomed: true,
    stillOver,
    bytes,
    measured,
  };
}
