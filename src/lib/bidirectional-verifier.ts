/**
 * Bidirectional Verifier — Phase 1: Forward Trace
 *
 * Tracks the agent's file touch graph and compares it against the
 * problem-relevant file set. Flags localization risk when the agent
 * touches files unrelated to the reported problem.
 *
 * Based on: AgentV-RL (2604.16004) + HWE-Bench failure mode analysis
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "./extension-state.js";

// ── State ──────────────────────────────────────────────────────────────────

interface BidirectionalVerifierState {
  /** Files mentioned in user messages / error context */
  problemFiles: Set<string>;
  /** Files the agent has read */
  readFiles: Set<string>;
  /** Files the agent has edited/written */
  editedFiles: Set<string>;
  /** Turn when each file was last touched */
  touchTurns: Map<string, number>;
  /** Localization risk flags per turn */
  localizationRisks: Array<{
    turn: number;
    file: string;
    reason: string;
  }>;
}

function createState(): BidirectionalVerifierState {
  return {
    problemFiles: new Set(),
    readFiles: new Set(),
    editedFiles: new Set(),
    touchTurns: new Map(),
    localizationRisks: [],
  };
}

export function getVerifierState(ctx: ExtensionContext): BidirectionalVerifierState {
  return getExtensionState(ctx, "bidirectional-verifier", createState);
}

// ── File Extraction ────────────────────────────────────────────────────────

/**
 * Extract likely file paths from arbitrary text.
 * Matches:
 * - Absolute paths: /foo/bar.ts
 * - Relative paths: src/foo/bar.ts, ./foo.ts, ../foo/bar.ts
 * - Basenames with extensions: foo.ts, bar.js (if they look like files)
 */
export function extractFileReferences(text: string): string[] {
  const refs: string[] = [];

  // Absolute or relative paths with extensions
  const pathPattern = /(?:\.[./]|\/)?[a-zA-Z0-9_\-/.]+\.[a-zA-Z0-9]+/g;
  for (const match of text.matchAll(pathPattern)) {
    const candidate = match[0];
    // Filter out URLs and short non-file-like things
    if (
      candidate.includes(".") &&
      !candidate.startsWith("http") &&
      !candidate.startsWith("www") &&
      !candidate.startsWith("//") &&
      !candidate.includes("://") &&
      candidate.length > 3 &&
      // Reject domain-like names (e.g. example.com) — require path separator or valid extension
      (candidate.includes("/") || !candidate.match(/^[^/]+\.[^/]+$/))
    ) {
      refs.push(candidate);
    }
  }

  // File:line patterns (error traces)
  const tracePattern = /(?:at\s+)?(?:.+?\s+)?([a-zA-Z0-9_\-/.]+\.[a-zA-Z0-9]+):(\d+):(\d+)/g;
  for (const match of text.matchAll(tracePattern)) {
    refs.push(match[1]);
  }

  return [...new Set(refs)]; // dedup
}

/**
 * Update the problem-relevant file set from user input or error text.
 */
export function updateProblemContext(ctx: ExtensionContext, text: string): void {
  const state = getVerifierState(ctx);
  const refs = extractFileReferences(text);
  for (const ref of refs) {
    state.problemFiles.add(ref);
  }
}

/**
 * Record that the agent touched (read or edited) a file.
 */
export function recordFileTouch(
  ctx: ExtensionContext,
  filePath: string,
  turn: number,
  wasEdit: boolean,
): void {
  const state = getVerifierState(ctx);
  state.touchTurns.set(filePath, turn);
  if (wasEdit) {
    state.editedFiles.add(filePath);
  } else {
    state.readFiles.add(filePath);
  }
}

/**
 * Check if an edited file is in the problem context.
 * Returns null if OK, or a risk description if there's a mismatch.
 */
export function checkLocalizationRisk(
  ctx: ExtensionContext,
  editedFile: string,
  turn: number,
): string | null {
  const state = getVerifierState(ctx);

  // No problem context yet — can't assess risk
  if (state.problemFiles.size === 0) return null;

  // Check if edited file is directly or indirectly related to problem
  for (const problemFile of state.problemFiles) {
    if (filesAreRelated(editedFile, problemFile)) {
      return null; // Related — no risk
    }
  }

  // Not related — flag localization risk
  const risk = `Edited "${editedFile}" which is unrelated to the reported problem files: ${[...state.problemFiles].slice(0, 5).join(", ")}`;
  state.localizationRisks.push({ turn, file: editedFile, reason: risk });
  return risk;
}

/**
 * Simple heuristic: files are related if they share a path component
 * or filename (excluding extension).
 */
export function filesAreRelated(a: string, b: string): boolean {
  const normalize = (p: string) =>
    p
      .replace(/^\.\//, "")
      .replace(/^\.\.\//, "")
      .replace(/^\//, "");

  const na = normalize(a);
  const nb = normalize(b);

  // Direct match
  if (na === nb) return true;

  // Shared directory prefix (at least 2 components)
  const pa = na.split("/");
  const pb = nb.split("/");
  if (pa.length >= 2 && pb.length >= 2) {
    const shared = pa.filter((c, i) => pb[i] === c);
    if (shared.length >= 2) return true;
    if (shared.length >= 1 && shared[0].length > 2) return true;
  }

  // Shared basename (no extension)
  const ba = pa[pa.length - 1]?.replace(/\.[^.]+$/, "");
  const bb = pb[pb.length - 1]?.replace(/\.[^.]+$/, "");
  if (ba && bb && ba === bb) return true;

  return false;
}

/**
 * Get a summary of the current touch graph for diagnostics.
 */
export function getTouchGraphSummary(ctx: ExtensionContext): string {
  const state = getVerifierState(ctx);
  const lines: string[] = [];
  lines.push(`Problem files: ${state.problemFiles.size}`);
  lines.push(`Read files: ${state.readFiles.size}`);
  lines.push(`Edited files: ${state.editedFiles.size}`);
  lines.push(`Localization risks: ${state.localizationRisks.length}`);
  if (state.localizationRisks.length > 0) {
    const recent = state.localizationRisks.slice(-3);
    for (const r of recent) {
      lines.push(`  Turn ${r.turn}: ${r.reason}`);
    }
  }
  return lines.join("\n");
}
