/**
 * transcribe.ts — the "recognize" half of voice inbound,
 * extended with the key-pool failover + quiet-audio retry orchestrator.
 *
 * Two provider paths, selected by `mode`:
 *
 *  - `"chat"` (DEFAULT for this deployment): Venice `chat/input_audio`. POSTs
 *    the saved voice bytes as a base64 `input_audio` content part to
 *    `{baseUrl}/chat/completions` (Venice does NOT expose
 *    OpenAI's `/v1/audio/transcriptions` route). Reads the transcript from
 *    `choices[0].message.content`. Default baseUrl https://api.venice.ai/api/v1,
 *    default model gemini-3-8-flash; the configured `language`
 *    (BRAID_TG_STT_LANGUAGE) is threaded into the prompt (default "Russian").
 *
 *  - `"transcriptions"`: OpenAI / groq / any OpenAI-compatible
 *    `/v1/audio/transcriptions` endpoint with the bytes as a multipart form
 *    (`file` Blob named voice.ogg, `model`, optional `language`).
 *
 * Both are provider-configurable via env (baseUrl / apiKey / model /
 * language / mode); only the env config changes.
 *
 * Key failover (): `keys` carries the ordered candidate pool from
 * stt-keys.ts; the request advances past 401/403/429 and quota-class error
 * bodies to the next candidate, stops at the first success, and the winner
 * is remembered process-lifetime (tried first next time). Observability
 * names candidate index + source kind only — never key material.
 *
 * Retry orchestrator: `transcribeVoiceReliable` bounds inbound
 * transcription to two rounds — the first round on the raw bytes; when it fails or
 * returns an empty transcript and normalization is enabled, the second round on
 * ffmpeg-amplified bytes. The final failure line carries endpoint host,
 * round count, the last candidate index/source, the last error class, and
 * the remediation hint.
 *
 * Transport retry: a request that THROWS instead of answering (no HTTP
 * status — DNS/TCP/TLS) is retried once, on the same candidate, after
 * `transportRetryDelayMs`. Nothing was learned about the key, so the pool is
 * not advanced; one retry per round, not a loop.
 *
 * Pure + injectable-fetch driven: `fetchFn` defaults to globalThis.fetch, so
 * tests substitute a recorded fixture fake with NO network. Never throws —
 * any non-ok response or network failure returns `{ ok: false, error }` so
 * the caller degrades instead of dropping the voice message.
 */

import type { TelegramFetch } from "./telegram-client.js";
import {
  type SttKeyCandidate,
  getPreferredSttKey,
  countSttAttempt,
  countSttSuccess,
  countSttFailure,
  countSttNormalizationApplied,
  countSttTransportRetry,
  countSttTransportRetrySuccess,
} from "./stt-keys.js";
import { normalizeAudioBytes } from "./audio-normalize.js";

/** Default OpenAI-compatible STT base URL (the /audio/transcriptions route). */
export const DEFAULT_STT_BASE_URL = "https://api.openai.com/v1";
/** Default transcription model. */
export const DEFAULT_STT_MODEL = "whisper-1";
/** Venice input_audio chat-completions base URL (the deployment default). */
export const DEFAULT_STT_CHAT_BASE_URL = "https://api.venice.ai/api/v1";
// model default: gemini-3-8-flash — it held up stable twice on the quiet
// initial clip while gemini-3-5-flash-lite wavered once even after gain.
export const DEFAULT_STT_CHAT_MODEL = "gemini-3-8-flash";

/**
 * Wait before the single transport-class retry (ms). A thrown request carries
 * no HTTP status, so it says nothing about the key: the observed failure mode
 * is a seconds-scale transport blip (the same bytes transcribed cleanly on a
 * later call from the same host). 2 s is long enough to clear a DNS/TCP/TLS
 * hiccup or a momentarily unavailable upstream, and short enough that a voice
 * note still lands while the owner waits; the bound keeps the worst case at
 * one extra pause per round.
 */
export const DEFAULT_STT_TRANSPORT_RETRY_DELAY_MS = 2000;

/** Injectable normalization step (bytes in → amplified bytes out, or null). */
export type NormalizeBytesFn = (
  bytes: Uint8Array,
) => Promise<Uint8Array | null>;

/** STT (speech-to-text) config threaded to both inbound consumers. */
export interface SttConfig {
  /** Base URL of the API (default by mode: Venice for chat, OpenAI for transcriptions). */
  baseUrl?: string;
  /** API key. Absent → voice is still delivered (path), with an "unavailable" note. */
  apiKey?: string;
  /** Model name (default by mode: gemini-3-8-flash for chat, whisper-1 for transcriptions). */
  model?: string;
  /** Optional source-language hint (both paths): appended as `language` on
   *  the transcriptions form AND threaded into the chat-mode prompt — default
   *  "Russian" (the deployment's spoken language). */
  language?: string;
  /**
   * Provider path. "chat" = Venice input_audio /chat/completions (the
   * deployment default); "transcriptions" = OpenAI /audio/transcriptions
   * multipart (kept intact). transcribeVoice defaults to "transcriptions"
   * when omitted (backward compatible); index.ts always resolves an explicit
   * mode, defaulting to "chat".
   */
  mode?: "transcriptions" | "chat";
  /** Ordered key pool (stt-keys.ts) for failover; apiKey stays the first hit. */
  keys?: SttKeyCandidate[];
  /** Quiet-audio retry gate: enabled + the amplification step. */
  normalize?: { enabled: boolean; normalizeBytes?: NormalizeBytesFn };
}

/** True when an STT api key is present (transcription is possible). */
export function isSttConfigured(
  config: { apiKey?: string; keys?: SttKeyCandidate[] } | undefined,
): boolean {
  return Boolean(config?.apiKey || (config?.keys && config.keys.length > 0));
}

/** Winning-candidate provenance on a successful transcription. */
export interface SttKeyProvenance {
  index: number;
  source: string;
}

/** Outcome of transcribeVoice: recognized text, or a degraded error note.
 *  Enriched with observability metadata (candidate provenance, attempt
 *  count, last status/error class) — all key-material-free. */
export type TranscribeResult =
  | { ok: true; text: string; key?: SttKeyProvenance }
  | {
      ok: false;
      error: string;
      attempts?: number;
      /** Transport-class retries issued in the last round (0 = none).
       *  Kept apart from `attempts`, which counts key-pool hits only. */
      retries?: number;
      candidateIndex?: number;
      candidateSource?: string;
      lastStatus?: number;
      lastClass?: string;
    };

/** Options for transcribeVoice. */
export interface TranscribeVoiceOptions {
  /** The saved voice bytes (from materializeVoice). */
  bytes: Uint8Array;
  /** MIME type of the audio (default audio/ogg). */
  mimeType?: string;
  /** API base URL (default by mode: Venice for chat, OpenAI for transcriptions). */
  baseUrl?: string;
  /** API key (single-candidate form; keys takes precedence when set). */
  apiKey?: string;
  /** Ordered key pool — failover advances past auth/quota/rate failures. */
  keys?: SttKeyCandidate[];
  /** Model name (default by mode: gemini-3-8-flash for chat, whisper-1 for transcriptions). */
  model?: string;
  /** Optional source-language hint (both paths): appended as `language` on
   *  the transcriptions form AND threaded into the chat-mode prompt (default
   *  "Russian" for this deployment). */
  language?: string;
  /** Provider path: "chat" (Venice input_audio, default for this deployment)
   *  or "transcriptions" (OpenAI multipart). Defaults to "transcriptions"
   *  here for backward compatibility; index.ts resolves it explicitly. */
  mode?: "transcriptions" | "chat";
  /** Injectable fetch (tests use a recorded-fixture fake). */
  fetchFn?: TelegramFetch;
  /** Wait before the single transport-class retry (ms; default
   *  DEFAULT_STT_TRANSPORT_RETRY_DELAY_MS). Tests pass 0 to stay off the real
   *  delay. */
  transportRetryDelayMs?: number;
}

/** Error class for the failure line + counters (never key material). */
function classifySttFailure(status: number, body: string): string {
  const lower = body.toLowerCase();
  if (lower.includes("quota")) return "quota";
  if (lower.includes("rate limit") || lower.includes("too many requests")) {
    return "rate";
  }
  if (status === 401) return "auth";
  if (status === 403) return "auth";
  if (status === 429) return "rate";
  if (status >= 400 && status < 500) return "client";
  return "other";
}

/** Advance to the next candidate on 401/403/429 and on quota-class bodies. */
function shouldAdvance(status: number, errorClass: string): boolean {
  return (
    status === 401 || status === 403 || status === 429 || errorClass === "quota"
  );
}

/** Await `ms` (only ever the transport-retry pause). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Internal outcome of one request: the public result plus the markers the
 * failover/retry policy needs (never key material).
 */
type AttemptOutcome = TranscribeResult & {
  lastStatus?: number;
  lastClass?: string;
  /** The request threw before any response arrived, so there is no HTTP
   *  status and nothing was learned about the key — the transport-class
   *  failure (DNS/TCP/TLS) the inbound path retries once. A non-ok RESPONSE
   *  never sets this, whatever its class. */
  transportFailure?: boolean;
};

/** Options for one single-candidate attempt (internal). */
type AttemptOptions = TranscribeVoiceOptions & { key: string };

/** One request against one key. Returns ok/failure plus classification. */
async function attemptTranscribe(
  opts: AttemptOptions,
): Promise<AttemptOutcome> {
  const {
    bytes,
    key,
    mode = "transcriptions",
    fetchFn = globalThis.fetch,
  } = opts;
  try {
    if (mode === "chat") {
      const baseUrl = opts.baseUrl ?? DEFAULT_STT_CHAT_BASE_URL;
      const model = opts.model ?? DEFAULT_STT_CHAT_MODEL;
      // Venice chat/input_audio: base64 of the ogg bytes as an input_audio
      // content part; the transcript comes back as a plain chat text content.
      // Thread the configured source-language into the prompt so
      // BRAID_TG_STT_LANGUAGE is honored in chat mode too (default "Russian"
      // — the deployment's spoken language).
      const language = opts.language?.trim() || "Russian";
      const body = {
        model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: {
                  data: Buffer.from(bytes).toString("base64"),
                  format: "ogg",
                },
              },
              {
                type: "text",
                text: `Transcribe this voice message verbatim (${language}). Return only the transcript.`,
              },
            ],
          },
        ],
      };
      const res = await fetchFn(
        `${baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const resBody = await res.text().catch(() => "");
        const detail = resBody ? `: ${resBody.slice(0, 200)}` : "";
        return {
          ok: false,
          error: `HTTP ${res.status}${detail}`,
          lastStatus: res.status,
          lastClass: classifySttFailure(res.status, resBody),
        };
      }
      const json = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      } | null;
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== "string") {
        return {
          ok: false,
          error: "STT response missing text",
          lastClass: "other",
        };
      }
      return { ok: true, text: text.trim() };
    }

    // transcriptions path (kept intact)
    const baseUrl = opts.baseUrl ?? DEFAULT_STT_BASE_URL;
    const model = opts.model ?? DEFAULT_STT_MODEL;
    const language = opts.language;
    const mimeType = opts.mimeType ?? "audio/ogg";

    const form = new FormData();
    // TS lib requires a Uint8Array<ArrayBuffer> for BlobPart; copy so the
    // backing store is a plain ArrayBuffer (mirrors oggToBlob in the client).
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    form.append("file", new Blob([copy], { type: mimeType }), "voice.ogg");
    form.append("model", model);
    if (language && language.trim()) form.append("language", language.trim());

    const res = await fetchFn(
      `${baseUrl.replace(/\/$/, "")}/audio/transcriptions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      },
    );
    if (!res.ok) {
      const resBody = await res.text().catch(() => "");
      const detail = resBody ? `: ${resBody.slice(0, 200)}` : "";
      return {
        ok: false,
        error: `HTTP ${res.status}${detail}`,
        lastStatus: res.status,
        lastClass: classifySttFailure(res.status, resBody),
      };
    }
    const json = (await res.json().catch(() => null)) as {
      text?: unknown;
    } | null;
    const text = json?.text;
    if (typeof text !== "string") {
      return {
        ok: false,
        error: "STT response missing text",
        lastClass: "other",
      };
    }
    return { ok: true, text: text.trim() };
  } catch (error) {
    // The request never produced a response (network/DNS/TLS/connection).
    // Flagged so the failover layer retries it once; the reported class stays
    // "other" (what this case has always been labelled).
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      lastClass: "other",
      transportFailure: true,
    };
  }
}

/** Build the ordered candidate list from keys/apiKey (keys wins when set). */
function orderedCandidates(opts: {
  keys?: SttKeyCandidate[];
  apiKey?: string;
}): SttKeyCandidate[] {
  const pool = opts.keys?.length
    ? opts.keys
    : opts.apiKey
      ? [{ key: opts.apiKey, source: "explicit" as const, index: 0 }]
      : [];
  const preferred = getPreferredSttKey();
  if (preferred && pool.some((c) => c.key === preferred.key)) {
    return [preferred, ...pool.filter((c) => c.key !== preferred.key)];
  }
  return [...pool];
}

/**
 * Transcribe the voice bytes. With `mode: "chat"` POSTs `{baseUrl}/chat/completions`
 * with the bytes as a base64 `input_audio` content part and reads
 * `choices[0].message.content` (Venice). With `mode: "transcriptions"` POSTs
 * `{baseUrl}/audio/transcriptions` as multipart (file = Blob of the bytes with
 * filename voice.ogg, model, optional language). On the chat path the optional
 * language is threaded into the prompt (default "Russian"). When `keys` carries
 * a pool, auth/quota/rate failures advance to the next candidate (). A request
 * that throws (no HTTP status) is retried once on the same candidate, since a
 * transport failure is not key-specific.
 * Returns `{ ok: true, text }` on success, `{ ok: false, error }` on any
 * non-ok response or network failure. Never throws.
 */
export async function transcribeVoice(
  opts: TranscribeVoiceOptions,
): Promise<TranscribeResult> {
  const candidates = orderedCandidates(opts);
  if (candidates.length === 0) {
    countSttFailure("no-key");
    return { ok: false, error: "no STT api key configured" };
  }
  let attempts = 0;
  let retries = 0;
  let lastFailure: {
    error: string;
    lastStatus?: number;
    lastClass?: string;
  } = { error: "no attempts made" };
  for (const candidate of candidates) {
    attempts += 1;
    countSttAttempt();
    let r = await attemptTranscribe({ ...opts, key: candidate.key });
    // One transport retry per call (= per round), never a loop: the budget is
    // scoped here, so the added requests and latency of a round are bounded.
    // A throw says nothing about the key, so the SAME candidate is retried
    // rather than the pool advanced.
    if (!r.ok && r.transportFailure && retries === 0) {
      retries += 1;
      countSttTransportRetry();
      await sleep(
        opts.transportRetryDelayMs ?? DEFAULT_STT_TRANSPORT_RETRY_DELAY_MS,
      );
      r = await attemptTranscribe({ ...opts, key: candidate.key });
      if (r.ok) countSttTransportRetrySuccess();
    }
    if (r.ok) {
      return {
        ok: true,
        text: r.text,
        key: { index: candidate.index, source: candidate.source },
      };
    }
    lastFailure = {
      error: r.error,
      lastStatus: r.lastStatus,
      lastClass: r.lastClass,
    };
    const advance = shouldAdvance(r.lastStatus ?? 0, r.lastClass ?? "other");
    if (!advance) break;
  }
  return {
    ok: false,
    error: lastFailure.error,
    attempts,
    retries,
    candidateIndex:
      candidates[Math.min(attempts, candidates.length) - 1]?.index,
    candidateSource:
      candidates[Math.min(attempts, candidates.length) - 1]?.source,
    lastStatus: lastFailure.lastStatus,
    lastClass: lastFailure.lastClass,
  };
}

/** Options for transcribeVoiceReliable (the inbound orchestrator). */
export interface TranscribeVoiceReliableOptions extends Omit<
  TranscribeVoiceOptions,
  "apiKey"
> {
  /** Single-candidate fallback (keys takes precedence). */
  apiKey?: string;
  /** Quiet-audio retry gate: enabled + optional injectable amplification
   *  (defaults to the real ffmpeg normalizeAudioBytes). */
  normalize?: { enabled: boolean; normalizeBytes?: NormalizeBytesFn };
}

/** Endpoint host for the failure line (never the full URL, never keys). */
function endpointHost(baseUrl: string | undefined, mode: string): string {
  try {
    const url = new URL(
      baseUrl ??
        (mode === "chat" ? DEFAULT_STT_CHAT_BASE_URL : DEFAULT_STT_BASE_URL),
    );
    return url.host;
  } catch {
    return "unknown-endpoint";
  }
}

/**
 * The inbound orchestrator: bounded to TWO transcription rounds.
 * The first round runs the key-pool failover on the raw bytes; when it fails or
 * returns an EMPTY transcript and normalization is enabled, the bytes are
 * amplified (ffmpeg; absent ffmpeg → the second round is skipped silently)
 * and the second round reruns the pool on the normalized bytes. Counters (attempts, successes by
 * candidate index, normalizations applied, failures by class) live in
 * stt-keys.ts. The final failure error carries endpoint host, round count,
 * the requests issued in that round (the transport retry named on its own),
 * the last candidate index/source, the last error class, and the remediation
 * hint — never key material. Never throws.
 */
export async function transcribeVoiceReliable(
  opts: TranscribeVoiceReliableOptions,
): Promise<TranscribeResult> {
  const host = endpointHost(opts.baseUrl, opts.mode ?? "chat");
  const round = async (
    bytes: Uint8Array,
  ): Promise<{ result: TranscribeResult; okNonEmpty: boolean }> => {
    const result = await transcribeVoice({ ...opts, bytes });
    const okNonEmpty = result.ok && result.text.length > 0;
    return { result, okNonEmpty };
  };

  const first = await round(opts.bytes);
  if (first.okNonEmpty) {
    if (first.result.ok) countSttSuccessWithProvenance(first.result);
    return first.result;
  }

  // Empty-but-ok first round is retried like a failure.
  const normalize = opts.normalize;
  if (!normalize?.enabled) {
    // No normalization → report the first round honestly (empty ok → failure
    // with class "empty", real failures keep their enriched line).
    return finalizeFailure(first.result, host, 1, normalize?.enabled === true);
  }

  const normalizeBytes =
    normalize.normalizeBytes ??
    ((bytes: Uint8Array) => normalizeAudioBytes(bytes));
  const amplified = await normalizeBytes(opts.bytes);
  if (!amplified) {
    return finalizeFailure(first.result, host, 1, true);
  }

  const second = await round(amplified);
  if (second.result.ok) {
    countSttNormalizationApplied();
    if (second.okNonEmpty) countSttSuccessWithProvenance(second.result);
    else return finalizeFailure(second.result, host, 2, true);
    return second.result;
  }
  return finalizeFailure(second.result, host, 2, true);
}

/** Count a final success by provenance (counters keyed by candidate index). */
function countSttSuccessWithProvenance(
  result: TranscribeResult & { ok: true },
): void {
  if (result.key) {
    countSttSuccess({
      key: "",
      index: result.key.index,
      source: result.key.source as SttKeyCandidate["source"],
    });
  }
}

/** Compose the honest failure line + record the failure class. */
function finalizeFailure(
  result: TranscribeResult,
  host: string,
  rounds: number,
  normalizationAvailable: boolean,
): TranscribeResult {
  if (result.ok) {
    // Empty transcript after the bounded rounds → report as failure.
    const error = `empty transcript after ${rounds} round(s) (endpoint ${host} — hint: enable BRAID_TG_STT_NORMALIZE)`;
    countSttFailure("empty");
    return {
      ok: false,
      error,
      attempts: result.key ? 1 : 1,
      lastClass: "empty",
    };
  }
  const attempts = result.attempts ?? 1;
  const retries = result.retries ?? 0;
  const parts = [
    `endpoint ${host}`,
    // Requests actually issued in this round: candidate hits plus the
    // transport retry, which is named so the total is not read as key work.
    `${rounds} round(s), ${attempts + retries} request(s)${
      retries > 0 ? ` (${retries} transport retry)` : ""
    }`,
    result.candidateIndex !== undefined
      ? `key ${result.candidateIndex}/${result.candidateSource ?? "unknown"}`
      : undefined,
    result.lastClass ? `class ${result.lastClass}` : undefined,
  ].filter(Boolean);
  const hint = normalizationAvailable
    ? "hint: add keys (BRAID_TG_STT_KEYS / keyring) or enable BRAID_TG_STT_NORMALIZE"
    : "hint: add keys (BRAID_TG_STT_KEYS / keyring)";
  countSttFailure(result.lastClass ?? "other");
  return {
    ...result,
    error: `${result.error} (${parts.join(", ")} — ${hint})`,
  };
}
