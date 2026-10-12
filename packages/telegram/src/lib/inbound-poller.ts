/**
 * Inbound long-poll loop — the backward channel.
 *
 * Pulls updates via getUpdates with a persisted offset, filters to private
 * 1:1 chats from the allow-list, and hands accepted owner text messages to an
 * `onOwnerMessage` callback (wired to pi.sendUserMessage in index.ts — the
 * pi-core equivalent of agent-zero's `context.communicate(UserMessage(...))`).
 *
 * Message acceptance (mirrors agent-zero helpers/handler.py::_is_allowed):
 *  - must be a `message` update (not edited/channel_post)
 *  - chat must be `private` (the bot receives all private 1:1 chats)
 *  - must carry non-empty `text` OR a non-empty `photo` array OR a usable
 *    `voice`/`document` object (photo/voice/document inbound — the optional
 *    `caption` is carried; accepted media messages are downloaded to the
 *    media dir and delivered with the absolute path)
 *  - `from.id` must be in the allow-list; when the allow-list is empty and
 *    `bootstrap` is on, the first valid private sender (text, photo, voice, or
 *    document) is auto-allowed (owner chat id env OR first-message bootstrap).
 *
 * Offset semantics — confirm-on-read (Telegram Bot API behavior):
 *  The persisted offset advances to `max-seen update_id + 1` once a batch has
 *  been read, so Telegram never redelivers the same batch. Telegram offsets are
 *  monotonic and in-order — they cannot skip a failed update without dropping
 *  it — so accepted updates whose injection FAILS are moved to an in-memory
 *  retry buffer and retried on subsequent cycles (up to `maxRetries`), never
 *  lost. Rejected/foreign updates are fully dropped (no retry) so a spammer
 *  cannot wedge the queue.
 *
 * The poller is decoupled from pi-core: it only calls `onOwnerMessage` /
 * `onError` callbacks, so every behavioral rule is unit-testable against a
 * fake fetch with no pi runtime and no network.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultStateFilePath, warnUnderivableRoot } from "./state-paths.js";
import {
  getUpdates,
  getMe,
  sendMessage,
  type TelegramFetch,
  type TelegramUpdate,
  type TelegramCallbackQuery,
} from "./telegram-client.js";
import type { PauseState } from "./pause-control.js";
import {
  hasPhoto,
  materializePhoto,
  pickPhotoVariant,
  formatPhotoText,
} from "./photo.js";
import {
  hasVoice,
  getVoiceFileId,
  materializeVoice,
  formatVoiceText,
  type TelegramVoice,
} from "./voice.js";
import {
  hasDocument,
  materializeDocument,
  formatDocumentText,
  type TelegramDocument,
} from "./document.js";
import {
  transcribeVoiceReliable,
  isSttConfigured,
  type SttConfig,
} from "./transcribe.js";

export interface IncomingOwnerMessage {
  updateId: number;
  messageId: number;
  fromId: number;
  username?: string;
  firstName?: string;
  chatId: number;
  chatType: string;
  text: string;
  /** Present for photo messages (absent for plain-text). */
  photo?: {
    fileId: string;
    /** Absolute path of the saved file (when the download succeeded). */
    filePath?: string;
    caption?: string;
    /** True when the photo bytes were saved to the media dir. */
    downloaded: boolean;
    /** Download/save failure note (degraded delivery, never dropped). */
    error?: string;
  };
  /** Present for voice messages (absent for plain-text). */
  voice?: {
    fileId: string;
    /** Absolute path of the saved file (when the download succeeded). */
    filePath?: string;
    caption?: string;
    /** True when the voice bytes were saved to the media dir. */
    downloaded: boolean;
    /** Recognized transcript (when STT succeeded). */
    transcript?: string;
    /** Degradation note (download or transcription failure, never dropped). */
    error?: string;
  };
  /** Present for document messages (absent for plain-text). */
  document?: {
    fileId: string;
    /** Original client-side file_name (when Telegram provided one). */
    name?: string;
    /** Absolute path of the saved file (when the download succeeded). */
    path?: string;
    /** Declared file size in bytes (when Telegram provided it). */
    size?: number;
    /** Declared MIME type (when Telegram provided it). */
    mimeType?: string;
    caption?: string;
    /** True when the document bytes were saved to the media dir. */
    downloaded: boolean;
    /** Refusal/download/save failure note (degraded delivery, never dropped). */
    error?: string;
  };
  receivedAt: number;
}

/**
 * Tunnel liveness transition emitted by the poller (watchdog canary).
 *
 * The poller owns the counter (consecutive getUpdates failures); the core
 * watchdog subscribes to the transition and surfaces the two whispers
 * (down + recovery) via sendTrackedMessage. No network is involved here —
 * this is a pure local signal derived from the getUpdates result.
 */
export interface WatchdogTunnelStatusEvent {
  /** "down" when N consecutive fetch-failures trip the threshold; "up" on recovery. */
  status: "down" | "up";
  /** Consecutive getUpdates failures at the transition (0 on the "up" event). */
  failures: number;
  /** Last getUpdates error text (present on "down"). */
  lastError?: string;
  /** Ready-to-deliver whisper body (down: diagnose; up: recovery). */
  message: string;
}

/** Media-extraction context threaded into extractIncomingMessage (photo/voice/document inbound). */
export interface IncomingMediaContext {
  token?: string;
  fetchFn?: TelegramFetch;
  baseUrl?: string;
  mediaDir?: string;
  /** STT (speech-to-text) config — absent/empty means voice is delivered untranscribed. */
  stt?: SttConfig;
}

export interface InboundPollerOptions {
  token: string;
  /** Initially allowed sender ids or @usernames (owner chat id env or empty). */
  allowedUsers: Array<number | string>;
  /** Path to the JSON state file where the confirmed offset is persisted. */
  stateFile?: string;
  /** Injectable fetch (tests use a recorded-fixture fake). */
  fetchFn?: TelegramFetch;
  /** Directory where downloaded photo/voice/document bytes are saved. Default `<braidDir>/telegram/media`. */
  mediaDir?: string;
  /** STT (speech-to-text) config for voice transcription (optional). */
  stt?: SttConfig;
  /** Poll cadence in ms. Default 1500. */
  intervalMs?: number;
  /** Auto-allow the first private text sender when the allow-list is empty. */
  bootstrap?: boolean;
  /** Max injection attempts for an accepted message before it is dropped. */
  maxRetries?: number;
  /**
   * Called on each tunnel liveness transition (down at the failure threshold,
   * up on recovery). Injectable so the fixture tests can assert transitions
   * with zero network; telegram/index.ts wires it to the cross-package
   * watchdog hub (watchdog-tunnel.ts) that the core watchdog subscribes to.
   */
  onTunnelStatusChange?: (event: WatchdogTunnelStatusEvent) => void;
  /** Consecutive getUpdates failures that trip the tunnel-down event. Default 3. */
  tunnelFailureThreshold?: number;
  /** Called for each accepted owner message. May be async; reject to requeue. */
  onOwnerMessage: (message: IncomingOwnerMessage) => void | Promise<void>;
  /**
   * Called for each callback_query update (inline-keyboard tap).
   * The handler owns answerCallbackQuery + editMessageText; the poller only
   * routes ALLOW-LISTED taps here (foreign taps are dropped — never a turn).
   * May be async; reject to requeue. Absent → callback updates are dropped.
   */
  onCallbackQuery?: (update: TelegramUpdate) => void | Promise<void>;
  /**
   * Pause-gate state reader: checked on NON-callback
   * Owner messages BEFORE delivery — when paused the message is NOT injected
   * (onOwnerMessage is never called → no sendUserMessage turn) and the owner
   * gets ONE «⏸ пауза» ack per paused period. Callback_query taps are NEVER
   * gated (they are the owner's resume path). The orchestrator (index.ts)
   * injects the real getPauseState so the gate is live in production; the
   * default "never paused" keeps the poller deterministic without wiring or
   * new config keys.
   */
  getPauseState?: PauseStateReader;
  /** Text for the once-per-paused-period ack. Defaults to PAUSED_INBOUND_ACK_TEXT. */
  pauseAckText?: string;
  /** Non-fatal error sink (network blips, injection failures). */
  onError?: (error: unknown) => void;
  /** Optional logger; defaults to a no-op. */
  log?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    ...rest: unknown[]
  ) => void;
}

/** PollerState persisted to the state file (survive restarts). */
export interface PollerState {
  offset: number;
}

export interface PollOnceResult {
  ok: boolean;
  error?: string;
  fetched: number;
  /** Number accepted and handed to onOwnerMessage this cycle. */
  accepted: number;
  /** Number dropped by policy (foreign/ignored/non-text). */
  rejected: number;
  /** Messages held by the pause gate this cycle (paused → acked, not injected). */
  paused: number;
  /** Callback_query updates handled this cycle. */
  callbacks: number;
  /** Callback_query updates dropped (foreign sender or no handler). */
  callbackRejected: number;
  /** Updates whose injection failed this cycle and moved to the retry buffer. */
  requeued: number;
  /** Retry-buffer messages that succeeded this cycle. */
  retried: number;
  /** Newly bootstrap-allowed sender ids this cycle. */
  bootstrapped: number[];
  /** Offset now persisted. */
  offset: number;
}

export const DEFAULT_POLL_TIMEOUT_SECONDS = 50; // long-poll socket timeout (Telegram caps at 50s; fewer reconnect windows = less getUpdates conflict surface)
export const DEFAULT_POLL_INTERVAL_MS = 1500;

/** Consecutive getUpdates failures that trip the tunnel-down transition (watchdog canary). */
export const DEFAULT_TUNNEL_FAILURE_THRESHOLD = 3;

/** Quiet window for repeating poll-cycle errors. */
export const ERROR_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

export type MessageVerdict =
  | "owner"
  | "bootstrap"
  | "foreign"
  | "non_message"
  | "non_private"
  | "non_text";

/** Pause-state reader for the pause gate. */
export type PauseStateReader = (stateFile?: string) => Promise<PauseState>;

/**
 * Ack text for the once-per-paused-period reply: the owner is told the agent
 * is paused and that a ▶️ Resume tap on the control keyboard resumes. Kept
 * short so it reads as a toast-style ack («⏸ пауза»), not a control panel.
 */
export const PAUSED_INBOUND_ACK_TEXT =
  "«⏸ пауза» — агент на паузе. Нажми ▶️ Resume на клавиатуре, чтобы возобновить.";

// Repeated-error throttle
//
// The poll loop re-poll every ~1.5s, so a persistent getUpdates failure (e.g.
// a conflicting consumer holding the only long-poll slot, or a transient
// network blip) would log a fresh console.error every cycle and wreck the TUI.
// After the first loud warn (full detail), repeats produce NO log call at all
// (zero per-cycle output, no counter line, no partial re-render) — even a
// per-cycle `debug` line renders in the live pi TUI, and its cursor-escape
// sequences corrupt the user input field with artifacts. The error
// re-promotes to warn at most once per window, and a successful poll later
// emits one info recovery line. The `onError` sink is gated on the SAME loud
// occurrences so the consumer's own error log (e.g. `inbound poll error: ...`)
// does not fire per cycle either.

/** Poller log callback shape (matches InboundPollerOptions.log). */
export type PollLogLevel = "debug" | "info" | "warn" | "error";
export type PollLog = (
  level: PollLogLevel,
  message: string,
  ...rest: unknown[]
) => void;

export interface ThrottledLogger {
  /**
   * Record one occurrence of a repeating error. The first occurrence is
   * emitted at `level` with full detail; consecutive repeats within `windowMs`
   * produce NO log output at all (zero per-cycle lines), until
   * `windowMs` has elapsed since the last loud emission — then the error
   * re-promotes to `level` exactly once. Returns true when this occurrence
   * was the LOUD one; callers use the return value to gate side-effecting
   * sinks (e.g. `onError`) so they stay quiet too.
   */
  occurrence(level: PollLogLevel, message: string): boolean;
  /** Consecutive occurrences in the current burst (0 when clean/reset). */
  streak(): number;
  /** Clear the error state after a successful poll (recovery). */
  reset(): void;
}

/**
 * Build a small per-source rate limiter. `windowMs` and `now` are injectable
 * so tests can shrink the window and advance a fake clock instead of waiting
 * out five real minutes. At most ONE line is ever emitted per `windowMs`: the
 * first occurrence is loud with full detail, repeats inside the window are
 * completely silent (no debug, no counter) so per-cycle output
 * cannot corrupt the TUI, and a still-failing source re-warns once when the
 * window elapses. `streak()` exposes the consecutive-error count so a caller
 * can emit a single recovery line once the error clears; `reset()` clears the
 * state after recovery. State resets itself once no occurrence has been seen
 * for a full window, so a later burst starts loud again.
 */
export function createThrottledLogger(
  log: PollLog,
  windowMs: number = ERROR_THROTTLE_MS,
  now: () => number = Date.now,
): ThrottledLogger {
  let seen = false;
  let lastAt = 0;
  let lastLoudAt = 0;
  let streak = 0;

  return {
    occurrence(level, message) {
      const t = now();
      const burstAgedOut = !seen || t - lastAt >= windowMs;
      const windowSinceLoud = !seen || t - lastLoudAt >= windowMs;
      streak = burstAgedOut ? 1 : streak + 1;
      lastAt = t;
      if (burstAgedOut || windowSinceLoud) {
        seen = true;
        lastLoudAt = t;
        log(level, message);
        return true;
      }
      // Quiet repeat: ZERO log output — the first loud warn stands and
      // the TUI gets no per-cycle line, counter, or partial re-render.
      return false;
    },
    streak() {
      return streak;
    },
    reset() {
      seen = false;
      lastAt = 0;
      lastLoudAt = 0;
      streak = 0;
    },
  };
}

// Pure acceptance logic (unit-tested directly)

/**
 * Classify a single update against the allow-list + bootstrap policy.
 * Returns the reason-independent verdict used by test assertions.
 */
export function classifyUpdate(
  update: TelegramUpdate,
  allowedUsers: Array<number | string>,
  allowListEmptyAndBootstrapping: boolean,
): MessageVerdict {
  const message = update.message;
  if (!message) return "non_message";
  if (!message.chat || message.chat.type !== "private") return "non_private";
  const text = typeof message.text === "string" ? message.text.trim() : "";
  // Photo/voice/document messages (non-empty `photo` / usable `voice` or
  // `document`, optional caption) classify by sender like text — no
  // `message.text` is required for a media message.
  if (
    !text &&
    !hasPhoto(message) &&
    !hasVoice(message) &&
    !hasDocument(message)
  )
    return "non_text";
  const from = message.from;
  if (!from || typeof from.id !== "number") return "foreign";
  if (isAllowed(from, allowedUsers)) return "owner";
  if (allowListEmptyAndBootstrapping) return "bootstrap";
  return "foreign";
}

/**
 * True when the sender (id or @username string) is in the allow-list.
 * Mirrors agent-zero `_is_allowed` for plain numeric-username entries.
 */
export function isAllowed(
  from: { id: number; username?: string },
  allowedUsers: Array<number | string>,
): boolean {
  for (const entry of allowedUsers) {
    const s = String(entry).trim();
    if (s.startsWith("@")) {
      if (from.username && `@${from.username}` === s) return true;
    } else if (/^\d+$/.test(s)) {
      if (Number(s) === from.id) return true;
    } else if (
      from.username &&
      from.username.toLowerCase() === s.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extract an accepted message into the shape handed to consumers (shared by
 * the background poller and telegram-inbox). Plain-text messages map 1:1.
 * Photo messages (no text, non-empty `photo`) download the largest variant to
 * the media dir and deliver the absolute path (caption carried); on any
 * download/save failure they degrade to the file_id + error note in `text` —
 * the update is NEVER dropped. Voice messages (no text, non-empty `voice`)
 * download the note, save it, and — when `media.stt.apiKey` is configured —
 * transcribe it via the OpenAI-compatible STT endpoint, delivering the
 * transcript; without STT the saved path is delivered with an "unavailable"
 * note (still a successful receive); on any download failure they degrade to
 * the file_id + error note — NEVER dropped. Document messages (a usable
 * `document` object — with or without text) download the file, save it as
 * `<mediaDir>/<update_id>.<safe-ext from file_name>` (over-limit sizes are
 * refused with an explicit reason), and deliver the path + metadata; on any
 * failure they degrade to the file_id + error note — NEVER dropped. A
 * text+document message carries BOTH: the original text plus the document
 * line. When `media.token` is absent (tests without a token) media messages
 * degrade without a download.
 */
export async function extractIncomingMessage(
  update: TelegramUpdate,
  media: IncomingMediaContext = {},
): Promise<IncomingOwnerMessage> {
  const message = update.message!;
  const base = {
    updateId: update.update_id,
    messageId: message.message_id,
    fromId: message.from!.id,
    username: message.from!.username,
    firstName: message.from!.first_name,
    chatId: message.chat.id,
    chatType: message.chat.type,
    receivedAt: message.date * 1000,
  };
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const caption =
    typeof message.caption === "string" && message.caption.trim()
      ? message.caption.trim()
      : undefined;
  const senderLabel = base.username ? `@${base.username}` : `id ${base.fromId}`;

  if (!text && hasPhoto(message)) {
    const variant = pickPhotoVariant(message.photo);
    if (variant) {
      const fileId = variant.file_id;
      const result = media.token
        ? await materializePhoto({
            token: media.token,
            updateId: update.update_id,
            photo: variant,
            fetchFn: media.fetchFn,
            baseUrl: media.baseUrl,
            mediaDir: media.mediaDir,
          })
        : {
            ok: false as const,
            fileId,
            error: "no telegram token for media download",
          };
      if (result.ok) {
        return {
          ...base,
          text: formatPhotoText({
            senderLabel,
            filePath: result.filePath,
            caption,
          }),
          photo: {
            fileId: result.fileId,
            filePath: result.filePath,
            caption,
            downloaded: true,
          },
        };
      }
      return {
        ...base,
        text: formatPhotoText({
          senderLabel,
          fileId: result.fileId,
          error: result.error,
          caption,
        }),
        photo: {
          fileId: result.fileId,
          caption,
          downloaded: false,
          error: result.error,
        },
      };
    }
    // No usable variant (missing file_id) — deliver the raw file_id if any.
    const rawFileId = Array.isArray(message.photo)
      ? (message.photo[0] as { file_id?: string } | undefined)?.file_id
      : undefined;
    return {
      ...base,
      text: formatPhotoText({
        senderLabel,
        fileId: rawFileId,
        error: "no usable photo variant",
        caption,
      }),
      photo: rawFileId
        ? {
            fileId: rawFileId,
            caption,
            downloaded: false,
            error: "no usable photo variant",
          }
        : undefined,
    };
  }

  if (!text && hasVoice(message)) {
    const fileId = getVoiceFileId(message.voice);
    if (fileId) {
      const result = media.token
        ? await materializeVoice({
            token: media.token,
            updateId: update.update_id,
            voice: message.voice as TelegramVoice,
            fetchFn: media.fetchFn,
            baseUrl: media.baseUrl,
            mediaDir: media.mediaDir,
          })
        : {
            ok: false as const,
            fileId,
            error: "no telegram token for media download",
          };
      if (result.ok) {
        const voiceBase = {
          fileId: result.fileId,
          filePath: result.filePath,
          caption,
          downloaded: true,
        };
        if (isSttConfigured(media.stt)) {
          // Retry orchestrator: bounded to two rounds — round 1 raw bytes,
          // round 2 ffmpeg-amplified when the first fails or comes back
          // empty and normalization is enabled (stt config carries the gate
          // and the key pool; counters live in stt-keys.ts).
          const tr = await transcribeVoiceReliable({
            bytes: result.bytes,
            baseUrl: media.stt?.baseUrl,
            apiKey: media.stt?.apiKey,
            model: media.stt?.model,
            language: media.stt?.language,
            mode: media.stt?.mode,
            fetchFn: media.fetchFn,
          });
          if (tr.ok) {
            return {
              ...base,
              text: formatVoiceText({
                senderLabel,
                filePath: result.filePath,
                caption,
                transcript: tr.text,
              }),
              voice: { ...voiceBase, transcript: tr.text },
            };
          }
          return {
            ...base,
            text: formatVoiceText({
              senderLabel,
              filePath: result.filePath,
              caption,
              transcriptError: `failed: ${tr.error}`,
            }),
            voice: { ...voiceBase, error: `transcription failed: ${tr.error}` },
          };
        }
        // No STT configured — deliver the saved path with the "unavailable"
        // note (still a successful receive, never dropped).
        return {
          ...base,
          text: formatVoiceText({
            senderLabel,
            filePath: result.filePath,
            caption,
            transcriptError: "unavailable — set BRAID_TG_STT_API_KEY",
          }),
          voice: voiceBase,
        };
      }
      return {
        ...base,
        text: formatVoiceText({
          senderLabel,
          fileId: result.fileId,
          error: result.error,
          caption,
        }),
        voice: {
          fileId: result.fileId,
          caption,
          downloaded: false,
          error: result.error,
        },
      };
    }
    // No usable file_id — deliver the degraded note (never dropped).
    return {
      ...base,
      text: formatVoiceText({
        senderLabel,
        error: "no usable voice file_id",
        caption,
      }),
    };
  }

  if (hasDocument(message)) {
    // Document inbound: a document may ride WITH text (both carried) or be
    // document-only. Voice/audio/photo/video_note messages never reach this
    // branch (distinct Telegram fields, handled above).
    const document = message.document as TelegramDocument;
    const fileId = document.file_id;
    const name =
      typeof document.file_name === "string" && document.file_name
        ? document.file_name
        : undefined;
    const size =
      typeof document.file_size === "number" ? document.file_size : undefined;
    const mimeType =
      typeof document.mime_type === "string" ? document.mime_type : undefined;
    const result = media.token
      ? await materializeDocument({
          token: media.token,
          updateId: update.update_id,
          document,
          fetchFn: media.fetchFn,
          baseUrl: media.baseUrl,
          mediaDir: media.mediaDir,
        })
      : {
          ok: false as const,
          fileId,
          error: "no telegram token for media download",
        };
    const docText = result.ok
      ? formatDocumentText({
          senderLabel,
          filePath: result.filePath,
          name,
          caption,
        })
      : formatDocumentText({
          senderLabel,
          fileId: result.fileId,
          name,
          error: result.error,
          caption,
        });
    return {
      ...base,
      text: text ? `${text}\n${docText}` : docText,
      document: {
        fileId,
        name,
        size,
        mimeType,
        caption,
        ...(result.ok
          ? { path: result.filePath, downloaded: true as const }
          : { downloaded: false as const, error: result.error }),
      },
    };
  }

  return { ...base, text };
}

// State file (offset persistence across restarts)

/** Default state file. Null when no absolute braid root resolves: a poller
 *  without offset persistence would re-deliver, so createInboundPoller
 *  refuses to build on it. */
export function defaultStateFile(): string | null {
  return defaultStateFilePath();
}

export async function loadState(stateFile: string): Promise<PollerState> {
  try {
    const raw = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<PollerState>;
    const offset = Number(parsed?.offset);
    return { offset: Number.isFinite(offset) && offset >= 0 ? offset : 0 };
  } catch {
    return { offset: 0 };
  }
}

export async function saveState(
  stateFile: string,
  state: PollerState,
): Promise<void> {
  const dir = dirname(stateFile);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // parent may already exist and be non-writable-required; write will surface real errors
  }
  await writeFile(
    stateFile,
    JSON.stringify({ offset: state.offset }, null, 2) + "\n",
    "utf8",
  );
}

// Poller

export interface InboundPoller {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  /** Resolves once the persisted offset has been loaded into state. */
  waitReady(): Promise<void>;
  /** Perform one poll cycle (test seam; also used internally by the loop). */
  pollOnce(): Promise<PollOnceResult>;
  getState(): PollerState;
  /**
   * Current tunnel liveness: "up" / "down" once the first poll has run
   * (consecutive-failure counter), "unknown" before any poll attempt.
   */
  getTunnelStatus(): { status: "up" | "down" | "unknown"; failures: number };
}

/** Format the tunnel-down whisper body (watchdog canary). */
export function formatTunnelDownMessage(
  failures: number,
  lastError?: string,
): string {
  const err =
    lastError && lastError.trim() ? lastError.trim() : "unknown error";
  return (
    `Telegram tunnel DOWN: ${failures} consecutive getUpdates failures (${err}). ` +
    `The remote canary is offline — diagnose the tunnel/poller before relying on remote operations.`
  );
}

/** Format the tunnel recovery whisper body (watchdog canary). */
export function formatTunnelRecoveryMessage(priorFailures: number): string {
  return (
    `Telegram tunnel recovered after ${priorFailures} consecutive getUpdates failure` +
    `${priorFailures === 1 ? "" : "s"} — the remote channel is back online.`
  );
}

export function createInboundPoller(
  options: InboundPollerOptions,
): InboundPoller {
  const {
    token,
    allowedUsers,
    fetchFn = globalThis.fetch,
    mediaDir,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    bootstrap = true,
    onOwnerMessage,
    onCallbackQuery,
    getPauseState = async () => ({ paused: false, updatedAt: 0 }),
    pauseAckText = PAUSED_INBOUND_ACK_TEXT,
    onError,
    log = () => {},
  } = options;
  const resolvedStateFile = options.stateFile ?? defaultStateFile();
  if (resolvedStateFile === null) {
    warnUnderivableRoot("inbound poller refused");
    throw new Error(
      "braid telegram state file is underivable (BRAID_HOME unset and no absolute home); refusing to start the inbound poller without offset persistence",
    );
  }
  const stateFile: string = resolvedStateFile;

  const allowList: Array<number | string> = [...allowedUsers];
  const maxRetries = options.maxRetries ?? 5;
  // Media-extraction context: token + fetch + media dir + stt config threaded
  // to extractIncomingMessage so accepted photo/voice messages download,
  // save, and (voice) transcribe.
  const mediaCtx: IncomingMediaContext = {
    token,
    fetchFn,
    mediaDir,
    stt: options.stt,
  };
  // One throttler for the repeating getUpdates-failure source:
  // first failure logs at warn with full detail, then consecutive identical
  // failures are COMPLETELY SILENT for ERROR_THROTTLE_MS (zero per-cycle
  // output), re-loud once per window; a successful poll resets it and can emit
  // one recovery info line (see pollCycle).
  const getUpdatesFailure = createThrottledLogger(log);
  const onTunnelStatusChange = options.onTunnelStatusChange;
  const tunnelThreshold =
    options.tunnelFailureThreshold ?? DEFAULT_TUNNEL_FAILURE_THRESHOLD;
  // Tunnel liveness: consecutive getUpdates failure counter independent of the
  // 5-min log throttle (it counts EVERY consecutive failure, reset on success).
  // tunnelDown flips once the counter crosses the threshold and flips back on
  // the first success — the down/up transition fires onTunnelStatusChange.
  let tunnelProbed = false;
  let consecutiveTunnelFailures = 0;
  let tunnelDown = false;
  let lastTunnelError: string | undefined;
  const retryQueue: Array<{
    update: TelegramUpdate;
    attempts: number;
    kind: "message" | "callback";
  }> = [];

  function emitTunnelStatus(
    status: "down" | "up",
    failures: number,
    lastError: string | undefined,
    message: string,
  ): void {
    // Last-writer-wins: the poller is the ONE emitter of tunnel transitions.
    tunnelProbed = true;
    onTunnelStatusChange?.({ status, failures, lastError, message });
  }

  /**
   * Tunnel liveness proven up: reset the failure counter and emit exactly one
   * "up" recovery event when a down state was open (one event per outage).
   * Shared by the successful-poll path and the getMe-liveness path so both
   * recovery sources emit identically.
   */
  function markTunnelUp(): void {
    if (tunnelDown) {
      const priorFailures = consecutiveTunnelFailures;
      const lastErrorSnapshot = lastTunnelError;
      tunnelDown = false;
      consecutiveTunnelFailures = 0;
      lastTunnelError = undefined;
      emitTunnelStatus(
        "up",
        0,
        lastErrorSnapshot,
        formatTunnelRecoveryMessage(priorFailures),
      );
    } else {
      consecutiveTunnelFailures = 0;
      tunnelProbed = true;
    }
  }
  let state: PollerState = { offset: 0 };
  const bootstrapped: number[] = [];
  // Pause gate: `pauseAckUpdatedAt` records the
  // updatedAt of the paused period the last «⏸ пауза» ack was sent for (0 =
  // never). A paused message is acked exactly once per paused period — the
  // flag's updatedAt changes on every resume/re-pause transition, so the next
  // paused period re-acks while messages inside the same period are held
  // silently (no reply-storm). Not persisted: a poller restart just re-acks
  // once (a fresh session), which is the desired behavior.
  let pauseAckUpdatedAt = 0;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Load the persisted offset eagerly so the first poll (and any direct
  // pollOnce call) deterministically starts from the saved offset.
  const readyPromise: Promise<void> = loadState(stateFile).then((loaded) => {
    state = loaded;
  });

  async function drainRetryQueue(): Promise<{
    retried: number;
    dropped: number;
  }> {
    let retried = 0;
    let dropped = 0;
    for (let i = retryQueue.length - 1; i >= 0; i--) {
      const entry = retryQueue[i];
      try {
        if (entry.kind === "callback") {
          // Callback taps are NEVER pause-gated — they are the owner's resume
          // path. The gate applies to non-callback delivery.
          await onCallbackQuery?.(entry.update);
        } else {
          // Pause gate applies to queued messages too: while paused a retried
          // owner message stays queued (never injected) until unpaused. No ack
          // here — the initial attempt already passed the gate, so the ack (if
          // any) was handled at acceptance time.
          const pause = await getPauseState();
          if (pause.paused) {
            log(
              "debug",
              `telegram: retry held while paused (update ${entry.update.update_id})`,
            );
            continue;
          }
          await onOwnerMessage(
            await extractIncomingMessage(entry.update, mediaCtx),
          );
        }
        retried++;
        log("debug", `telegram: retried update ${entry.update.update_id}`);
        retryQueue.splice(i, 1);
      } catch (error) {
        entry.attempts++;
        if (entry.attempts >= maxRetries) {
          dropped++;
          retryQueue.splice(i, 1);
          log(
            "error",
            `telegram: dropped update ${entry.update.update_id} after ${entry.attempts} failed injections: ${String(error)}`,
          );
          onError?.(error);
        } else {
          log(
            "warn",
            `telegram: retry ${entry.attempts}/${maxRetries} failed for update ${entry.update.update_id}: ${String(error)}`,
          );
        }
      }
    }
    return { retried, dropped };
  }

  async function pollCycle(): Promise<PollOnceResult> {
    await readyPromise;
    // 1. Retry previously failed accepted messages from the local buffer first.
    const { retried } = await drainRetryQueue();

    // 2. Long-poll the next batch.
    const res = await getUpdates(
      token,
      state.offset,
      DEFAULT_POLL_TIMEOUT_SECONDS,
      {
        fetch: fetchFn,
      },
    );
    if (!res.ok) {
      // Loud on the first occurrence (and at most once per throttle window),
      // utter SILENCE on consecutive repeats — no debug, no counter, so
      // the TUI never sees a per-cycle line while the error is sustained.
      const loud = getUpdatesFailure.occurrence(
        "warn",
        `getUpdates failed (offset ${state.offset}): ${res.error ?? "unknown"}`,
      );
      // Gate the consumer error sink on the loud occurrence too, so the
      // index.ts `inbound poll error: ...` warn does not fire every cycle.
      if (loud) {
        onError?.(
          new Error(res.error ?? `getUpdates failed (offset ${state.offset})`),
        );
      }
      // Watchdog tunnel counter — getMe-based liveness (standing backlog
      // Real fix after the gate-widening mitigation).
      // A getUpdates failure is a TUNNEL failure only when the Telegram API
      // itself is unreachable or rejects the token. A "Conflict: terminated
      // by other getUpdates request" comes from a SECOND getUpdates consumer
      // holding the singleton long-poll slot (sibling process poller, agentic
      // inbox) — which PROVES the API is up and the tunnel is healthy; the
      // old behavior counted it as a tunnel failure and barked
      // tunnel-down at healthy pollers. getMe never takes the getUpdates
      // slot, so it is the honest liveness probe: getMe ok → the failure is
      // a conflict/transient getUpdates issue, not an outage (reset the
      // counter, recover an open down state); getMe failed too → genuine
      // outage, counting proceeds below.
      const liveness = await getMe(token, { fetch: fetchFn });
      if (liveness.ok) {
        markTunnelUp();
        return {
          ok: false,
          error: res.error,
          fetched: 0,
          accepted: 0,
          rejected: 0,
          paused: 0,
          callbacks: 0,
          callbackRejected: 0,
          requeued: 0,
          retried,
          bootstrapped: [],
          offset: state.offset,
        };
      }
      consecutiveTunnelFailures++;
      if (res.error !== undefined) lastTunnelError = String(res.error);
      if (!tunnelDown && consecutiveTunnelFailures >= tunnelThreshold) {
        tunnelDown = true;
        emitTunnelStatus(
          "down",
          consecutiveTunnelFailures,
          lastTunnelError,
          formatTunnelDownMessage(consecutiveTunnelFailures, lastTunnelError),
        );
      } else {
        tunnelProbed = true;
      }
      return {
        ok: false,
        error: res.error,
        fetched: 0,
        accepted: 0,
        rejected: 0,
        paused: 0,
        callbacks: 0,
        callbackRejected: 0,
        requeued: 0,
        retried,
        bootstrapped: [],
        offset: state.offset,
      };
    }

    // Sustained getUpdates error just cleared: emit ONE info recovery line,
    // then reset the throttler so a later burst starts loud again.
    const errored = getUpdatesFailure.streak();
    if (errored > 0) {
      log(
        "info",
        `telegram getUpdates recovered after ${errored} error${errored === 1 ? "" : "s"}`,
      );
      getUpdatesFailure.reset();
    }

    // Watchdog tunnel recovery: a tunnel that was DOWN emits exactly one
    // "up" recovery event on its first successful poll; the counter resets
    // so the next outage starts counting from zero. While healthy, the
    // counter stays reset silently (no per-cycle output).
    markTunnelUp();

    let accepted = 0;
    let rejected = 0;
    let paused = 0;
    let callbacks = 0;
    let callbackRejected = 0;
    let requeued = 0;
    let maxBatchId = -1;
    const newlyBootstrapped: number[] = [];

    for (const update of res.updates) {
      maxBatchId = Math.max(maxBatchId, update.update_id);

      // Callback_query updates (inline-keyboard taps) are routed
      // to onCallbackQuery — NEVER to onOwnerMessage (they must not trigger a
      // turn). Only allow-listed senders may control; foreign taps are dropped
      // (offset still advances, confirm-on-read). No handler → dropped.
      if (update.callback_query) {
        const cq = update.callback_query as TelegramCallbackQuery;
        const from = cq?.from;
        if (onCallbackQuery && from && isAllowed(from, allowList)) {
          try {
            await onCallbackQuery(update);
            callbacks++;
          } catch (error) {
            requeued++;
            retryQueue.push({ update, attempts: 0, kind: "callback" });
            log(
              "warn",
              `telegram: callback handling failed for update ${update.update_id}: ${String(error)}`,
            );
            onError?.(error);
          }
        } else {
          callbackRejected++;
        }
        continue;
      }

      const verdict = classifyUpdate(
        update,
        allowList,
        allowList.length === 0 && bootstrap,
      );

      if (verdict === "owner" || verdict === "bootstrap") {
        if (verdict === "bootstrap") {
          const id = update.message?.from?.id;
          if (typeof id === "number" && !allowList.includes(id)) {
            allowList.push(id);
            bootstrapped.push(id);
            newlyBootstrapped.push(id);
            log(
              "info",
              `telegram: auto-allowed sender ${id} (first-message bootstrap)`,
            );
          }
        }
        const incoming = await extractIncomingMessage(update, mediaCtx);

        // Pause gate
        // NON-callback owner messages check the persisted pause flag BEFORE
        // injection. While paused the message is NOT forwarded (no
        // onOwnerMessage → no pi.sendUserMessage turn); the owner gets ONE
        // «⏸ пауза» ack per paused period (reply-storm guard), keyed on the
        // paused period's `updatedAt` so resume/re-pause transitions re-arm
        // it. Callback_query taps are NEVER gated — that is the resume path.
        const pause = await getPauseState();
        if (pause.paused) {
          paused++;
          if (pause.updatedAt !== pauseAckUpdatedAt) {
            pauseAckUpdatedAt = pause.updatedAt;
            const ack = await sendMessage(
              token,
              incoming.chatId,
              pauseAckText,
              {
                fetch: fetchFn,
              },
            );
            if (ack.ok) {
              log(
                "info",
                `telegram: paused — inbound from chat ${incoming.chatId} held; «⏸ пауза» ack sent (msg ${ack.messageId})`,
              );
            } else {
              log(
                "warn",
                `telegram: paused — inbound held; pause-ack send failed: ${ack.error ?? "unknown"}`,
              );
            }
          }
          log(
            "debug",
            `telegram: paused — message ${update.update_id} held (not delivered to the agent)`,
          );
          continue;
        }

        try {
          await onOwnerMessage(incoming);
          accepted++;
        } catch (error) {
          // Injection failed => keep the message in the retry buffer so it is
          // retried next cycle. The Telegram offset still advances (it is
          // monotonic and cannot skip an update without dropping it).
          requeued++;
          retryQueue.push({ update, attempts: 0, kind: "message" });
          log(
            "warn",
            `telegram: injection failed for update ${update.update_id}: ${String(error)}`,
          );
          onError?.(error);
        }
      } else {
        // non_message / non_private / non_text / foreign — drop and confirm.
        rejected++;
      }
    }

    // 3. Confirm-on-read: the whole batch was read, so advance the persisted
    // offset to max-seen + 1 (Telegram never redelivers it).
    if (maxBatchId >= 0 && maxBatchId + 1 > state.offset) {
      state.offset = maxBatchId + 1;
      try {
        await saveState(stateFile, state);
      } catch (error) {
        log("warn", `telegram: failed to persist offset: ${String(error)}`);
      }
    }

    return {
      ok: true,
      fetched: res.updates.length,
      accepted,
      rejected,
      paused,
      callbacks,
      callbackRejected,
      requeued,
      retried,
      bootstrapped: newlyBootstrapped,
      offset: state.offset,
    };
  }

  function tick(): void {
    if (!running) return;
    // Fire-and-forget: the chain's .finally() schedules the next tick, so no
    // handle needs to be retained (nothing reads it).
    void pollCycle()
      .catch((error) => {
        log("error", `telegram poll crash: ${String(error)}`);
        onError?.(error);
      })
      .finally(() => {
        if (running) {
          timer = setTimeout(tick, intervalMs);
        }
      });
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      log(
        "info",
        `telegram inbound poller started (allow-list: ${allowList.length}, state: ${stateFile}, interval: ${intervalMs}ms)`,
      );
      void readyPromise.then(() => {
        log("debug", `telegram: loaded persisted offset ${state.offset}`);
        tick();
      });
    },
    stop(): void {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      log("info", "telegram inbound poller stopped");
    },
    isRunning(): boolean {
      return running;
    },
    waitReady: () => readyPromise,
    pollOnce: pollCycle,
    getState: () => ({ ...state }),
    getTunnelStatus: () => {
      if (!tunnelProbed) return { status: "unknown", failures: 0 };
      return tunnelDown
        ? { status: "down", failures: consecutiveTunnelFailures }
        : { status: "up", failures: 0 };
    },
  };
}
