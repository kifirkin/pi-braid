/**
 * Bidirectional Verifier — Phase 4: Coordination Checker.
 *
 * After a fix, checks that all derived/generated files are updated.
 * Uses module-level state for cross-turn tracking.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getVerifierState } from "./state.js";
import { filesAreRelated } from "./phase1.js";
import type { DerivedFile, CoordinationCheckState } from "./types.js";

const _coordinationState: CoordinationCheckState = {
  derivedFiles: [],
  staleDerivedFiles: [],
  coordinationRisks: [],
};

/** Reset module-level state (used by clearVerifierState). */
export function _resetCoordinationState(): void {
  _coordinationState.derivedFiles = [];
  _coordinationState.staleDerivedFiles = [];
  _coordinationState.coordinationRisks = [];
}

export function recordDerivedFrom(
  derived: string, source: string, relation: string, turn: number,
): void {
  if (_coordinationState.derivedFiles.some((d) => d.derived === derived && d.source === source)) return;
  _coordinationState.derivedFiles.push({ source, derived, relation, turn, stale: true });
}

export function markDerivedResolved(source: string, derived: string): void {
  for (const d of _coordinationState.derivedFiles) {
    if (d.source === source && d.derived === derived) d.stale = false;
  }
}

export function checkCoordinationRisk(
  ctx: ExtensionContext, editedFile: string, turn: number,
): string | null {
  const state = getVerifierState(ctx);
  const staleDerived = _coordinationState.derivedFiles.filter((d) => d.source === editedFile && d.stale);
  const sourceEditTurn = state.touchTurns.get(editedFile) ?? turn;
  const stillStale: DerivedFile[] = [];

  for (const d of staleDerived) {
    const derivedTouchTurn = state.touchTurns.get(d.derived);
    if (!derivedTouchTurn || derivedTouchTurn < sourceEditTurn) stillStale.push(d);
  }

  if (stillStale.length === 0) return null;

  const risks = stillStale.map((d) => ({ source: d.source, stale: d.derived, relation: d.relation }));
  for (const d of stillStale) d.stale = true;

  _coordinationState.staleDerivedFiles.push(...stillStale);
  _coordinationState.coordinationRisks.push(...risks.map((r) => ({ turn, ...r })));

  return `Coordination risk: ${risks.map((r) => `"${r.stale}" (${r.relation}) depends on edited "${r.source}" but wasn't updated`).join("; ")}`;
}

export function scanForDerivedFiles(
  ctx: ExtensionContext, readFilePath: string, content: string, turn: number,
): void {
  const state = getVerifierState(ctx);
  detectImportDerived(readFilePath, content, state.editedFiles, turn);
}

function detectImportDerived(
  readFilePath: string, content: string, recentlyEditedFiles: Set<string>, turn: number,
): void {
  const importRegex = /from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const imported = match[1];
    if (!imported.startsWith(".")) continue;
    const dir = readFilePath.substring(0, readFilePath.lastIndexOf("/") + 1);
    const resolved = resolveRelativeImport(dir, imported);
    for (const edited of recentlyEditedFiles) {
      if (filesAreRelated(resolved, edited)) recordDerivedFrom(readFilePath, edited, "import", turn);
    }
  }

  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    const imported = match[1];
    if (!imported.startsWith(".")) continue;
    const dir = readFilePath.substring(0, readFilePath.lastIndexOf("/") + 1);
    const resolved = resolveRelativeImport(dir, imported);
    for (const edited of recentlyEditedFiles) {
      if (filesAreRelated(resolved, edited)) recordDerivedFrom(readFilePath, edited, "require", turn);
    }
  }
}

function resolveRelativeImport(dir: string, importPath: string): string {
  let resolved = importPath;
  if (resolved.startsWith("./")) resolved = resolved.slice(2);
  while (resolved.startsWith("../")) {
    resolved = resolved.slice(3);
    const parts = dir.split("/");
    if (parts.length > 1) dir = parts.slice(0, -2).join("/") + "/";
  }
  return dir + resolved;
}

export function getCoordinationCheckSummary(): string {
  if (_coordinationState.derivedFiles.length === 0) return "No derived file relationships tracked.";
  const lines: string[] = [];
  lines.push(`Derived relationships: ${_coordinationState.derivedFiles.length}`);
  lines.push(`Stale derived files: ${_coordinationState.staleDerivedFiles.length}`);
  lines.push(`Coordination risks: ${_coordinationState.coordinationRisks.length}`);
  if (_coordinationState.coordinationRisks.length > 0) {
    for (const r of _coordinationState.coordinationRisks.slice(-5)) {
      lines.push(`  Turn ${r.turn}: "${r.stale}" depends on "${r.source}" (${r.relation}) — not updated`);
    }
  }
  return lines.join("\n");
}
