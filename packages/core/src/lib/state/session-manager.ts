// ── Typed Session Manager Wrapper ────────────────────────────────────────────
// Wraps ctx.sessionManager with full types, eliminating runtime monkey-patching.
// Usage: const sm = getSessionManager(ctx); sm.getBranch(), sm.getLabel(id), etc.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeSessionManager } from "./extension-state.js";

export interface SessionEntry {
  id: string;
  type: string;
  message?: { role?: string; content?: unknown; toolName?: string };
  data?: unknown;
  customType?: string;
}

export interface SessionNode {
  entry: SessionEntry;
  children: string[];
}

export interface SessionManager {
  getBranch(): SessionEntry[];
  getLeafId(): string;
  getTree(): SessionNode[];
  // Labels are written through the extension API (`pi.setLabel`), which maps
  // to the session manager's `appendLabelChange`; the instance itself exposes
  // no setter.
  getLabel(id: string): string | undefined;
  getChildren(id: string): string[];
  branchWithSummary(targetId: string, summary: string): Promise<void>;
  /**
   * Returns the on-disk path of the current session file, or null if
   * the session is ephemeral (e.g. RPC/print mode). pi 1.0.2 backs this
   * with the private `sessionFile` field; there is no `session` object.
   */
  getSessionFile(): string | null;
}

export function getSessionManager(ctx: ExtensionContext): SessionManager {
  const sm = safeSessionManager(ctx) as SessionManager | undefined;
  if (!sm) throw new Error("sessionManager not available (ctx may be stale)");
  return sm;
}
