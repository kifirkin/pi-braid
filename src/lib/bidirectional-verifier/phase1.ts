/**
 * Bidirectional Verifier — Phase 1: Forward Trace.
 *
 * Tracks the agent's file touch graph and compares it against the
 * problem-relevant file set. Flags localization risk when the agent
 * touches files unrelated to the reported problem.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getVerifierState } from "./state.js";

export { getVerifierState } from "./state.js";

// ── File Extraction ────────────────────────────────────────────────────────

export function extractFileReferences(text: string): string[] {
  const refs: string[] = [];

  const pathPattern = /(?:\.[./]|\/)?[a-zA-Z0-9_\-/.]+\.[a-zA-Z0-9]+/g;
  for (const match of text.matchAll(pathPattern)) {
    const candidate = match[0];
    if (
      candidate.includes(".") && !candidate.startsWith("http") &&
      !candidate.startsWith("www") && !candidate.startsWith("//") &&
      !candidate.includes("://") && candidate.length > 3 &&
      (candidate.includes("/") || !candidate.match(/^[^/]+\.[^/]+$/))
    ) {
      refs.push(candidate);
    }
  }

  const tracePattern = /(?:at\s+)?(?:.+?\s+)?([a-zA-Z0-9_\-/.]+\.[a-zA-Z0-9]+):(\d+):(\d+)/g;
  for (const match of text.matchAll(tracePattern)) {
    refs.push(match[1]);
  }

  return [...new Set(refs)];
}

export function updateProblemContext(ctx: ExtensionContext, text: string): void {
  const state = getVerifierState(ctx);
  for (const ref of extractFileReferences(text)) {
    state.problemFiles.add(ref);
  }
}

export function recordFileTouch(
  ctx: ExtensionContext, filePath: string, turn: number, wasEdit: boolean,
): void {
  const state = getVerifierState(ctx);
  state.touchTurns.set(filePath, turn);
  if (wasEdit) state.editedFiles.add(filePath);
  else state.readFiles.add(filePath);
}

export function checkLocalizationRisk(
  ctx: ExtensionContext, editedFile: string, turn: number,
): string | null {
  const state = getVerifierState(ctx);
  if (state.problemFiles.size === 0) return null;
  for (const problemFile of state.problemFiles) {
    if (filesAreRelated(editedFile, problemFile)) return null;
  }
  const risk = `Edited "${editedFile}" which is unrelated to the reported problem files: ${[...state.problemFiles].slice(0, 5).join(", ")}`;
  state.localizationRisks.push({ turn, file: editedFile, reason: risk });
  return risk;
}

export function filesAreRelated(a: string, b: string): boolean {
  const normalize = (p: string) => p.replace(/^\.\//, "").replace(/^\.\.\//, "").replace(/^\//, "");
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;

  const pa = na.split("/");
  const pb = nb.split("/");
  if (pa.length >= 2 && pb.length >= 2) {
    const shared = pa.filter((c, i) => pb[i] === c);
    if (shared.length >= 2) return true;
    if (shared.length >= 1 && shared[0].length > 2) return true;
  }
  const ba = pa[pa.length - 1]?.replace(/\.[^.]+$/, "");
  const bb = pb[pb.length - 1]?.replace(/\.[^.]+$/, "");
  if (ba && bb && ba === bb) return true;
  return false;
}

export function getTouchGraphSummary(ctx: ExtensionContext): string {
  const state = getVerifierState(ctx);
  const lines: string[] = [];
  lines.push(`Problem files: ${state.problemFiles.size}`);
  lines.push(`Read files: ${state.readFiles.size}`);
  lines.push(`Edited files: ${state.editedFiles.size}`);
  lines.push(`Localization risks: ${state.localizationRisks.length}`);
  if (state.localizationRisks.length > 0) {
    for (const r of state.localizationRisks.slice(-3)) {
      lines.push(`  Turn ${r.turn}: ${r.reason}`);
    }
  }
  return lines.join("\n");
}
