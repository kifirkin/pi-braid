/**
 * Session section for the prompt-builder.
 *
 * Renders a "## Session" block with volatile session stats: PID,
 * session elapsed time, since-last-event, turn count, tool-call
 * average. Re-formats the data that `agent-environment/index.ts`
 * already gathers via `gatherL1Environment()`.
 *
 * Differs from Instance (stable per session-start: identity, root,
 * cwd, os, datetime, extension tree) and Context (conditional:
 * context %, session health, memory count, checkpoint awareness).
 *
 * The three-block split landed in v3.6. Previously this data was
 * mixed with context-conditional info in a monolithic
 * `l1-environment.ts`, which has been removed.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gatherL1Environment } from "../agent-environment/index.js";
import type { PromptSection } from "./section.js";

/** Build the Session section from gathered agent-environment data. */
export async function sessionSection(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<PromptSection> {
  const data = gatherL1Environment(_pi, ctx);
  return {
    name: "session",
    render: () => formatSessionBlock(data),
  };
}

function formatSessionBlock(data: ReturnType<typeof gatherL1Environment>): string {
  const minutes = Math.floor(data.sessionElapsedMs / 60000);
  const seconds = Math.floor((data.sessionElapsedMs % 60000) / 1000);
  const sinceLast = Math.round(data.sinceLastEventMs / 1000);

  const lines: string[] = ["## Session"];
  // PID is always shown (debug affordance). Machine/hostname moved
  // to Instance in v3.5 — dropped here to avoid duplication.
  lines.push(`- PID: ${data.pid}`);
  lines.push(`- Session: ${minutes}m ${seconds}s`);
  // sinceLast > 0 only when at least one event has fired; safe to always show
  lines.push(`- Last event: ${sinceLast}s ago`);
  lines.push(`- Turns: ${data.turnCount}`);
  if (data.avgToolTimeMs > 0) {
    lines.push(`- Tool avg: ${data.avgToolTimeMs}ms`);
  }
  return lines.join("\n");
}
