/**
 * telegram-inbox.ts — agentic pull: `fetchInbox()` is the pure core behind
 * the `telegram_inbox` tool. The agent calls it mid-turn; it fetches pending
 * getUpdates, filters to the allow-list (owner chat), returns accepted
 * messages with `fromOwner` provenance, and confirms the offset (persisted
 * confirm-on-read). Dedup by `update_id` — no redelivery across calls within
 * a batch.
 *
 * Reuses the pure helpers from inbound-poller.ts (loadState/saveState,
 * classifyUpdate, extractIncomingMessage, IncomingOwnerMessage) so the agentic
 * path shares the same offset state file, dedup, allow-list logic, and photo
 * extraction as the background poller — no divergence.
 */

import { getUpdates, type TelegramFetch } from "./telegram-client.js";
import { defaultStateFilePath } from "./state-paths.js";
import {
  loadState,
  saveState,
  classifyUpdate,
  extractIncomingMessage,
  type IncomingOwnerMessage,
  type PollerState,
} from "./inbound-poller.js";
import type { SttConfig } from "./transcribe.js";
import { formatWhisperClock } from "./local-time.js";

/** One accepted message returned by fetchInbox. */
export interface InboxMessage {
  updateId: number;
  messageId: number;
  fromId: number;
  username?: string;
  firstName?: string;
  chatId: number;
  chatType: string;
  text: string;
  /** Present for photo messages (absent for plain-text). */
  photo?: IncomingOwnerMessage["photo"];
  /** Present for voice messages (absent for plain-text). */
  voice?: IncomingOwnerMessage["voice"];
  /** Present for document messages (absent for plain-text). */
  document?: IncomingOwnerMessage["document"];
  receivedAt: number;
  /** True when this sender is in the owner allow-list; only those may escalate. */
  fromOwner: boolean;
}

export interface FetchInboxResult {
  ok: boolean;
  error?: string;
  /** Messages accepted from the current batch (owner + foreign, if any). */
  messages: InboxMessage[];
  /** Total updates fetched this call. */
  fetched: number;
  /** Updates filtered out (non_message, non_private, non_text, foreign). */
  rejected: number;
  /** Current confirmed offset after this call. */
  offset: number;
}

export interface FetchInboxOptions {
  token: string;
  /** Allow-list of sender ids / @usernames (same as InboundPollerOptions). */
  allowedUsers: Array<number | string>;
  /** Path to the JSON state file for offset persistence. */
  stateFile?: string;
  /** Injectable fetch (tests use a recorded-fixture fake). */
  fetchFn?: TelegramFetch;
  /** Directory where downloaded photo/voice/document bytes are saved. Default ~/.pi/agent/telegram-media. */
  mediaDir?: string;
  /** STT (speech-to-text) config for voice transcription (optional). */
  stt?: SttConfig;
  /** Long-poll timeout in seconds (default 30). */
  timeout?: number;
  /** Optional logger; defaults to a no-op. */
  log?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    ...rest: unknown[]
  ) => void;
}

/**
 * Format one inbound message as the braid-whisper telegram envelope with
 * end-close marker. The envelope carries
 * unambiguous sender provenance (username/id, first_name when available),
 * chat identification, and the message's
 * SEND time as `@ HH:MM TZ` (from TelegramUpdate.date via receivedAt,
 * Owner TZ, mirrored core formatter): the agent can tell a fresh message
 * from one that sat in the queue.
 */
export function formatInboxMessage(msg: InboxMessage): string {
  const sender = msg.username ? `@${msg.username}` : `id ${msg.fromId}`;
  const name = msg.firstName ? ` (${msg.firstName})` : "";
  const sentClock = Number.isFinite(msg.receivedAt)
    ? ` @ ${formatWhisperClock(msg.receivedAt)}`
    : "";
  // The opening tag line carries nothing after `]`: the provenance line
  // starts on its own line so the envelope header is readable at a glance.
  const header = `[braid-whisper - telegram${sentClock}]\nfrom ${sender}${name} in chat ${msg.chatId}/${msg.chatType}`;
  return `${header}\n\n${msg.text}\n[braid-whisper-end]`;
}

export async function fetchInbox(
  options: FetchInboxOptions,
): Promise<FetchInboxResult> {
  const {
    token,
    allowedUsers,
    stateFile = defaultStateFilePath(),
    fetchFn = globalThis.fetch as TelegramFetch,
    mediaDir,
    timeout = 30,
    log = () => {},
  } = options;

  // 1. Load the persisted offset so we don't re-fetch confirmed messages.
  const state: PollerState = await loadState(stateFile);

  // 2. Long-poll one batch.
  const res = await getUpdates(token, state.offset, timeout, {
    fetch: fetchFn,
  });
  if (!res.ok) {
    log(
      "warn",
      `telegram_inbox: getUpdates failed (offset ${state.offset}): ${res.error ?? "unknown"}`,
    );
    return {
      ok: false,
      error: res.error ?? "getUpdates failed",
      messages: [],
      fetched: 0,
      rejected: 0,
      offset: state.offset,
    };
  }

  // 3. Classify each update: accept owner + foreign, drop non-message noise.
  const accepted: InboxMessage[] = [];
  let maxBatchId = state.offset - 1;
  let rejected = 0;

  for (const update of res.updates) {
    maxBatchId = Math.max(maxBatchId, update.update_id);
    const verdict = classifyUpdate(
      update,
      allowedUsers,
      false, // no bootstrap in agentic path — allow-list is explicit
    );

    if (verdict === "owner" || verdict === "foreign") {
      // Shared extraction (same as the background poller): photo messages are
      // downloaded to the media dir and delivered with the absolute path;
      // voice messages are downloaded and (when stt is configured)
      // transcribed, delivered with the transcript.
      const incoming = await extractIncomingMessage(update, {
        token,
        fetchFn,
        mediaDir,
        stt: options.stt,
      });
      accepted.push({
        ...incoming,
        fromOwner: verdict === "owner",
      });
    } else {
      rejected++;
    }
  }

  // 4. Confirm-on-read: advance offset to max-seen + 1. Dedup is inherent
  // because Telegram never redelivers the same update_id once confirmed.
  if (maxBatchId >= 0 && maxBatchId + 1 > state.offset) {
    state.offset = maxBatchId + 1;
    try {
      await saveState(stateFile, state);
    } catch (error) {
      log("warn", `telegram_inbox: failed to persist offset: ${String(error)}`);
    }
  }

  return {
    ok: true,
    messages: accepted,
    fetched: res.updates.length,
    rejected,
    offset: state.offset,
  };
}
