/**
 * voice.ts — shared inbound voice extraction (owner voice attachments).
 *
 * Both inbound consumers (background poller in inbound-poller.ts and the
 * agentic pull in telegram-inbox.ts) route accepted voice messages through
 * these helpers: resolve the single Telegram `Voice` object to a download
 * path via getFile, fetch the bytes, save them under the media dir, and
 * produce the agent-facing delivery text carrying the absolute path (or, on
 * failure, the file_id + an error note — never drop the message). The
 * transcript (when the caller has STT configured) is appended by the caller
 * via formatVoiceText's `transcript` / `transcriptError` options.
 *
 * Pure + injectable-fetch driven, mirroring photo.ts: `fetchFn` defaults to
 * globalThis.fetch, so tests substitute a recorded fixture fake with NO
 * network.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultMediaDir } from "./state-paths.js";
import {
  getFile,
  downloadFile,
  type TelegramFetch,
} from "./telegram-client.js";

/** A Telegram `Voice` object (single object, NOT an array — unlike photo). */
export interface TelegramVoice {
  file_id: string;
  file_unique_id?: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

/** True when a message carries a usable `voice` object (voice inbound). */
export function hasVoice(message: unknown): boolean {
  if (message == null || typeof message !== "object") return false;
  const voice = (message as { voice?: unknown }).voice;
  return (
    voice != null &&
    typeof voice === "object" &&
    typeof (voice as { file_id?: unknown }).file_id === "string"
  );
}

/** The voice note's file_id (or undefined when absent). */
export function getVoiceFileId(voice: unknown): string | undefined {
  if (voice == null || typeof voice !== "object") return undefined;
  const fileId = (voice as { file_id?: unknown }).file_id;
  return typeof fileId === "string" ? fileId : undefined;
}

/** Derive a safe short file extension from the Telegram file_path (fallback ogg). */
function extFromFilePath(filePath?: string): string {
  if (!filePath) return "ogg";
  const last = filePath.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot >= 0 && dot < last.length - 1) {
    const ext = last.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  }
  return "ogg"; // Telegram voice notes are OGG/Opus
}

/** Outcome of materializeVoice: saved path + bytes, or a degraded file_id + error. */
export type MaterializeVoiceResult =
  | {
      ok: true;
      fileId: string;
      filePath: string;
      filePathOnTelegram: string;
      bytes: Uint8Array;
    }
  | { ok: false; fileId: string; error: string };

/**
 * Download a voice note and save it to `<mediaDir>/<updateId>.<ext>`. Never
 * throws: a getFile / download / write failure returns
 * `{ ok: false, fileId, error }` so the caller can degrade instead of drop.
 * The saved bytes are returned so the caller can transcribe them.
 */
export async function materializeVoice(opts: {
  token: string;
  updateId: number;
  voice: TelegramVoice;
  fetchFn?: TelegramFetch;
  baseUrl?: string;
  mediaDir?: string;
}): Promise<MaterializeVoiceResult> {
  const {
    token,
    updateId,
    voice,
    fetchFn,
    baseUrl,
    mediaDir = defaultMediaDir(),
  } = opts;
  const fileId = voice.file_id;

  const fileInfo = await getFile(token, fileId, { fetch: fetchFn, baseUrl });
  const filePathOnTelegram = fileInfo.ok ? fileInfo.file?.file_path : undefined;
  if (!fileInfo.ok || !filePathOnTelegram) {
    return {
      ok: false,
      fileId,
      error: fileInfo.error ?? "getFile returned no file_path",
    };
  }

  const fileDownload = await downloadFile(token, filePathOnTelegram, {
    fetch: fetchFn,
    baseUrl,
  });
  if (!fileDownload.ok || !fileDownload.bytes) {
    return {
      ok: false,
      fileId,
      error: fileDownload.error ?? "file download failed",
    };
  }

  const dest = join(
    mediaDir,
    `${updateId}.${extFromFilePath(filePathOnTelegram)}`,
  );
  try {
    await mkdir(mediaDir, { recursive: true });
    await writeFile(dest, fileDownload.bytes);
  } catch (error) {
    return {
      ok: false,
      fileId,
      error: `failed to save ${dest}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ok: true,
    fileId,
    filePath: dest,
    filePathOnTelegram,
    bytes: fileDownload.bytes,
  };
}

/** Options for formatVoiceText — the agent-facing delivery string. */
export interface VoiceDeliveryTextOptions {
  /** Sender label, e.g. "@owner" or "id 123" (matches the whisper header). */
  senderLabel: string;
  /** Absolute path of the saved file (when the download succeeded). */
  filePath?: string;
  /** Telegram file_id (always present for a voice message). */
  fileId?: string;
  /** Message caption (trimmed), if any. */
  caption?: string;
  /** Download/save failure note (degraded delivery). */
  error?: string;
  /** Recognized transcript (quoted in the delivery string). */
  transcript?: string;
  /** Transcript failure/unavailability note (rendered after the caption). */
  transcriptError?: string;
}

/**
 * Build the delivered text the receiving agent can act on. Downloaded +
 * transcribed form:
 *   🎤 Voice from @owner: /abs/path.ogg (caption: none) (transcript: "hello")
 * Downloaded, no STT configured:
 *   🎤 Voice from @owner: /abs/path.ogg (caption: none) (transcript: unavailable — set BRAID_TG_STT_API_KEY)
 * Degraded (download failed) form — never dropped:
 *   🎤 Voice from @owner: file_id <id> (caption: none) (download failed: <error>)
 */
export function formatVoiceText(opts: VoiceDeliveryTextOptions): string {
  const captionPart = opts.caption
    ? ` (caption: ${opts.caption})`
    : " (caption: none)";
  let transcriptPart = "";
  if (opts.transcript) {
    transcriptPart = ` (transcript: "${opts.transcript}")`;
  } else if (opts.transcriptError) {
    transcriptPart = ` (transcript: ${opts.transcriptError})`;
  }
  if (opts.filePath) {
    return `🎤 Voice from ${opts.senderLabel}: ${opts.filePath}${captionPart}${transcriptPart}`;
  }
  const filePart = opts.fileId ? `file_id ${opts.fileId}` : "file_id unknown";
  const errorPart = opts.error ? ` (download failed: ${opts.error})` : "";
  return `🎤 Voice from ${opts.senderLabel}: ${filePart}${errorPart}${captionPart}`;
}
