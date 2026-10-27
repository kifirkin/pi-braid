/**
 * Path-miss steer — the tool failure that says what would have worked.
 *
 * A turn that guesses paths spends calls discovering a layout a listing would
 * have named. The failure itself is the one moment the cheaper move is
 * obvious, so it is where the line belongs: one steer per turn, the path that
 * missed, and the three instruments that answer it (`ls`, `find`,
 * `explore_paths`).
 *
 * Delivery is the standard whisper funnel (`sendTrackedMessage`), so this
 * emitter inherits the envelope, the flood cap and the live-steer resolution
 * every other whisper uses. The event is pi's existing `tool_result`, the only
 * seat that carries both the failure text and the arguments the call made —
 * the call's own `path` is more reliable than parsing the error wording.
 *
 * Budget: one line per turn, at most one line per path per session. A path
 * already steered is not steered again, because a repeat tells the agent
 * nothing it was not told, and the second occurrence usually means the agent
 * chose to proceed rather than that it failed to read.
 */

import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { INPUT, TOOL_RESULT } from "../../../lib/core/event-names.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { detectPathMiss } from "./detect.js";

const log = createLogger("path-miss");

/**
 * Sessions whose steered paths are remembered. A session id is stable for the
 * life of a session and a long-lived process can host more than one, so the
 * map is bounded rather than trusted to stay small.
 */
const MAX_TRACKED_SESSIONS = 16;

/** Paths already steered, per session. */
const steeredPaths = new Map<string, Set<string>>();

/** Turn-scoped: the first path miss of a turn is the one worth a line. */
let steeredThisTurn = false;

function sessionKey(ctx: ExtensionContext | undefined): string {
  const manager = ctx?.sessionManager as
    | { getSessionId?: () => string; getSessionFile?: () => string | undefined }
    | undefined;
  return manager?.getSessionId?.() ?? manager?.getSessionFile?.() ?? "unknown";
}

function remember(session: string, path: string): void {
  const paths = steeredPaths.get(session) ?? new Set<string>();
  paths.add(path);
  steeredPaths.set(session, paths);
  if (steeredPaths.size > MAX_TRACKED_SESSIONS) {
    // Insertion order: the oldest session is the first key.
    const oldest = steeredPaths.keys().next().value;
    if (oldest !== undefined && oldest !== session) steeredPaths.delete(oldest);
  }
}

function alreadySteered(session: string, path: string): boolean {
  return steeredPaths.get(session)?.has(path) ?? false;
}

/** The error text of a tool result, with any non-text parts ignored. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}

/**
 * One line: the path, and the cheaper moves next to it.
 *
 * The parent is named when the path has one, because `ls` needs an operand and
 * a model that guessed a leaf usually had the parent wrong too — listing the
 * parent is what tells it which of the two it got wrong.
 */
export function pathMissLine(path: string): string {
  const parent = dirname(path);
  const listing = parent && parent !== "." && parent !== "/" ? `ls ${parent}` : "ls on its parent";
  return `path miss: ${path} — ${listing} names the layout in one call; find and explore_paths when the parent is unknown too`;
}

/** Test hook: forget every steered path and the current turn's budget. */
export function _resetForTests(): void {
  steeredPaths.clear();
  steeredThisTurn = false;
}

export default function pathMissExtension(pi: ExtensionAPI): void {
  // The same turn boundary the whisper family uses: a new user input opens a
  // new turn, and a turn that has already been steered is done.
  pi.on(INPUT, () => {
    steeredThisTurn = false;
  });

  pi.on(TOOL_RESULT, (event, ctx) => {
    if (steeredThisTurn) return;
    if (!event?.isError) return;
    const miss = detectPathMiss(event.toolName, event.input, resultText(event.content));
    if (!miss) return;

    const session = sessionKey(ctx);
    if (alreadySteered(session, miss.path)) return;

    steeredThisTurn = true;
    const delivered = sendTrackedMessage(
      pi,
      {
        customType: "path-miss",
        content: [{ type: "text" as const, text: pathMissLine(miss.path) }],
        display: true,
      },
      { delivery: "live" },
      { type: "enforcement", source: "path-miss/steer" },
    );
    // A suppressed send must not spend the path's budget: the line did not
    // arrive, so the next turn is still the first place the agent can read it.
    if (!delivered) {
      steeredThisTurn = false;
      log.debug(`[path-miss] suppressed by the whisper funnel: ${miss.path}`);
      return;
    }
    remember(session, miss.path);
    log.debug(`[path-miss] steered ${miss.path} (${miss.tool})`);
  });
}
