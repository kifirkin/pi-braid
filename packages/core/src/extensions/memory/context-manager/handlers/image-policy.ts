// The image policy: what a picture costs, and for how long.
//
// Two measured failures define it. An oversized image result used to reach the
// model as a text stub whose recovery was a deferred tool the model never
// called; a picture that fit the cap used to ride in every request for the rest
// of the session (22 image blocks at 514,977 chars were still in the prompt at
// the last turn of a seven-hour one, every screenshot already a file on disk).
//
// The answer is one policy, owned here:
//
//   cost - an image may occupy at most half of a result cap. The capture cap
//          downscales to that share instead of stubbing, and the recovery tool
//          resizes to the same share, so both ends of the loop agree on what a
//          picture may spend.
//   age  - an image older than the owner's threshold becomes a pointer to the
//          file it came from, and only when the file's bytes are on disk.
//          Re-reading the file is the way back, so the replacement is lossless
//          by construction.
//
// The counters below are the measurement the next reader starts from: the
// context report renders them, and a session that stubs or ages images can be
// counted instead of read out of a transcript.

import { statSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Chars held back from an image budget for the note that goes with a picture. */
export const IMAGE_NOTE_MARGIN_CHARS = 1024;

/** The share of a result cap an image may occupy. */
const IMAGE_BUDGET_DIVISOR = 2;

/**
 * The image share of a result cap in chars: half the cap. A consumer subtracts
 * IMAGE_NOTE_MARGIN_CHARS for its own note, and the capture cap subtracts the
 * text blocks measured in the same result, so the assembled content stays under
 * the cap it is measured against.
 */
export function imageBudgetChars(capChars: number): number {
  if (!Number.isFinite(capChars) || capChars < 1) return 0;
  return Math.floor(capChars / IMAGE_BUDGET_DIVISOR);
}

// ── Counters ─────────────────────────────────────────────────────────────────

export interface ImagePolicyHealth {
  /** Images downscaled at capture and kept as images. */
  imagesDownscaled: number;
  /** Results replaced by an image stub because no view fit the cap. */
  imagesStubbed: number;
  /** Image blocks replaced by a path block because of their age. */
  imagesAged: number;
  /** Stub flush files recorded and not recovered since (process lifetime). */
  imagesUnrecovered: number;
}

const health = { imagesDownscaled: 0, imagesStubbed: 0, imagesAged: 0 };

/** Flush files an image stub named and no offload_recover call has answered. */
const pendingStubPaths = new Set<string>();

/** toolCallIds whose images were already counted as aged (one count per image set). */
const agedToolCallIds = new Set<string>();

/** An image was downscaled at capture, so the model kept a picture. */
export function recordImageDownscaled(count = 1): void {
  if (Number.isFinite(count) && count > 0) health.imagesDownscaled += count;
}

/** A result became an image stub: the flush file is an open obligation. */
export function recordImageStub(storedPath: string): void {
  health.imagesStubbed++;
  if (storedPath) pendingStubPaths.add(storedPath);
}

/** offload_recover delivered image bytes from this flush file. */
export function recordImageRecovered(storedPath: string): void {
  pendingStubPaths.delete(storedPath);
}

/** Images were replaced by path blocks (counted once per tool result). */
export function recordImagesAged(toolCallIds: readonly string[]): void {
  for (const id of toolCallIds) {
    if (!id || agedToolCallIds.has(id)) continue;
    agedToolCallIds.add(id);
    health.imagesAged++;
  }
}

export function getImagePolicyHealth(): ImagePolicyHealth {
  return { ...health, imagesUnrecovered: pendingStubPaths.size };
}

/** Reset every counter. Tests and session-start resets only. */
export function resetImagePolicyHealth(): void {
  health.imagesDownscaled = 0;
  health.imagesStubbed = 0;
  health.imagesAged = 0;
  pendingStubPaths.clear();
  agedToolCallIds.clear();
}

/** The report line, or undefined when no image work happened in this process. */
export function formatImagePolicyLine(): string | undefined {
  const h = getImagePolicyHealth();
  if (h.imagesDownscaled + h.imagesStubbed + h.imagesAged === 0 && h.imagesUnrecovered === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (h.imagesDownscaled > 0) parts.push(`${h.imagesDownscaled} downscaled`);
  if (h.imagesStubbed > 0) parts.push(`${h.imagesStubbed} stubbed`);
  if (h.imagesAged > 0) parts.push(`${h.imagesAged} aged`);
  if (h.imagesUnrecovered > 0) parts.push(`${h.imagesUnrecovered} unrecovered`);
  return parts.join(", ");
}

// ── Where an image came from ─────────────────────────────────────────────────

/** Tool-input keys whose string value names the file the result displays. */
const IMAGE_SOURCE_KEYS = ["path", "file", "filePath", "filename", "image_path", "imagePath"];

/** Extensions a plain `read` of the path returns as an image block. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/**
 * The path a result's image came from, when the tool call names one braid can
 * name back: absolute, with an image extension. A relative path is refused
 * because the cwd it resolved against at call time is not recoverable here, and
 * a wrong pointer is worse than an image left in place.
 */
export function resolveImageSourcePath(input: unknown): string | undefined {
  if (input == null || typeof input !== "object") return undefined;
  for (const key of IMAGE_SOURCE_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) continue;
    if (!isAbsolute(value)) continue;
    if (!IMAGE_EXTENSIONS.has(extname(value).toLowerCase())) continue;
    return value;
  }
  return undefined;
}

/** A file with bytes behind it; the only thing an aged block may point at. */
function fileHasBytes(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

// ── Ageing ───────────────────────────────────────────────────────────────────

/** The resolved braid.context.imageAge rule, as this module consumes it. */
export interface ImageAgeRule {
  enabled: boolean;
  /** Tool results after which an image block becomes a pointer to its file. */
  turns: number;
}

export interface AgedImageReplacement {
  /** Position in the scanned message array. */
  index: number;
  toolCallId: string;
  /** The file the result's images came from. */
  path: string;
  /** Image blocks in this message. */
  images: number;
  /** Base64 chars the replacement frees. */
  chars: number;
  /** The pointer block that stands in for the pixels. */
  text: string;
}

export interface ImageAgeResult {
  /** A new array when anything was replaced; the input array otherwise. */
  messages: AgentMessage[];
  plan: AgedImageReplacement[];
}

/**
 * The pointer that replaces the pixels. Stable across requests (the threshold,
 * not the drifted age, is in the text) so a per-request view does not rewrite
 * the same block on every call.
 */
function pointerText(path: string, mimeType: string, dataChars: number, turns: number): string {
  return `[image omitted after ${turns} turns: ${path} (${mimeType}, ${dataChars} chars) - read("${path}") shows it again]`;
}

/** Image blocks of one toolResult content, with their total base64 chars. */
function imageSummary(content: unknown): { images: number; dataChars: number; mimeType: string } {
  let images = 0;
  let dataChars = 0;
  let mimeType = "image/unknown";
  if (!Array.isArray(content)) return { images, dataChars, mimeType };
  for (const block of content) {
    const b = block as { type?: unknown; data?: unknown; mimeType?: unknown } | undefined;
    if (!b || typeof b !== "object" || b.type !== "image" || typeof b.data !== "string") continue;
    images++;
    dataChars += b.data.length;
    if (typeof b.mimeType === "string" && mimeType === "image/unknown") mimeType = b.mimeType;
  }
  return { images, dataChars, mimeType };
}

/**
 * Deterministic planning pass over the per-request context. Age is measured in
 * toolResult rank from the end (0 = most recent tool result), the same unit as
 * braid.context.staleToolResultOffload: a unit that does not move with the
 * whispers and steers that make user-message counting drift.
 *
 * Eligibility (ALL required):
 *   - the message is a toolResult holding at least one image block;
 *   - age >= rule.turns;
 *   - the tool call that produced it names an absolute image path;
 *   - that file exists, is a regular file, and has bytes behind it.
 *
 * An image whose producing call is no longer in context (a compaction replaced
 * it with a summary) has no path to name, so it stays. That is the one case
 * where a long-lived image survives the rule, and it is deliberate: a pointer
 * to a wrong file is worse than a picture without one.
 */
export function planAgedImages(
  messages: readonly AgentMessage[],
  rule: ImageAgeRule,
  exists: (path: string) => boolean = fileHasBytes,
): AgedImageReplacement[] {
  if (!rule.enabled || !Number.isFinite(rule.turns) || rule.turns < 1) return [];

  // toolCallId -> source path, from the assistant call that asked for the result.
  const sourceByCallId = new Map<string, string>();
  for (const msg of messages) {
    const content = (msg as { content?: unknown } | undefined)?.content;
    if ((msg as { role?: string })?.role !== "assistant" || !Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: unknown; id?: unknown; arguments?: unknown } | undefined;
      if (!b || typeof b !== "object" || b.type !== "toolCall" || typeof b.id !== "string")
        continue;
      const path = resolveImageSourcePath(b.arguments);
      if (path) sourceByCallId.set(b.id, path);
    }
  }

  const ranks = new Map<number, number>();
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: string } | undefined)?.role === "toolResult") {
      ranks.set(i, seen);
      seen++;
    }
  }

  const plan: AgedImageReplacement[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as
      | { role?: string; toolCallId?: unknown; content?: unknown }
      | undefined;
    if (msg?.role !== "toolResult") continue;
    const age = ranks.get(i) ?? 0;
    if (age < rule.turns) continue;
    const summary = imageSummary(msg.content);
    if (summary.images === 0) continue;
    if (typeof msg.toolCallId !== "string" || msg.toolCallId.length === 0) continue;
    const path = sourceByCallId.get(msg.toolCallId);
    if (!path) continue;
    if (!exists(path)) continue;
    plan.push({
      index: i,
      toolCallId: msg.toolCallId,
      path,
      images: summary.images,
      chars: summary.dataChars,
      text: pointerText(path, summary.mimeType, summary.dataChars, rule.turns),
    });
  }
  return plan;
}

/**
 * Replace each planned message's image blocks with the pointer, in the
 * position the first image sat. Every other block and every other toolResult
 * field (toolCallId pairing, isError, timestamp, details) is preserved, and
 * the input array is never mutated.
 */
export function applyAgedImages(
  messages: readonly AgentMessage[],
  plan: readonly AgedImageReplacement[],
): AgentMessage[] {
  if (plan.length === 0) return messages as AgentMessage[];
  const output = [...messages];
  for (const item of plan) {
    const msg = output[item.index] as Record<string, unknown> | undefined;
    if (!msg || msg.role !== "toolResult" || !Array.isArray(msg.content)) continue;
    const blocks = msg.content as Array<Record<string, unknown>>;
    const replaced: Array<Record<string, unknown>> = [];
    let placed = false;
    for (const block of blocks) {
      if (block && typeof block === "object" && block.type === "image") {
        if (!placed) {
          replaced.push({ type: "text", text: item.text });
          placed = true;
        }
        continue;
      }
      replaced.push(block);
    }
    output[item.index] = { ...msg, content: replaced } as unknown as AgentMessage;
  }
  return output;
}

/** Plan, count, apply: the one call the per-request handler makes. */
export function ageImageBlocks(
  messages: readonly AgentMessage[],
  rule: ImageAgeRule,
  exists: (path: string) => boolean = fileHasBytes,
): ImageAgeResult {
  const plan = planAgedImages(messages, rule, exists);
  if (plan.length === 0) return { messages: messages as AgentMessage[], plan };
  recordImagesAged(plan.map((item) => item.toolCallId));
  return { messages: applyAgedImages(messages, plan), plan };
}
