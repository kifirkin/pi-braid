// Offload recovery (offload_recover).
//
// The capture-time toolResult size cap flushes oversized results losslessly
// to disk. A result carrying images is downscaled and kept as an image; when
// the resize cannot fit (corrupt bytes, no image backend, a budget too small
// to matter) the result becomes a stub that carries no pixels, and the obvious
// recovery — reading the image back — produces another oversized result that
// the same cap handles again. This tool is the recovery seam the stub names:
// it reads a flush file and returns its image blocks, downscaled when needed
// to the same budget the cap downscales to, so a recovered view is a view and
// not another stub.
//
// The tool is registered deferred, so a session that never sees a stub never
// pays for it in the tool list. Producing a stub activates it additively
// (ensureOffloadRecoverTool): a stub whose recovery is one discovery step
// away is a recovery the model does not perform, which was measured on the
// incident the stub family exists for.
//
// The budget arithmetic keeps that promise: maxBytes in pi-core's resizeImage
// is compared against the base64 string length (the same unit
// estimateMessageChars counts for image data), the per-image target shrinks
// with every delivered image, and the assembled result is re-measured before
// it is returned. If nothing fits — corrupt bytes, no image backend, a
// budget too small to matter — the tool says so in text instead of emitting
// a result that would be stubbed again. The original always stays on disk.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { Type } from "typebox";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getToolResultSizeCapConfig } from "../../../../../lib/config/braid-settings.js";
import { offloadDir } from "../../../../../lib/config/braid-paths.js";
import {
  IMAGE_NOTE_MARGIN_CHARS,
  imageBudgetChars,
  recordImageRecovered,
} from "../image-policy.js";
import { log } from "../shared.js";

/** Longest flush path a note quotes before truncation. */
const MAX_NOTE_PATH_CHARS = 300;

interface ImageBlock {
  data: string;
  mimeType: string;
}

interface BlockLike {
  type?: unknown;
  data?: unknown;
  mimeType?: unknown;
}

function isImageBlock(b: unknown): b is ImageBlock {
  const block = b as BlockLike | undefined;
  return (
    !!block && typeof block === "object" && block.type === "image" && typeof block.data === "string"
  );
}

function clampPath(p: string): string {
  return p.length > MAX_NOTE_PATH_CHARS ? `${p.slice(0, MAX_NOTE_PATH_CHARS)}...` : p;
}

/**
 * Resolve the flush path the stub named. Only files inside the offload
 * directory are readable here: the agent supplies the path, so containment
 * is the security boundary. The root is resolved per call (offloadDir()) so
 * it is the same directory the flushes were written to under BRAID_HOME.
 */
function resolveRecoverablePath(requested: string): string | undefined {
  const root = resolve(offloadDir());
  const p = resolve(requested);
  if (p === root || p.startsWith(root + sep)) return p;
  return undefined;
}

function textResult(text: string, error = false): any {
  return {
    content: [{ type: "text" as const, text }],
    details: error ? { error: true } : { error: false },
  };
}

export const offloadRecoverSchema = Type.Object({
  path: Type.String({
    description: "Flush file path from an [offloaded ...] stub.",
  }),
  maxChars: Type.Optional(
    Type.Number({
      description:
        "Char budget override for the delivered image(s); clamped to the capture cap. Default: half the cap.",
    }),
  ),
});

/**
 * Register offload_recover. Deferred exposure like the other context-manager
 * tools: the stub is the discovery surface, this tool is the affordance it
 * names. The capture cap activates it when it produces a stub
 * (ensureOffloadRecoverTool), so the affordance is callable in the turn the
 * stub is read without costing a tool slot in a session that never stubs.
 */
export function registerOffloadRecover(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "offload_recover",
    exposure: "deferred",
    label: "Offload Recover",
    promptSnippet: "Recover an oversized result flushed to the offload directory",
    description:
      "Recover a tool result that was flushed to disk by an [offloaded ...] stub. " +
      "Returns the image blocks from the flush file; images over the context budget " +
      "are downscaled to fit (the lossless original stays on disk). Text-only flush " +
      "files are read with the read tool instead.",
    parameters: offloadRecoverSchema,
    execute: async (
      _toolCallId: string,
      params: { path?: unknown; maxChars?: unknown },
      _signal: unknown,
      _onUpdate: unknown,
      _ctx: unknown,
    ): Promise<any> => {
      const cfg = getToolResultSizeCapConfig();
      const cap = cfg.maxChars;

      const requested = typeof params?.path === "string" ? params.path : "";
      if (!requested)
        return textResult("offload_recover needs the flush file path from the stub.", true);
      if (!isAbsolute(requested)) {
        return textResult(`Refusing: ${clampPath(requested)} is not an absolute flush path.`, true);
      }
      const path = resolveRecoverablePath(requested);
      if (!path) {
        return textResult(
          `Refusing: ${clampPath(requested)} is outside the offload directory.`,
          true,
        );
      }

      const override =
        typeof params?.maxChars === "number" &&
        Number.isFinite(params.maxChars) &&
        params.maxChars >= 1
          ? Math.floor(params.maxChars)
          : undefined;
      // An override above the cap is clamped: a recovery result must never
      // trip the same cap it is recovering from.
      const effectiveBudget = Math.min(override ?? imageBudgetChars(cap), cap);
      const target = effectiveBudget - IMAGE_NOTE_MARGIN_CHARS;
      if (target < 1) {
        return textResult(
          `Budget too small to carry an image (braid.context.toolResultSizeCap.maxChars=${cap}).`,
          true,
        );
      }

      let raw: string;
      try {
        raw = readFileSync(path, "utf-8");
      } catch (err) {
        const code = (err as { code?: unknown })?.code ?? "unknown";
        return textResult(`Cannot read ${clampPath(path)} (${String(code)}).`, true);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return textResult(`${clampPath(path)} is not a flush file (JSON content array).`, true);
      }
      if (!Array.isArray(parsed)) {
        return textResult(`${clampPath(path)} is not a flush file (JSON content array).`, true);
      }

      const images = parsed.filter(isImageBlock);
      if (images.length === 0) {
        return textResult(
          `No image data in ${clampPath(path)}. If it holds text content, read it with the read tool.`,
        );
      }

      const notes: string[] = [];
      const deliveredBlocks: Array<Record<string, unknown>> = [];
      let used = 0;
      for (let i = 0; i < images.length; i++) {
        const block = images[i];
        const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image/png";
        const remaining = target - used;
        if (block.data.length <= remaining) {
          deliveredBlocks.push({ type: "image", data: block.data, mimeType });
          used += block.data.length;
          notes.push(`image ${i + 1}: delivered as-is (${mimeType}, ${block.data.length} chars)`);
          continue;
        }
        let view: Awaited<ReturnType<typeof resizeImage>>;
        try {
          view = await resizeImage(new Uint8Array(Buffer.from(block.data, "base64")), mimeType, {
            maxBytes: remaining,
          });
        } catch {
          view = null;
        }
        if (view && view.data.length <= remaining) {
          deliveredBlocks.push({ type: "image", data: view.data, mimeType: view.mimeType });
          used += view.data.length;
          notes.push(
            `image ${i + 1}: downscaled ${mimeType} ${view.originalWidth}x${view.originalHeight} -> ` +
              `${view.width}x${view.height} (${block.data.length} -> ${view.data.length} chars); original stays on disk`,
          );
        } else {
          notes.push(
            `image ${i + 1}: not recoverable under the remaining budget (${remaining} chars); original stays at ${clampPath(path)}`,
          );
        }
      }

      const delivered = deliveredBlocks.length;
      const note =
        (delivered > 0
          ? `Recovered ${delivered}/${images.length} image(s) from ${clampPath(path)}: `
          : `No image in ${clampPath(path)} fit the budget (${effectiveBudget} chars): `) +
        notes.join("; ");

      // Never re-offload: the assembled result is measured before it leaves.
      if (note.length + used > cap - IMAGE_NOTE_MARGIN_CHARS) {
        return textResult(
          `Recovery would exceed the cap; refusing. Original stays at ${clampPath(path)}.`,
          true,
        );
      }

      if (delivered > 0) recordImageRecovered(path);
      return {
        content: [{ type: "text" as const, text: note }, ...deliveredBlocks],
        details: {
          path,
          delivered,
          totalImages: images.length,
          budgetChars: effectiveBudget,
        },
      };
    },
  });
}

/** The tool a stub names; the name the activation below adds to the active set. */
const RECOVERY_TOOL_NAME = "offload_recover";

/**
 * Make the recovery callable in the turn its stub is read.
 *
 * Deferred exposure keeps the tool out of every request's tool list until it
 * is needed; a model that has to discover a tool mid-incident does not (the
 * reporting session called neither tool_search nor offload_recover). So the
 * production of the stub is the request for the recovery: this adds the tool
 * to the active set ONCE, additively, and returns whether it did.
 *
 * Additive by construction: the current set is the input, so whatever a tool
 * profile, the operator's `/tools` list or a sibling extension activated stays
 * active. Nothing is written when the runtime does not hold the tool, when the
 * active set is unreadable (an empty read must not replace the set), or when
 * the call throws (a failed activation must not take the tool_result down).
 */
export function ensureOffloadRecoverTool(pi: ExtensionAPI): boolean {
  try {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
      return false;
    }
    const active = pi.getActiveTools();
    if (!Array.isArray(active) || active.includes(RECOVERY_TOOL_NAME)) return false;
    const registered =
      typeof pi.getAllTools === "function"
        ? pi.getAllTools().some((tool) => tool?.name === RECOVERY_TOOL_NAME)
        : true;
    if (!registered) return false;
    pi.setActiveTools([...active, RECOVERY_TOOL_NAME]);
    log.info(`[offload-recover] activated "${RECOVERY_TOOL_NAME}" (an image stub is in context)`);
    return true;
  } catch (err) {
    log.warn("[offload-recover] recovery activation failed - the stub still names the tool", err);
    return false;
  }
}
