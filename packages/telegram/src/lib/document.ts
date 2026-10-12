/**
 * document.ts — shared inbound document extraction (owner file attachments).
 *
 * Both inbound consumers (background poller in inbound-poller.ts and the
 * agentic pull in telegram-inbox.ts) route accepted document messages through
 * these helpers: resolve the single Telegram `Document` object to a download
 * path via getFile, fetch the bytes, save them under the media dir, and
 * produce the agent-facing delivery text carrying the absolute path (or, on
 * failure, the file_id + an error note — never drop the message).
 *
 * A document message may additionally carry a caption (carried like the photo
 * caption). Unlike photos (a size-ordered variant array), a document is a
 * single object with a client-side `file_name` — the safe extension is derived
 * from `file_name` (never from the destination-affecting name itself: the
 * saved file is always `<mediaDir>/<update_id>.<safe-ext>`).
 *
 * Size guard: the Telegram Bot API getFile route refuses files above 20 MB —
 * when the declared file_size exceeds the limit, materializeDocument refuses
 * BEFORE any network call and surfaces the explicit reason (never silent,
 * never a crash, never a dropped message).
 *
 * Pure + injectable-fetch driven, mirroring photo.ts/voice.ts: `fetchFn`
 * defaults to globalThis.fetch, so tests substitute a recorded fixture fake
 * with NO network.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultMediaDir, warnUnderivableRoot } from "./state-paths.js";
import {
  getFile,
  downloadFile,
  type TelegramFetch,
} from "./telegram-client.js";

/** A Telegram `Document` object (single object, NOT an array — unlike photo). */
export interface TelegramDocument {
  file_id: string;
  file_unique_id?: string;
  /** Client-side file name as sent by the owner's client (may be hostile). */
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Telegram Bot API cap: getFile refuses files above 20 MB. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** True when a message carries a usable `document` object (document inbound). */
export function hasDocument(message: unknown): boolean {
  if (message == null || typeof message !== "object") return false;
  const document = (message as { document?: unknown }).document;
  return (
    document != null &&
    typeof document === "object" &&
    typeof (document as { file_id?: unknown }).file_id === "string"
  );
}

/** Derive a safe short file extension from the client-side file_name (fallback bin). */
export function safeExtFromFileName(fileName?: string): string {
  const fallback = "bin";
  if (!fileName) return fallback;
  // Strip path separators (both flavors) so a hostile name can never carry a
  // traversal chain: only the basename after the last separator is considered.
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const trimmed = base.trim();
  const dot = trimmed.lastIndexOf(".");
  // No extension, a dotfile (".bashrc" style), or a trailing dot — fallback.
  if (dot <= 0 || dot >= trimmed.length - 1) return fallback;
  const ext = trimmed.slice(dot + 1).toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  return fallback;
}

/** Outcome of materializeDocument: saved path, or a degraded file_id + error. */
export type MaterializeDocumentResult =
  | { ok: true; fileId: string; filePath: string; filePathOnTelegram: string }
  | { ok: false; fileId: string; error: string };

/**
 * Download a document and save it to `<mediaDir>/<updateId>.<safe-ext from
 * file_name>`. Never throws: an over-limit file_size (refused before any
 * network call), a getFile / download / write failure returns
 * `{ ok: false, fileId, error }` so the caller can degrade instead of drop.
 */
export async function materializeDocument(opts: {
  token: string;
  updateId: number;
  document: TelegramDocument;
  fetchFn?: TelegramFetch;
  baseUrl?: string;
  mediaDir?: string;
}): Promise<MaterializeDocumentResult> {
  const { token, updateId, document, fetchFn, baseUrl } = opts;
  const fileId = document.file_id;
  const mediaDir = opts.mediaDir ?? defaultMediaDir();
  if (mediaDir === null) {
    warnUnderivableRoot("document download refused");
    return {
      ok: false,
      fileId,
      error:
        "braid media directory is underivable (BRAID_HOME unset and no absolute home); document not saved",
    };
  }

  // Size guard: getFile refuses files above 20 MB — refuse BEFORE the network
  // call when the message declares an over-limit file_size.
  if (
    typeof document.file_size === "number" &&
    document.file_size > MAX_DOCUMENT_BYTES
  ) {
    return {
      ok: false,
      fileId,
      error: `file too large: ${document.file_size} bytes (Telegram Bot API limit is ${MAX_DOCUMENT_BYTES} bytes)`,
    };
  }

  const fileInfo = await getFile(token, fileId, { fetch: fetchFn, baseUrl });
  const filePathOnTelegram = fileInfo.ok ? fileInfo.file?.file_path : undefined;
  if (!fileInfo.ok || !filePathOnTelegram) {
    return {
      ok: false,
      fileId,
      error: fileInfo.error ?? "getFile returned no file_path",
    };
  }
  // getFile also reports the size — enforce the same guard on it (the message
  // may have omitted file_size).
  const reportedSize = fileInfo.file?.file_size;
  if (typeof reportedSize === "number" && reportedSize > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      fileId,
      error: `file too large: ${reportedSize} bytes (Telegram Bot API limit is ${MAX_DOCUMENT_BYTES} bytes)`,
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
    `${updateId}.${safeExtFromFileName(document.file_name)}`,
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

/** Options for formatDocumentText — the agent-facing delivery string. */
export interface DocumentDeliveryTextOptions {
  /** Sender label, e.g. "@owner" or "id 123" (matches the whisper header). */
  senderLabel: string;
  /** Absolute path of the saved file (when the download succeeded). */
  filePath?: string;
  /** Telegram file_id (always present for a document message). */
  fileId?: string;
  /** Original client-side file_name, when Telegram provided one. */
  name?: string;
  /** Message caption (trimmed), if any. */
  caption?: string;
  /** Download/save failure note (degraded delivery). */
  error?: string;
}

/**
 * Build the delivered text the receiving agent can act. Downloaded form:
 *   📄 Document from @owner: /abs/path.pdf (name: report.pdf) (caption: none)
 * Degraded (download failed or over-limit refused) form — never dropped:
 *   📄 Document from @owner: file_id <id> (name: report.pdf) (download failed: <error>) (caption: none)
 */
export function formatDocumentText(opts: DocumentDeliveryTextOptions): string {
  const namePart = opts.name ? ` (name: ${opts.name})` : "";
  const captionPart = opts.caption
    ? ` (caption: ${opts.caption})`
    : " (caption: none)";
  if (opts.filePath) {
    return `📄 Document from ${opts.senderLabel}: ${opts.filePath}${namePart}${captionPart}`;
  }
  const filePart = opts.fileId ? `file_id ${opts.fileId}` : "file_id unknown";
  const errorPart = opts.error ? ` (download failed: ${opts.error})` : "";
  return `📄 Document from ${opts.senderLabel}: ${filePart}${errorPart}${namePart}${captionPart}`;
}
