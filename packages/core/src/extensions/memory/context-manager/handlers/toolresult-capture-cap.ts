// Capture-time toolResult size cap.
//
// Oversized toolResults (screenshot/base64-class payloads) poison every
// subsequent provider request once they enter the session. This cap defends
// at CAPTURE time:
// when a tool finishes and its result is about to be stored, a result whose
// content exceeds braid.context.toolResultSizeCap.maxChars (default 256KB,
// default ON) is flushed LOSSLESSLY to disk (JSON — text and images) and the
// stored entry carries a stub pointing at the flush file, with the first
// ~500 chars inline for text so the agent retains an orientation hint.
//
// Mechanism (verified against installed pi-coding-agent 0.82.1):
// AgentSession._installAgentToolHooks → agent.afterToolCall →
// ExtensionRunner.emitToolResult — a `tool_result` handler's returned
// { content } REPLACES the stored toolResult content before it is appended
// to the session. Lossless: full original content is on disk BEFORE the stub
// replaces it; a failed flush leaves the original untouched (never stub
// without a verified flush).
//
// This is the per-entry complement to the stale offloader (age-based,
// default OFF, per-request view) and the error-driven emergency offloader:
// the cap keeps the poison from entering at all.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getToolResultSizeCapConfig } from "../../../../lib/config/braid-settings.js";
import { getOffloadFilePath } from "../../../../lib/config/braid-paths.js";
import { log } from "./shared.js";
import { estimateMessageChars, EMERGENCY_STUB_INLINE_CHARS } from "./context-emergency.js";

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

/**
 * Build the brief-format stub: `[offloaded: <tool> result, N bytes — flushed
 * to disk: <path>]` plus the first ~500 chars for text content, or an
 * explicit non-text marker (image mime + data size) so a stubbed screenshot
 * is recognizable as a screenshot. Image stubs name the recovery invocation
 * (offload_recover on the flush path): reading the image back would hit this
 * same cap and loop forever. A producer file path from the tool input is
 * appended when present.
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
      return { content: [{ type: "text" as const, text: stub }] };
    } catch (err) {
      log.warn("[capture-cap] capture cap failed — result untouched", err);
      return undefined;
    }
  });
}
