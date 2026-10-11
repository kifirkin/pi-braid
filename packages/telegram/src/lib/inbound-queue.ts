/**
 * Durable store for owner messages not yet handed to the session.
 *
 * Owner messages steer by policy: an arrival is handed over at the coalescing
 * window's close, busy or idle. An entry stays here only when that handoff
 * did not happen, either because pi refused the steer (a prompt during
 * compaction) or because a factory re-run (reload, session replacement)
 * landed mid-window. The hold outlives the delivery attempt, so it lives in a
 * FILE, not in an array: the extension factory is re-run on both lifecycle
 * paths, a reload (resource-loader reload() clears the module cache and calls
 * the factory again) and a session replacement (new/resume/fork build a new
 * resource loader whose reload() calls the factory again, so the closure does
 * not survive into the replacement session), and the delivery handler returns
 * before the offset confirmation: the hold is written through while the
 * handler runs, and the poller persists the offset past the update only at
 * the end of the poll cycle. An in-memory hold would be dropped silently once
 * the offset moves; the file survives the re-run, and each entry carries the
 * session it was accepted for, so a hold rehydrated into a different named
 * session is reported, not delivered — while an entry accepted before any
 * session could name itself is adopted by the first session that names itself.
 *
 * This module only stores and returns entries: which session is current,
 * whether an entry may be delivered, and what a human is told about an entry
 * that cannot be, are delivery policy and live in the extension (index.ts).
 * Every function here is total — a missing, truncated, or hand-edited file
 * reads as "no entries" rather than throwing into a lifecycle handler; read
 * failures other than ENOENT and version mismatches are surfaced through the
 * caller-supplied reporter.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import type { IncomingOwnerMessage } from "./inbound-poller.js";

/** One held owner message plus the session it was accepted for. */
export interface QueuedInboundMessage {
  message: IncomingOwnerMessage;
  /**
   * Session the message was accepted for. `undefined` when the live context
   * could not name one (no session manager on a synthetic context); such an
   * entry is adopted by the first session that names itself (the current id is
   * stamped on it at delivery/rehydrate). An entry accepted for a different
   * named session is never delivered across that boundary.
   */
  sessionId?: string;
  /** Acceptance time (ms) — keeps arrival order across process boundaries. */
  queuedAt: number;
}

/** Current on-disk shape. Bumped only when the entry shape changes. */
const QUEUE_VERSION = 1;

/**
 * Queue file for a given poller state file: a sibling in the same directory,
 * named after the state file's stem, so the documented `BRAID_TG_STATE_FILE`
 * knob governs both the offset and the hold, and two state files in one
 * directory keep two separate holds. The name also says whose hold it was:
 * moving the state file to another directory strands the old queue beside the
 * old path — there is no auto-migration, and none is possible from the file
 * alone.
 */
export function inboundQueueFileFor(stateFile: string): string {
  const stem = basename(stateFile, extname(stateFile));
  return join(dirname(stateFile), `${stem}-inbound-queue.json`);
}

/** Entry-shape guard for hand-edited files (the file version is checked separately). */
function isQueuedEntry(value: unknown): value is QueuedInboundMessage {
  const entry = value as Partial<QueuedInboundMessage> | undefined;
  const message = entry?.message as Partial<IncomingOwnerMessage> | undefined;
  if (!message || typeof message !== "object") return false;
  if (!Number.isFinite(message.updateId)) return false;
  if (typeof message.text !== "string") return false;
  if (entry?.sessionId !== undefined && typeof entry.sessionId !== "string") {
    return false;
  }
  return Number.isFinite(entry?.queuedAt);
}

/**
 * Read problems that are not "nothing held": a non-ENOENT read failure or a
 * file written by another version. The store stays total (the caller still
 * gets `[]`), but a silent discard is exactly the failure class the durable
 * hold exists to remove, so the caller is handed a message for its log.
 * ENOENT and unparsable content are not reported: absent and hand-edited state
 * is the documented "no entries" reading.
 */
export type QueueReadReporter = (message: string) => void;

/**
 * Read the held entries. Never throws: absent, unreadable, unparsable, or
 * foreign-version state means "nothing held" (a lost hold is reported by the
 * delivery path, which knows the session it belonged to; a read failure here
 * must not take down the lifecycle handler that is rehydrating it). Read
 * failures other than ENOENT and version mismatches are passed to `report`.
 */
export async function loadInboundQueue(
  queueFile: string,
  report?: QueueReadReporter,
): Promise<QueuedInboundMessage[]> {
  let raw: string;
  try {
    raw = await readFile(queueFile, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== "ENOENT") {
      report?.(
        `could not read the inbound hold file ${queueFile}: ${String(error)}`,
      );
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const file = parsed as { version?: unknown; entries?: unknown } | null;
  if (file?.version !== QUEUE_VERSION) {
    report?.(
      `ignoring the inbound hold file ${queueFile}: version ${String(file?.version)} is not ${QUEUE_VERSION}`,
    );
    return [];
  }
  const entries = Array.isArray(file.entries) ? file.entries : [];
  return entries.filter(isQueuedEntry);
}

/**
 * Persist the held entries ATOMICALLY (write-temp-rename, same rationale as
 * savePauseState): the JSON is written to a temp file first and renamed over
 * the target, so a crash mid-write can never leave a truncated queue behind —
 * the truncation would read back as "nothing held" and lose exactly the
 * messages this file exists to protect. The temp name is unique per write:
 * a shared temp made concurrent savers fail each other's rename (ENOENT),
 * while unique temps all land and the last rename wins with a whole snapshot.
 */
export async function saveInboundQueue(
  queueFile: string,
  entries: QueuedInboundMessage[],
): Promise<void> {
  const dir = dirname(queueFile);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // parent may already exist; the write will surface real errors
  }
  const tmp = `${queueFile}.${randomUUID()}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ version: QUEUE_VERSION, entries }, null, 2) + "\n",
    "utf8",
  );
  await rename(tmp, queueFile);
}
