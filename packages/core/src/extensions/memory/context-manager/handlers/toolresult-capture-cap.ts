// Capture-time toolResult size cap.
//
// Oversized toolResults (screenshot/base64-class payloads) poison every
// subsequent provider request once they enter the session. This cap defends
// at CAPTURE time:
// when a tool finishes and its result is about to be stored, a result whose
// content exceeds braid.context.toolResultSizeCap.maxChars (default 256KB,
// default ON) is flushed LOSSLESSLY to disk (JSON — text and images).
//
// What the stored entry becomes depends on what the result carries:
//   - a result with image blocks is DOWNSCALED to the image share of the cap
//     and stays an image, with a dimension note when the resize moved the
//     pixels and a line naming the flush file that holds the full original.
//     A picture the model can see beats a pointer it never follows;
//   - a text result, or an image whose resize cannot fit (corrupt bytes, no
//     image backend, a budget too small to matter), becomes a stub pointing at
//     the flush file with the first ~500 chars inline for text. An image stub
//     also records what it replaced in `details` and makes the recovery tool
//     callable, so an unrecovered image is something a caller can count.
//
// Mechanism (verified against installed pi-coding-agent 0.82.1):
// AgentSession._installAgentToolHooks → agent.afterToolCall →
// ExtensionRunner.emitToolResult — a `tool_result` handler's returned
// { content, details } REPLACES the stored toolResult content and details
// before it is appended to the session. Lossless: the full original content is
// on disk BEFORE either substitution; a failed flush leaves the original
// untouched (never substitute without a verified flush).
//
// This is the per-entry complement to the stale offloader (age-based, default
// OFF, per-request view) and the error-driven emergency offloader: the cap
// keeps the poison from entering at all.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getToolResultSizeCapConfig } from "../../../../lib/config/braid-settings.js";
import { getOffloadFilePath } from "../../../../lib/config/braid-paths.js";
import { log } from "./shared.js";
import { estimateMessageChars, EMERGENCY_STUB_INLINE_CHARS } from "./context-emergency.js";
import {
  IMAGE_NOTE_MARGIN_CHARS,
  imageBudgetChars,
  recordImageDownscaled,
  recordImageStub,
} from "./image-policy.js";
import { ensureOffloadRecoverTool } from "./tools/offload-recover.js";

/** Same stub family — every offloader recognizes every other's stubs. */
export const CAPTURE_CAP_STUB_PREFIX = "[offloaded:";

/** Keys whose string value names the file that likely produced the result. */
const SOURCE_HINT_KEYS = ["path", "file", "filePath", "filename", "image_path", "imagePath"];

/**
 * Best-effort producer hint from the tool call input: the flush path in the
 * stub already tells the agent where the FULL result lives; this adds where
 * a smaller re-derivation would come from. Absent when the input names no
 * file — never fabricated.
 */
function extractSourcePath(input: unknown): string | undefined {
  if (input == null || typeof input !== "object") return undefined;
  for (const key of SOURCE_HINT_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 500) return value;
  }
  return undefined;
}

/** Already-stubbed content (this cap or either offloader) is left alone. */
function isStubbed(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  const first = content[0] as { type?: string; text?: unknown } | undefined;
  return (
    first?.type === "text" &&
    typeof first.text === "string" &&
    first.text.startsWith(CAPTURE_CAP_STUB_PREFIX)
  );
}

interface ImageBlockLike {
  type: "image";
  data: string;
  mimeType?: string;
}

function isImageBlock(block: unknown): block is ImageBlockLike {
  const b = block as { type?: unknown; data?: unknown } | undefined;
  return !!b && typeof b === "object" && b.type === "image" && typeof b.data === "string";
}

/**
 * Chars a tool result spends on blocks other than images, measured the way the
 * cap measures the whole content (text length; JSON for unknown block types).
 */
function nonImageChars(content: readonly unknown[]): number {
  let total = 0;
  for (const block of content) {
    if (isImageBlock(block)) continue;
    total += estimateMessageChars([block]);
  }
  return total;
}

/**
 * Downscale every image block of an oversized result into the image share of
 * the cap. Returns undefined when the result cannot be delivered as images
 * under the cap (no image block, bytes the resizer refuses, a budget too small
 * to matter); the caller then falls back to the stub, which is the lossless
 * path. The full original is already on disk at `storedPath`.
 */
export async function downscaleImageContent(
  content: readonly unknown[],
  capChars: number,
  storedPath: string,
): Promise<Array<TextContent | ImageContent> | undefined> {
  const budget = imageBudgetChars(capChars) - IMAGE_NOTE_MARGIN_CHARS - nonImageChars(content);
  if (budget < 1) return undefined;

  const out: Array<TextContent | ImageContent> = [];
  let remaining = budget;
  let downscaled = 0;
  for (const block of content) {
    if (!isImageBlock(block)) {
      out.push(block as TextContent);
      continue;
    }
    const sourceMime = typeof block.mimeType === "string" ? block.mimeType : "image/png";
    let data = block.data;
    let mimeType = sourceMime;
    let note: string | undefined;
    if (data.length > remaining) {
      let view: Awaited<ReturnType<typeof resizeImage>>;
      try {
        view = await resizeImage(new Uint8Array(Buffer.from(data, "base64")), sourceMime, {
          maxBytes: remaining,
        });
      } catch {
        view = null;
      }
      if (!view || typeof view.data !== "string" || view.data.length > remaining) return undefined;
      data = view.data;
      mimeType = view.mimeType;
      // Only a resize that moved the pixels changes the coordinate mapping.
      if (view.width !== view.originalWidth || view.height !== view.originalHeight) {
        note = formatDimensionNote(view);
      }
      downscaled++;
    }
    out.push({ type: "image", data, mimeType });
    remaining -= data.length;
    if (note) {
      out.push({ type: "text", text: note });
      remaining -= note.length;
    }
  }
  if (downscaled === 0) return undefined;

  const fullOriginal = `[downscaled to fit the context cap; full original: ${storedPath}]`;
  out.push({ type: "text", text: fullOriginal });
  remaining -= fullOriginal.length;
  if (remaining < 0 || estimateMessageChars(out) > capChars) return undefined;
  return out;
}

/**
 * The structured record a forced image stub leaves on the tool result, so an
 * unrecovered image is countable instead of a sentence in a transcript.
 * Absent for a result holding no image block.
 */
function imageStubDetails(
  content: readonly unknown[],
  storedPath: string,
): { kind: "image"; mimeType: string; dataLength: number; storedPath: string } | undefined {
  let images = 0;
  let dataLength = 0;
  let mimeType = "image/unknown";
  for (const block of content) {
    if (!isImageBlock(block)) continue;
    images++;
    dataLength += block.data.length;
    if (typeof block.mimeType === "string" && mimeType === "image/unknown")
      mimeType = block.mimeType;
  }
  if (images === 0) return undefined;
  return { kind: "image", mimeType, dataLength, storedPath };
}

/**
 * Build the brief-format stub: `[offloaded: <tool> result, N bytes — flushed
 * to disk: <path>]` plus the first ~500 chars for text content, or an
 * explicit non-text marker (image mime + data size) so a stubbed screenshot
 * is recognizable as a screenshot. Image stubs name the recovery invocation
 * (offload_recover on the flush path): reading the image back would hit this
 * same cap. A producer file path from the tool input is appended when present.
 */
export function buildCaptureStub(
  toolName: string,
  bytes: number,
  path: string,
  content: unknown,
  iso: string,
  source?: string,
): string {
  let stub = `[offloaded: ${toolName} result, ${bytes} bytes, ${iso} — flushed to disk: ${path}]`;
  let inlineDone = false;
  let imageMarker: string | undefined;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as
        | { type?: string; text?: unknown; data?: unknown; mimeType?: unknown }
        | undefined;
      if (!b || typeof b !== "object") continue;
      if (!inlineDone && b.type === "text" && typeof b.text === "string") {
        const head = b.text.slice(0, EMERGENCY_STUB_INLINE_CHARS);
        if (head) stub += `\n[first ${head.length} chars: ${head}]`;
        inlineDone = true;
      } else if (!imageMarker && b.type === "image") {
        const mime = typeof b.mimeType === "string" ? b.mimeType : "unknown";
        const dataLen = typeof b.data === "string" ? b.data.length : 0;
        imageMarker = `[non-text content: image ${mime}, ${dataLen} chars of data]`;
      }
    }
  }
  if (imageMarker) {
    stub += `\n${imageMarker}`;
    stub += `\nrecover: offload_recover("${path}") returns the image(s) downscaled to fit the context budget; the original stays on disk`;
  } else if (!inlineDone && Array.isArray(content) && content.length > 0) {
    const first = content[0] as { type?: string } | undefined;
    if (first?.type) stub += `\n[non-text content: ${String(first.type)}]`;
  }
  if (source) stub += `\nsource: ${source}`;
  return stub;
}

/**
 * Register the capture-time cap on the `tool_result` event. Reads the
 * setting FRESH on every call; when the cap is OFF (or the result is under
 * it, or already stubbed) the handler returns undefined — provably zero
 * behavior change. Never throws into pi's event pipeline.
 */
export function registerToolResultCaptureCap(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event: any, ctx: any) => {
    try {
      const cfg = getToolResultSizeCapConfig();
      if (!cfg.enabled) return undefined;

      const content = event?.content;
      if (content == null || isStubbed(content)) return undefined;
      const chars = estimateMessageChars(content);
      if (chars <= cfg.maxChars) return undefined;

      const sessionId =
        (
          ctx as { sessionManager?: { getSessionId?: () => string } }
        )?.sessionManager?.getSessionId?.() ?? "anonymous";
      const toolCallId = String(event.toolCallId ?? "unknown");
      const toolName = String(event.toolName ?? "unknown");
      const path = getOffloadFilePath(sessionId, toolCallId, toolName);

      let contentJson: string;
      try {
        contentJson = JSON.stringify(content ?? []);
      } catch {
        return undefined; // unserializable result — cannot flush losslessly
      }
      try {
        if (!existsSync(path)) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, contentJson, "utf-8");
        }
      } catch {
        log.error(
          `[capture-cap] flush failed for ${toolName} result (${chars} chars) — ` +
            `original kept in context (lossless wins over cap): ${path}`,
        );
        return undefined;
      }

      // An image result keeps its pixels when they fit the image share of the
      // cap: a downscaled picture is what the model can actually use.
      if (Array.isArray(content) && content.some(isImageBlock)) {
        const downscaled = await downscaleImageContent(content, cfg.maxChars, path);
        if (downscaled) {
          recordImageDownscaled(downscaled.filter(isImageBlock).length);
          log.info(
            `[capture-cap] oversized ${toolName} result (${chars} chars > cap ${cfg.maxChars}): ` +
              `images downscaled to fit (${estimateMessageChars(downscaled)} chars), ` +
              `full original flushed to ${path}.`,
          );
          // pi-core stores the handler's details verbatim when it returns one,
          // so an image result keeps the tool's own details by naming them.
          return { content: downscaled, details: event?.details };
        }
      }

      const bytes = Buffer.byteLength(contentJson, "utf-8");
      const stub = buildCaptureStub(
        toolName,
        bytes,
        path,
        content,
        new Date().toISOString(),
        extractSourcePath(event?.input),
      );
      log.info(
        `[capture-cap] oversized ${toolName} result (${chars} chars > cap ${cfg.maxChars}) ` +
          `captured: full content flushed to ${path}, stub stored instead.`,
      );
      // Replace the stored content — the oversized blob never enters context.
      const record = imageStubDetails(Array.isArray(content) ? content : [], path);
      if (record) {
        recordImageStub(path);
        // A stub names a recovery the model must be able to perform in the
        // turn it reads the stub: activation is additive and cheap (a name
        // comparison) in every request that is not recovering an image.
        ensureOffloadRecoverTool(pi);
        const original =
          event?.details && typeof event.details === "object" && !Array.isArray(event.details)
            ? (event.details as Record<string, unknown>)
            : {};
        return {
          content: [{ type: "text" as const, text: stub }],
          details: { ...original, ...record },
        };
      }
      return { content: [{ type: "text" as const, text: stub }] };
    } catch (err) {
      log.warn("[capture-cap] capture cap failed — result untouched", err);
      return undefined;
    }
  });
}
