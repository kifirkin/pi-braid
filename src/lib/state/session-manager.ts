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
  getLabel(id: string): string | undefined;
  setLabel(id: string, label: string): void;
  getChildren(id: string): string[];
  branchWithSummary(targetId: string, summary: string): Promise<void>;
  session?: { filePath?: string };
}

export function getSessionManager(ctx: ExtensionContext): SessionManager {
  const sm = safeSessionManager(ctx) as SessionManager | undefined;
  if (!sm) throw new Error("sessionManager not available (ctx may be stale)");
  return sm;
}
