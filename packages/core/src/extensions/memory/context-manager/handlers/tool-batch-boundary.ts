/**
 * Tool-batch-safe compaction boundaries.
 *
 * braid supplies the compaction boundary (`firstKeptEntryId`) that pi-core
 * consumes verbatim: slide cuts, archive ranges, and the deterministic
 * (high-context/failsafe) cuts all hand one over. pi-core's own cut-point
 * selector never picks a tool result - `isCutPointMessage` returns false for
 * `toolResult` (pi-coding-agent dist/core/compaction/compaction.js:253-266)
 * and `findValidCutPoints` is built on it (:288-305) - because the kept slice
 * after a compaction becomes the opening of the next provider request, where a
 * `tool` message without its preceding `tool_calls` (or a truncated parallel
 * batch) is rejected with: "Messages with role 'tool' must be a response to a
 * preceding message with 'tool_calls'" (HTTP 400). A boundary braid supplies
 * must keep that invariant; pi-core applies no defensive snap of its own.
 *
 * Every boundary supplier routes its candidate index through
 * `snapBoundaryOutsideToolBatch`, and the consumers that persist a stored
 * boundary id re-derive the index and snap it against the branch as it stands
 * at consumption (the armer may have read the branch before the batch's later
 * results landed).
 *
 * The readers take raw session entries (`readonly unknown[]`) because that is
 * what a live branch is at the boundaries; the shape is narrowed here rather
 * than asserted at every call site.
 */

/** A kept slice is "minimal" at one entry; below that the snap goes backward. */
export const MIN_KEPT_ENTRIES = 1;

interface BoundaryEntry {
  id?: string;
  type?: string;
  message?: unknown;
}

interface BoundaryMessage {
  role?: string;
  /** Session-shaped tool calls: content blocks `{ type: "toolCall", id }`. */
  content?: unknown;
  /** Converted-message shape, accepted defensively. */
  toolCalls?: Array<{ id?: string; toolCallId?: string }>;
  /** Tool-result linkage (pi's camelCase field). */
  toolCallId?: string;
}

function entryOf(raw: unknown): BoundaryEntry | undefined {
  return raw && typeof raw === "object" ? (raw as BoundaryEntry) : undefined;
}

function messageOf(entry: BoundaryEntry | undefined): BoundaryMessage | undefined {
  const message = entry?.message;
  return message && typeof message === "object" ? (message as BoundaryMessage) : undefined;
}

function isToolResultEntry(entry: BoundaryEntry | undefined): boolean {
  return entry?.type === "message" && messageOf(entry)?.role === "toolResult";
}

function toolResultCallIdOf(entry: BoundaryEntry | undefined): string | undefined {
  if (!isToolResultEntry(entry)) return undefined;
  const callId = messageOf(entry)?.toolCallId;
  return typeof callId === "string" ? callId : undefined;
}

/** The tool_call ids an assistant entry declares (0 for any other entry). */
function toolCallIdsOf(entry: BoundaryEntry | undefined): string[] {
  const message = messageOf(entry);
  if (entry?.type !== "message" || message?.role !== "assistant") return [];
  const ids: string[] = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const b =
        block && typeof block === "object" ? (block as { type?: string; id?: unknown }) : undefined;
      if (b?.type === "toolCall" && typeof b.id === "string") ids.push(b.id);
    }
  }
  if (Array.isArray(message.toolCalls)) {
    for (const call of message.toolCalls) {
      const id = call?.id ?? call?.toolCallId;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

/**
 * The structurally invalid shape of a kept slice [candidateIndex..end]:
 * either it begins with a tool result (its call fell outside the slice), or it
 * contains an assistant whose tool_calls are not fully answered inside it.
 * Returns null for a valid slice. Exported for tests and audit surfaces.
 */
export function findBoundaryViolation(
  entries: readonly unknown[],
  candidateIndex: number,
): {
  kind: "leading-tool-result" | "unanswered-tool-calls";
  entryId?: string;
  /** Index of the offending assistant entry (unanswered-tool-calls). */
  assistantIndex?: number;
} | null {
  if (!Array.isArray(entries) || candidateIndex < 0 || candidateIndex >= entries.length) {
    return null;
  }
  if (isToolResultEntry(entryOf(entries[candidateIndex]))) {
    return { kind: "leading-tool-result", entryId: entryOf(entries[candidateIndex])?.id };
  }
  for (let i = candidateIndex; i < entries.length; i++) {
    for (const id of toolCallIdsOf(entryOf(entries[i]))) {
      let answered = false;
      for (let j = i + 1; j < entries.length; j++) {
        if (toolResultCallIdOf(entryOf(entries[j])) === id) {
          answered = true;
          break;
        }
      }
      if (!answered) {
        return {
          kind: "unanswered-tool-calls",
          entryId: entryOf(entries[i])?.id,
          assistantIndex: i,
        };
      }
    }
  }
  return null;
}

/**
 * Nearest assistant entry before `resultIndex` that declares `resultIndex`'s
 * tool call; -1 when the call is gone from the branch (summarized away or
 * never recorded).
 */
function findOwningAssistant(entries: readonly unknown[], resultIndex: number): number {
  const callId = toolResultCallIdOf(entryOf(entries[resultIndex]));
  if (!callId) return -1;
  for (let i = resultIndex - 1; i >= 0; i--) {
    if (toolCallIdsOf(entryOf(entries[i])).includes(callId)) return i;
  }
  return -1;
}

/** Index of the last result of `assistantIndex`'s batch; -1 when none recorded. */
function lastResultIndexOfBatch(entries: readonly unknown[], assistantIndex: number): number {
  const callIds = new Set(toolCallIdsOf(entryOf(entries[assistantIndex])));
  if (callIds.size === 0) return -1;
  let last = -1;
  for (let i = assistantIndex + 1; i < entries.length; i++) {
    const resultId = toolResultCallIdOf(entryOf(entries[i]));
    if (resultId !== undefined && callIds.has(resultId)) last = i;
  }
  return last;
}

function firstNonToolResultIndex(entries: readonly unknown[], fromIndex: number): number {
  let i = fromIndex;
  while (i < entries.length && isToolResultEntry(entryOf(entries[i]))) i++;
  return i;
}

/**
 * Snap a candidate first-kept index so the kept slice [result..end] cannot
 * split a tool batch:
 *   - a candidate landing mid-batch snaps FORWARD to the first entry after
 *     the batch's last tool result (parallel calls are one batch of N results);
 *   - when that would keep less than `MIN_KEPT_ENTRIES`, it snaps BACKWARD to
 *     the batch's assistant message instead, keeping the whole batch live;
 *   - a leading result whose call is no longer in the branch (summarized away)
 *     is dropped by snapping forward past the leading run.
 * Returns the candidate unchanged when it is already valid (or when the branch
 * is empty). Deterministic, pure, and safe on a branch that grows later: a
 * boundary computed from incomplete in-flight results lands on the batch's
 * assistant via the backward snap, which stays valid as the rest arrive.
 */
export function snapBoundaryOutsideToolBatch(
  entries: readonly unknown[],
  candidateIndex: number,
): number {
  if (!Array.isArray(entries) || entries.length === 0) return candidateIndex;
  let index = Math.max(0, Math.min(candidateIndex, entries.length - 1));
  for (let guard = 0; guard < entries.length; guard++) {
    const violation = findBoundaryViolation(entries, index);
    if (!violation) return index;

    if (violation.kind === "leading-tool-result") {
      const owner = findOwningAssistant(entries, index);
      if (owner < 0) {
        // The call is outside the branch: the only valid repair is dropping
        // the orphaned results.
        const after = firstNonToolResultIndex(entries, index);
        if (after > index && entries.length - after >= MIN_KEPT_ENTRIES) {
          index = after;
          continue;
        }
        return index;
      }
      const last = lastResultIndexOfBatch(entries, owner);
      const forward = last + 1;
      if (entries.length - forward >= MIN_KEPT_ENTRIES) {
        index = forward;
        continue;
      }
      // Forward would keep less than a minimal slice: keep the whole batch.
      return owner;
    }

    // An assistant inside the slice with unanswered tool_calls (its results
    // were never recorded or fell outside). Drop the batch: keep from the
    // entry after its last recorded result.
    const owner = violation.assistantIndex ?? index;
    const last = lastResultIndexOfBatch(entries, owner);
    const forward = last + 1;
    if (last >= owner && entries.length - forward >= MIN_KEPT_ENTRIES) {
      index = forward;
      continue;
    }
    return index;
  }
  return index;
}
