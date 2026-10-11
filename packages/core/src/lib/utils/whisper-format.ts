/**
 * Whisper Envelope - Universal prefix for system-injected messages.
 *
 * Every message sent via `sendTrackedMessage` is wrapped with a
 * `[braid-whisper - <subsystem> @ <time>]` envelope and closed with an
 * explicit `[braid-whisper-end]` end-marker so the agent can reliably
 * distinguish system-injected signals from human user input, can
 * unambiguously detect where a (possibly multiline) whisper body ends,
 * and can tell a fresh whisper from a stale re-injection (header clock).
 *
 * The envelope AND the end-marker are added centrally in
 * `sendTrackedMessage` (the trunk) so all 30+ call sites automatically
 * benefit without per-site changes.
 *
 * The subsystem is derived from the source path's first segment
 * (e.g. "enforcement/whisper" -> "enforcement",
 *       "memory/context-manager" -> "memory",
 *       "cognitive/sycophancy-detector" -> "cognitive").
 *
 * The full source is preserved in the message metadata
 * (`details._braidSource`) for debugging and analytics.
 *
 * Filters: the subsystem name is a substring of the envelope
 * ("enforcement" matches "[braid-whisper - enforcement]"), so bare-name
 * filters keep working; bracket-prefix filters
 * (`grep '\[enforcement\]'`) need the canonical form
 * `grep '\[braid-whisper - enforcement\]'`. Body-level sub-tags
 * (`[<subsystem>-<event>]`) can still be added inside the message body
 * as a second filter level - the envelope is one level above them.
 */

import { formatWhisperClock, nowOrOverride } from "./local-time.js";

/**
 * Format the universal envelope line for a given source.
 * Returns "[braid-whisper - <subsystem> @ 17:05 MSK]" with no trailing
 * whitespace.
 *
 * The subsystem is the first segment of the source path. If the source
 * is empty or has no "/", the literal "system" is used as the fallback.
 *
 * The `@ HH:MM TZ` timestamp is the
 * generation time in the owner time zone (lib/utils/local-time.ts) — it
 * lets the agent tell a fresh whisper from a stale re-injection. It is
 * rendered by the ONE formatter (formatWhisperClock) so whisper headers
 * and body time strings never diverge.
 *
 * @param source source path; first segment becomes the subsystem tag
 * @param now clock instant (default now; test hook setLocalTimeClockForTests
 *               pins it for deterministic assertions)
 */
export function formatWhisperEnvelope(source: string, now: Date = nowOrOverride()): string {
  const subsystem = source.split("/")[0] || "system";
  return `[braid-whisper - ${subsystem} @ ${formatWhisperClock(now)}]`;
}

/**
 * Format the explicit end-marker that closes every braid whisper.
 * Returns "[braid-whisper-end]" with no trailing whitespace.
 *
 * The marker is delivered as its own final text element (see
 * applyWhisperEnvelope) so a multiline whisper body has an
 * unambiguous end boundary even when the body itself spans
 * several lines.
 */
export function formatWhisperEndMarker(): string {
  return "[braid-whisper-end]";
}

/**
 * Apply the universal envelope to a content array in place.
 * Prepends the envelope line (with `@ HH:MM TZ` generation timestamp) to the
 * first text element, separated by `\n` so the opening tag line carries
 * nothing after `]` and the body starts on the next line. If no text element
 * exists, a new text element is prepended. Always appends a final
 * `[braid-whisper-end]` marker as the LAST text element so every whisper has
 * an unambiguous end boundary.
 *
 * The end-marker is added as a separate trailing text element (rather
 * than being appended inside the last element's text) so the envelope
 * prefix on the first element is never clobbered and the marker always
 * lands on its own line when pi renders multi-part text content.
 *
 * Mutates the input array. This is acceptable because all callers
 * create the content array inline and do not reuse it after delivery.
 *
 * @param content message content array (mutated in place)
 * @param source source path; first segment becomes the subsystem tag
 * @param now clock instant for the header timestamp (default now;
 *                test hook pins it)
 *
 * Example:
 *   Input: [{ type: "text", text: "Error burst detected" }]
 *   Source: "enforcement/whisper"
 *   After: [
 *     { type: "text", text: "[braid-whisper - enforcement @ 17:05 MSK]\nError burst detected" },
 *     { type: "text", text: "[braid-whisper-end]" },
 *   ]
 *   Rendered: "[braid-whisper - enforcement @ 17:05 MSK]\nError burst detected\n[braid-whisper-end]"
 */
export function applyWhisperEnvelope(
  content: { type: string; text?: string }[],
  source: string,
  now: Date = nowOrOverride(),
): void {
  const envelope = formatWhisperEnvelope(source, now);
  if (content.length === 0) {
    content.unshift({ type: "text", text: `${envelope}\n` });
  } else {
    const firstText = content.find((c) => c.type === "text");
    if (firstText) {
      const currentText = (firstText as { text?: string }).text ?? "";
      (firstText as { type: string; text?: string }).text =
        currentText.length > 0 ? `${envelope}\n${currentText}` : `${envelope}\n`;
    } else {
      content.unshift({ type: "text", text: `${envelope}\n` });
    }
  }
  content.push({ type: "text", text: formatWhisperEndMarker() });
}
