/**
 * photo.ts — shared inbound photo extraction (owner photo attachments).
 *
 * Both inbound consumers (background poller in inbound-poller.ts and the
 * agentic pull in telegram-inbox.ts) route accepted photo messages through
 * these helpers: pick the largest photo variant, resolve it to a download
 * path via getFile, fetch the bytes, save them under the media dir, and
 * produce the agent-facing delivery text carrying the absolute path (or, on
 * failure, the file_id + an error note — never drop the message).
 *
 * Pure + injectable-fetch driven, mirroring the client's test conventions:
 * `fetchFn` defaults to globalThis.fetch, so tests substitute a recorded
 * fixture fake with NO network.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultMediaDir } from "./state-paths.js";
import {
  getFile,
  downloadFile,
  type TelegramFetch,
} from "./telegram-client.js";

/** One element of a Telegram `photo` array (PhotoSize). */
export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

/** True when a message carries a non-empty `photo` array (photo inbound). */
export function hasPhoto(message: unknown): boolean {
  if (message == null || typeof message !== "object") return false;
  const photo = (message as { photo?: unknown }).photo;
  return Array.isArray(photo) && photo.length > 0;
}

/**
 * Pick the largest photo variant: the one with the greatest `file_size`, or
 * (when no sizes are present) the LAST array element — Telegram orders the
 * `photo` array by size ascending, so the last is the largest. Returns
 * undefined when no usable variant (with a file_id) exists.
 */
export function pickPhotoVariant(
  photo: unknown,
): TelegramPhotoSize | undefined {
  if (!Array.isArray(photo) || photo.length === 0) return undefined;
  const variants = photo.filter(
    (v): v is TelegramPhotoSize =>
      v != null &&
      typeof v === "object" &&
      typeof (v as { file_id?: unknown }).file_id === "string",
  );
  if (variants.length === 0) return undefined;
  let largest = variants[variants.length - 1];
  for (const v of variants) {
    if (
      typeof v.file_size === "number" &&
      v.file_size > (largest.file_size ?? 0)
    ) {
      largest = v;
    }
  }
  return largest;
}

/** Derive a safe short file extension from the Telegram file_path (fallback jpg). */
function extFromFilePath(filePath?: string): string {
  if (!filePath) return "jpg";
  const last = filePath.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot >= 0 && dot < last.length - 1) {
    const ext = last.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  }
  return "jpg"; // Telegram photos are JPEG
}

/** Outcome of materializePhoto: saved path, or a degraded file_id + error. */
export type MaterializePhotoResult =
  | { ok: true; fileId: string; filePath: string; filePathOnTelegram: string }
  | { ok: false; fileId: string; error: string };

/**
 * Download one photo variant and save it to `<mediaDir>/<updateId>.<ext>`.
 * Never throws: a getFile / download / write failure returns
 * `{ ok: false, fileId, error }` so the caller can degrade instead of drop.
 */
export async function materializePhoto(opts: {
  token: string;
  updateId: number;
  photo: TelegramPhotoSize;
  fetchFn?: TelegramFetch;
  baseUrl?: string;
  mediaDir?: string;
}): Promise<MaterializePhotoResult> {
  const {
    token,
    updateId,
    photo,
    fetchFn,
    baseUrl,
    mediaDir = defaultMediaDir(),
  } = opts;
  const fileId = photo.file_id;

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
  return { ok: true, fileId, filePath: dest, filePathOnTelegram };
}

/** Options for formatPhotoText — the agent-facing delivery string. */
export interface PhotoDeliveryTextOptions {
  /** Sender label, e.g. "@owner" or "id 123" (matches the whisper header). */
  senderLabel: string;
  /** Absolute path of the saved file (when the download succeeded). */
  filePath?: string;
  /** Telegram file_id (always present for a photo message). */
  fileId?: string;
  /** Message caption (trimmed), if any. */
  caption?: string;
  /** Download/save failure note (degraded delivery). */
  error?: string;
}

/**
 * Build the delivered text the receiving agent can act on. Downloaded form:
 *   📷 Photo from @owner: /abs/path.jpg (caption: <caption or none>)
 * Degraded (download failed) form — never dropped:
 *   📷 Photo from @owner: file_id <id> (caption: <caption or none>) (download failed: <error>)
 */
export function formatPhotoText(opts: PhotoDeliveryTextOptions): string {
  const captionPart = opts.caption
    ? ` (caption: ${opts.caption})`
    : " (caption: none)";
  if (opts.filePath) {
    return `📷 Photo from ${opts.senderLabel}: ${opts.filePath}${captionPart}`;
  }
  const filePart = opts.fileId ? `file_id ${opts.fileId}` : "file_id unknown";
  const errorPart = opts.error ? ` (download failed: ${opts.error})` : "";
  return `📷 Photo from ${opts.senderLabel}: ${filePart}${errorPart}${captionPart}`;
}
