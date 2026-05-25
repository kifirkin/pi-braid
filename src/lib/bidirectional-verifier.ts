/**
 * Bidirectional Verifier — file touch tracking for enforcement.
 *
 * Tracks which files the agent reads/edits, checks if edits match claimed
 * actions, verifies completion against problem context, and detects stale
 * derived files.
 *
 * Previously split across 7 files (state.ts, types.ts, phase1-4.ts, index.ts)
 * — collapsed into one because the "4-phase architecture" was over-engineering.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "./extension-state.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface BidirectionalVerifierState {
  problemFiles: Set<string>;
  readFiles: Set<string>;
  editedFiles: Set<string>;
  touchTurns: Map<string, number>;
  localizationRisks: Array<{ turn: number; file: string; reason: string }>;
}

export interface ClaimedAction {
  turn: number;
  file: string;
  action: "edit" | "create" | "delete" | "inspect";
  context: string;
  verified: boolean;
}

export interface CompletionValidation {
  completedTurns: number;
  problemFiles: number;
  editedFiles: number;
  problemFilesNotTouched: string[];
  verificationScore: number;
}

export interface DerivedFile {
  source: string;
  derived: string;
  relation: string;
  turn: number;
  stale: boolean;
}

// ── State Factory ──────────────────────────────────────────────────────────

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

// ── Phase 2+4 module-level state (artifact validation + coordination) ───────
// These can't be per-session because they're called across turn boundaries
// where ctx may be stale. Kept as simple module-level objects.
// See: src/extensions/tools/timer/index.ts for same pattern.

// Phase 2: claimed actions
const _claimedActions: ClaimedAction[] = [];
const _mismatches: Array<{ turn: number; claimedFile: string; actualFile: string; action: string }> = [];

// Phase 4: derived file coordination
const _derivedFiles: DerivedFile[] = [];
const _staleDerivedFiles: DerivedFile[] = [];
const _coordinationRisks: Array<{ turn: number; source: string; stale: string; relation: string }> = [];

// ── File Extraction ────────────────────────────────────────────────────────

export function extractFileReferences(text: string): string[] {
  const refs: string[] = [];

  const pathPattern = /(?:\.[./]|\/)?[a-zA-Z0-9_\-/.]+\.[a-zA-Z0-9]+/g;
  for (const match of text.matchAll(pathPattern)) {
    const candidate = match[0];
    if (
      candidate.includes(".") &&
      !candidate.startsWith("http") &&
      !candidate.startsWith("www") &&
      !candidate.startsWith("//") &&
      !candidate.includes("://") &&
      candidate.length > 3
    ) {
      refs.push(candidate);
    }
  }

  for (const match of text.matchAll(/(?:at\s+)?(?:.+?\s+)?([a-zA-Z0-9_\-/.]+\.[a-zA-Z0-9]+):(\d+):(\d+)/g)) {
    refs.push(match[1]);
  }

  return [...new Set(refs)];
}

// ── File path helpers ──────────────────────────────────────────────────────

function normalize(p: string): string {
  return p.replace(/^\.\//, "").replace(/^\.\.\//, "").replace(/^\//, "");
}

export function filesAreRelated(a: string, b: string): boolean {
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

function isLikelyFilePath(s: string): boolean {
  return (
    (s.includes("/") || /\.\w+$/.test(s)) &&
    !/^https?:\/\//.test(s) &&
    !/^[A-Z][a-z]+$/.test(s) &&
    s.length > 2
  );
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

// ── Phase 1: File touch tracking ───────────────────────────────────────────

export function updateProblemContext(ctx: ExtensionContext, text: string): void {
  const state = getVerifierState(ctx);
  for (const ref of extractFileReferences(text)) {
    state.problemFiles.add(ref);
  }
}

export function recordFileTouch(
  ctx: ExtensionContext,
  filePath: string,
  turn: number,
  wasEdit: boolean,
): void {
  const state = getVerifierState(ctx);
  state.touchTurns.set(filePath, turn);
  if (wasEdit) state.editedFiles.add(filePath);
  else state.readFiles.add(filePath);
}

export function checkLocalizationRisk(
  ctx: ExtensionContext,
  editedFile: string,
  turn: number,
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

// ── Phase 2: Artifact validation (claimed vs actual edits) ─────────────────

export function extractClaimedActions(text: string, turn: number): ClaimedAction[] {
  const claims: ClaimedAction[] = [];

  const editPatterns = [
    /I('ll| will) (edit|fix|update|modify|change|rewrite)\s+([^\s;!?()]+)/gi,
    /Let me (edit|fix|update|modify|change|rewrite)\s+([^\s;!?()]+)/gi,
    /I need to (edit|fix|update|modify|change|rewrite)\s+([^\s;!?()]+)/gi,
    /We should (edit|fix|update|modify|change|rewrite)\s+([^\s;!?()]+)/gi,
    /Going to (edit|fix|update|modify|change|rewrite)\s+([^\s;!?()]+)/gi,
  ];
  const createPatterns = [
    /I('ll| will) (create|add|write|implement)\s+([^\s;!?()]+)/gi,
    /Let me (create|add|write|implement)\s+([^\s;!?()]+)/gi,
  ];

  for (const pattern of editPatterns) {
    for (const m of text.matchAll(pattern)) {
      const file = m[3] || m[2];
      if (isLikelyFilePath(file)) {
        claims.push({ turn, file, action: "edit", context: m[0].slice(0, 80), verified: false });
      }
    }
  }
  for (const pattern of createPatterns) {
    for (const m of text.matchAll(pattern)) {
      const file = m[3] || m[2];
      if (isLikelyFilePath(file)) {
        claims.push({ turn, file, action: "create", context: m[0].slice(0, 80), verified: false });
      }
    }
  }

  return claims;
}

export function recordClaimedActions(ctx: ExtensionContext, text: string, turn: number): void {
  for (const claim of extractClaimedActions(text, turn)) {
    _claimedActions.push(claim);
  }
  if (_claimedActions.length > 20) {
    _claimedActions.splice(0, _claimedActions.length - 20);
  }
}

export function validateArtifact(
  _ctx: any,
  actualFile: string,
  turn: number,
): string | null {
  const matchingClaims = _claimedActions.filter(
    (c) => !c.verified && (filesAreRelated(c.file, actualFile) || c.file === actualFile),
  );
  if (matchingClaims.length > 0) {
    for (const c of matchingClaims) c.verified = true;
    return null;
  }

  const pendingClaims = _claimedActions.filter((c) => !c.verified);
  if (pendingClaims.length > 0) {
    const pending = pendingClaims[0];
    const mismatch = `Edited "${actualFile}" but claimed "${pending.file}" (${pending.context.slice(0, 40)})`;
    _mismatches.push({
      turn,
      claimedFile: pending.file,
      actualFile,
      action: "edit",
    });
    return mismatch;
  }
  return null;
}

export function getArtifactValidationSummary(): string {
  const verified = _claimedActions.filter((c) => c.verified).length;
  const unverified = _claimedActions.filter((c) => !c.verified).length;
  const lines = [
    `Claimed actions: ${_claimedActions.length}`,
    `Verified: ${verified}`,
    `Unverified: ${unverified}`,
    `Mismatches: ${_mismatches.length}`,
  ];
  for (const m of _mismatches.slice(-3)) {
    lines.push(`  Turn ${m.turn}: claimed "${m.claimedFile}" edited "${m.actualFile}"`);
  }
  return lines.join("\n");
}

// ── Phase 3: Completion validation ─────────────────────────────────────────

export function validateCompletion(ctx: ExtensionContext): CompletionValidation {
  const state = getVerifierState(ctx);
  const editedFiles = [...state.editedFiles];
  const problemFiles = [...state.problemFiles];

  const allTouched = new Set([...state.readFiles, ...state.editedFiles]);
  const problemFilesNotTouched = problemFiles.filter((pf) => {
    for (const touched of allTouched) {
      if (filesAreRelated(pf, touched)) return false;
    }
    return true;
  });

  let score = 1.0;
  if (problemFiles.length > 0) {
    score -= (problemFilesNotTouched.length / problemFiles.length) * 0.5;
  }
  if (state.localizationRisks.length > 0) {
    score -= Math.min(0.3, state.localizationRisks.length * 0.1);
  }
  if (state.editedFiles.size === 0 && state.readFiles.size > 0) {
    score -= 0.2;
  }
  score = Math.max(0, score);

  const turns = [...state.touchTurns.values()];
  return {
    completedTurns: turns.length ? Math.max(...turns) : 0,
    problemFiles: problemFiles.length,
    editedFiles: editedFiles.length,
    problemFilesNotTouched,
    verificationScore: score,
  };
}

// ── Phase 4: Derived file coordination ─────────────────────────────────────

export function recordDerivedFrom(
  derived: string,
  source: string,
  relation: string,
  turn: number,
): void {
  if (_derivedFiles.some((d) => d.derived === derived && d.source === source)) return;
  _derivedFiles.push({ source, derived, relation, turn, stale: true });
}

export function markDerivedResolved(source: string, derived: string): void {
  for (const d of _derivedFiles) {
    if (d.source === source && d.derived === derived) d.stale = false;
  }
}

export function checkCoordinationRisk(
  ctx: ExtensionContext,
  editedFile: string,
  turn: number,
): string | null {
  const state = getVerifierState(ctx);
  const staleDerived = _derivedFiles.filter(
    (d) => d.source === editedFile && d.stale,
  );
  const sourceEditTurn = state.touchTurns.get(editedFile) ?? turn;
  const stillStale: DerivedFile[] = [];

  for (const d of staleDerived) {
    const derivedTouchTurn = state.touchTurns.get(d.derived);
    if (!derivedTouchTurn || derivedTouchTurn < sourceEditTurn) stillStale.push(d);
  }

  if (stillStale.length === 0) return null;

  for (const d of stillStale) d.stale = true;
  _staleDerivedFiles.push(...stillStale);
  _coordinationRisks.push(
    ...stillStale.map((d) => ({
      turn,
      source: d.source,
      stale: d.derived,
      relation: d.relation,
    })),
  );

  return `Coordination risk: ${stillStale.map((r) => `"${r.derived}" (${r.relation}) depends on edited "${r.source}" but wasn't updated`).join("; ")}`;
}

export function scanForDerivedFiles(
  ctx: ExtensionContext,
  readFilePath: string,
  content: string,
  turn: number,
): void {
  const state = getVerifierState(ctx);
  detectImportDerived(readFilePath, content, state.editedFiles, turn);
}

function detectImportDerived(
  readFilePath: string,
  content: string,
  recentlyEditedFiles: Set<string>,
  turn: number,
): void {
  const patterns: Array<{ re: RegExp; label: string }> = [
    { re: /from\s+['"]([^'"]+)['"]/g, label: "import" },
    { re: /require\(['"]([^'"]+)['"]\)/g, label: "require" },
  ];
  for (const { re, label } of patterns) {
    let match;
    while ((match = re.exec(content)) !== null) {
      const imported = match[1];
      if (!imported.startsWith(".")) continue;
      const dir = readFilePath.substring(0, readFilePath.lastIndexOf("/") + 1);
      const resolved = resolveRelativeImport(dir, imported);
      for (const edited of recentlyEditedFiles) {
        if (filesAreRelated(resolved, edited))
          recordDerivedFrom(readFilePath, edited, label, turn);
      }
    }
  }
}

export function getCoordinationCheckSummary(): string {
  if (_derivedFiles.length === 0) return "No derived file relationships tracked.";
  const lines = [
    `Derived relationships: ${_derivedFiles.length}`,
    `Stale derived files: ${_staleDerivedFiles.length}`,
    `Coordination risks: ${_coordinationRisks.length}`,
  ];
  for (const r of _coordinationRisks.slice(-5)) {
    lines.push(`  Turn ${r.turn}: "${r.stale}" depends on "${r.source}" (${r.relation}) — not updated`);
  }
  return lines.join("\n");
}

// ── Combined Report ────────────────────────────────────────────────────────

export function getFullVerificationReport(ctx: ExtensionContext): string {
  const completion = validateCompletion(ctx);
  const lines = [
    "=== Bidirectional Verifier Report ===",
    "",
    "--- Forward Trace ---",
    getTouchGraphSummary(ctx),
    "",
    "--- Artifact Validation ---",
    getArtifactValidationSummary(),
    "",
    "--- Backward Check ---",
    `Problem files touched: ${completion.problemFiles - completion.problemFilesNotTouched.length}/${completion.problemFiles}`,
    ...(completion.problemFilesNotTouched.length > 0
      ? [`Untouched problem files: ${completion.problemFilesNotTouched.join(", ")}`]
      : []),
    `Verification score: ${(completion.verificationScore * 100).toFixed(0)}/100`,
    ...(completion.verificationScore < 0.5 ? ["WARNING: Low verification score"] : []),
    "",
    "--- Coordination Check ---",
    getCoordinationCheckSummary(),
    ...(getCoordinationCheckSummary().includes("risks:")
      ? ["WARNING: Derived files may need updates"]
      : []),
    "",
    "To reset verifier state for a new task, call clearVerifierState().",
  ];
  return lines.join("\n");
}

export function getTouchGraphSummary(ctx: ExtensionContext): string {
  const state = getVerifierState(ctx);
  const lines = [
    `Problem files: ${state.problemFiles.size}`,
    `Read files: ${state.readFiles.size}`,
    `Edited files: ${state.editedFiles.size}`,
    `Localization risks: ${state.localizationRisks.length}`,
  ];
  for (const r of state.localizationRisks.slice(-3)) {
    lines.push(`  Turn ${r.turn}: ${r.reason}`);
  }
  return lines.join("\n");
}

// ── Reset ──────────────────────────────────────────────────────────────────

export function clearVerifierState(ctx: ExtensionContext): void {
  const state = getVerifierState(ctx);
  state.problemFiles.clear();
  state.readFiles.clear();
  state.editedFiles.clear();
  state.touchTurns.clear();
  state.localizationRisks = [];
  _claimedActions.length = 0;
  _mismatches.length = 0;
  _derivedFiles.length = 0;
  _staleDerivedFiles.length = 0;
  _coordinationRisks.length = 0;
}