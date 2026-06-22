/**
 * Whisper Envelope - Universal prefix for system-injected messages.
 *
 * Every message sent via `sendTrackedMessage` is wrapped with a
 * `[braid-whisper · <subsystem>]` envelope so the agent can reliably
 * distinguish system-injected signals from human user input.
 *
 * Why this exists (see docs/ENFORCEMENT-WHISPER-CONTENT-AUDIT.md §6.12):
 *   - ~30% of system whispers had no prefix at all ("Context at 80%.",
 *     "## Session Size Notice", "VbC correction: ...")
 *   - The rest had inconsistent prefixes ("[enforcement]", "[Quality]",
 *     "[chains]", "[TIMER FIRED]", "## Repetitive Loop Detected")
 *   - The agent could confuse these with human notes, especially
 *     because many use imperative voice ("Consider X", "Run Y")
 *
 * The envelope is added centrally in `sendTrackedMessage` (the trunk)
 * so all 30+ call sites automatically benefit without per-site changes.
 *
 * The subsystem is derived from the source path's first segment
 * (e.g. "enforcement/whisper" -> "enforcement",
 *       "memory/context-manager" -> "memory",
 *       "cognitive/sycophancy-detector" -> "cognitive").
 *
 * The full source is preserved in the message metadata
 * (`details._braidSource`) for debugging and analytics.
 *
 * Migration from the old format:
 *   The audit's §6.12 found that whisper prefixes were inconsistent
 *   across the codebase. The old format mixed bare sentences, markdown
 *   headings, and various bracket prefixes ("[enforcement]", "[Quality]",
 *   "[chains]", "[TIMER FIRED]"). The new envelope replaces all of these
 *   with one universal pattern.
 *
 *   Filters that matched the bare subsystem name (e.g. `grep enforcement`
 *   or `grep memory`) still work - "enforcement" is a substring of
 *   "[braid-whisper · enforcement]".
 *
 *   Filters that matched the old bracket-wrapped prefix
 *   (e.g. `grep '\[enforcement\]'`) need to be updated to the new
 *   canonical form: `grep '\[braid-whisper · enforcement\]'` or the
 *   bare substring `grep enforcement`.
 *
 *   Body-level sub-tags (the audit's proposed `[<subsystem>-<event>]`
 *   kebab convention) can still be added inside the message body as a
 *   second filter level - the envelope is one level above them.
 */

/**
 * Format the universal envelope line for a given source.
 * Returns "[braid-whisper · <subsystem>]" with no trailing whitespace.
 *
 * The subsystem is the first segment of the source path. If the source
 * is empty or has no "/", the literal "system" is used as the fallback.
 */
export function formatWhisperEnvelope(source: string): string {
  const subsystem = source.split("/")[0] || "system";
  return `[braid-whisper · ${subsystem}]`;
}

/**
 * Apply the universal envelope to a content array in place.
 * Prepends the envelope to the first text element. If no text
 * element exists, a new text element is prepended.
 *
 * Mutates the input array. This is acceptable because all callers
 * create the content array inline and do not reuse it after delivery.
 *
 * Example:
 *   Input:  [{ type: "text", text: "Error burst detected" }]
 *   Source: "enforcement/whisper"
 *   After:  [{ type: "text", text: "[braid-whisper · enforcement] Error burst detected" }]
 */
export function applyWhisperEnvelope(
  content: { type: string; text?: string }[],
  source: string,
): void {
  const envelope = formatWhisperEnvelope(source);
  if (content.length === 0) {
    content.unshift({ type: "text", text: `${envelope} ` });
    return;
  }
  const firstText = content.find((c) => c.type === "text");
  if (firstText) {
    const currentText = (firstText as { text?: string }).text ?? "";
    (firstText as { type: string; text?: string }).text =
      currentText.length > 0
        ? `${envelope} ${currentText}`
        : `${envelope} `;
  } else {
    content.unshift({ type: "text", text: `${envelope} ` });
  }
}
