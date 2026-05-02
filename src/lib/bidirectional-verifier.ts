/**
 * Bidirectional Verifier — Phase 1: Forward Trace + Phase 2: Artifact Validator + Phase 3: Backward Checker
 *
 * Tracks the agent's file touch graph and compares it against the
 * problem-relevant file set. Flags localization risk when the agent
 * touches files unrelated to the reported problem.
 *
 * Phase 2: Validates that artifacts (written files) match claimed actions.
 * Phase 3: Checks that completed tasks address the original problem.
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

// ── Phase 2: Artifact Validator ──────────────────────────────────────────────
// Validates that written files match the agent's claimed actions.
// After the agent says "I will edit X" and actually edits Y, flag the mismatch.

interface ClaimedAction {
  turn: number;
  file: string;
  action: "edit" | "create" | "delete" | "inspect";
  context: string; // snippet of what the agent said
  verified: boolean; // was this action actually performed?
}

interface ArtifactValidation {
  claimed: ClaimedAction[];
  mismatches: Array<{
    turn: number;
    claimedFile: string;
    actualFile: string;
    action: string;
  }>;
}

const _validationState: ArtifactValidation = {
  claimed: [],
  mismatches: [],
};

/**
 * Extract claimed file actions from assistant text.
 * Parses patterns like "I'll edit /path/to/file.ts", "Let me fix src/foo.ts", etc.
 */
export function extractClaimedActions(text: string, turn: number): ClaimedAction[] {
  const claims: ClaimedAction[] = [];

  // Pattern: "I will edit <file>", "Let me fix <file>", "I need to update <file>"
  const editPatterns = [
    /I('ll| will) (edit|fix|update|modify|change|rewrite)\s+([^\s;!?()]+)/gi,
    /Let me (edit|fix|update|modify|change|rewrite)\s+([^\s;!?()]+)/gi,
    /I need to (edit|fix|update|modify|change|rewrite)\s+([^\s;!?()]+)/gi,
    /We should (edit|fix|update|modify|change|rewrite)\s+([^\s;!?()]+)/gi,
    /Going to (edit|fix|update|modify|change|rewrite)\s+([^\s;!?()]+)/gi,
  ];

  // Pattern: "I will create <file>", "Let me add <file>"
  const createPatterns = [
    /I('ll| will) (create|add|write|implement)\s+([^\s;!?()]+)/gi,
    /Let me (create|add|write|implement)\s+([^\s;!?()]+)/gi,
  ];

  for (const pattern of editPatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const file = m[3] || m[2];
      if (isLikelyFilePath(file)) {
        claims.push({ turn, file, action: "edit", context: m[0].slice(0, 80), verified: false });
      }
    }
  }

  for (const pattern of createPatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const file = m[3] || m[2];
      if (isLikelyFilePath(file)) {
        claims.push({ turn, file, action: "create", context: m[0].slice(0, 80), verified: false });
      }
    }
  }

  return claims;
}

/**
 * Simple heuristic to check if a string looks like a file path.
 */
function isLikelyFilePath(s: string): boolean {
  return (
    (s.includes("/") || /\.\w+$/.test(s)) &&
    !/^https?:\/\//.test(s) &&
    !/^[A-Z][a-z]+$/.test(s) &&
    s.length > 2
  );
}

/**
 * Record claimed actions from an assistant message for later verification.
 */
export function recordClaimedActions(ctx: ExtensionContext, text: string, turn: number): void {
  const claims = extractClaimedActions(text, turn);
  for (const claim of claims) {
    _validationState.claimed.push(claim);
  }
  // Prune old claims (keep last 20)
  if (_validationState.claimed.length > 20) {
    _validationState.claimed = _validationState.claimed.slice(-20);
  }
}

/**
 * Validate an artifact edit against claimed actions.
 * If the agent claimed to edit X but actually edited Y, flag as mismatch.
 */
export function validateArtifact(
  ctx: ExtensionContext,
  actualFile: string,
  turn: number,
): string | null {
  // Check against unverified claims
  const matchingClaims = _validationState.claimed.filter(
    (c) => !c.verified && (filesAreRelated(c.file, actualFile) || c.file === actualFile),
  );

  if (matchingClaims.length > 0) {
    // Mark as verified
    for (const c of matchingClaims) c.verified = true;
    return null; // File matches a claim — no issue
  }

  // No matching claim — check if this was unexpected
  const pendingClaims = _validationState.claimed.filter((c) => !c.verified);
  if (pendingClaims.length > 0) {
    // Agent edited a file it didn't claim, while having pending claims
    const pending = pendingClaims[0];
    const mismatch = `Edited "${actualFile}" but claimed "${pending.file}" (${pending.context.slice(0, 40)})`;
    _validationState.mismatches.push({
      turn,
      claimedFile: pending.file,
      actualFile,
      action: "edit",
    });
    return mismatch;
  }

  return null; // No claims, no mismatch
}

/**
 * Get all artifact validation results.
 */
export function getArtifactValidationSummary(): string {
  const lines: string[] = [];
  lines.push(`Claimed actions: ${_validationState.claimed.length}`);
  lines.push(`Verified: ${_validationState.claimed.filter((c) => c.verified).length}`);
  lines.push(`Unverified: ${_validationState.claimed.filter((c) => !c.verified).length}`);
  lines.push(`Mismatches: ${_validationState.mismatches.length}`);

  if (_validationState.mismatches.length > 0) {
    for (const m of _validationState.mismatches.slice(-3)) {
      lines.push(`  Turn ${m.turn}: claimed "${m.claimedFile}" edited "${m.actualFile}"`);
    }
  }
  return lines.join("\n");
}

// ── Phase 3: Backward Checker ────────────────────────────────────────────────
// After completion, checks that the changes actually address the problem.

interface CompletionValidation {
  completedTurns: number;
  problemFiles: number;
  editedFiles: number;
  problemFilesNotTouched: string[];
  verificationScore: number; // 0-1
}

/**
 * Validate a completed task against the problem context.
 * Checks: did the agent touch the correct files?
 *          are there problem files that were never touched?
 */
export function validateCompletion(ctx: ExtensionContext): CompletionValidation {
  const state = getVerifierState(ctx);
  const editedFiles = [...state.editedFiles];
  const problemFiles = [...state.problemFiles];

  // Find problem files that were NEVER touched (read or edited)
  const allTouched = new Set([...state.readFiles, ...state.editedFiles]);
  const problemFilesNotTouched = problemFiles.filter((pf) => {
    for (const touched of allTouched) {
      if (filesAreRelated(pf, touched)) return false;
    }
    return true;
  });

  // Compute verification score
  let score = 1.0;
  if (problemFiles.length > 0) {
    const missed = problemFilesNotTouched.length;
    score -= (missed / problemFiles.length) * 0.5; // -0.5 per missed problem file ratio
  }
  if (state.localizationRisks.length > 0) {
    score -= Math.min(0.3, state.localizationRisks.length * 0.1); // -0.1 per localization risk
  }
  if (state.editedFiles.size === 0 && state.readFiles.size > 0) {
    score -= 0.2; // Read but never edited — didn't actually fix anything
  }
  score = Math.max(0, score);

  return {
    completedTurns: state.touchTurns.size ? Math.max(...state.touchTurns.values()) : 0,
    problemFiles: problemFiles.length,
    editedFiles: editedFiles.length,
    problemFilesNotTouched,
    verificationScore: score,
  };
}

// ── Phase 4: Coordination Checker ────────────────────────────────────────────
// After a fix, check: are all derived/generated files updated?
// Tracks "derived-from" relationships: if B imports A, B is derived from A.
// If A is edited and B is NOT touched, flag as coordination risk.

interface DerivedFile {
  source: string;     // The file that was edited
  derived: string;    // The file that depends on it
  relation: string;   // "import", "generate", "inherit", "config"
  turn: number;
  stale: boolean;     // True if derived wasn't touched after source edit
}

interface CoordinationCheck {
  derivedFiles: DerivedFile[];
  staleDerivedFiles: DerivedFile[];
  coordinationRisks: Array<{
    turn: number;
    source: string;
    stale: string;
    relation: string;
  }>;
}

// Module-level state for coordination checker
const _coordinationState: CoordinationCheck = {
  derivedFiles: [],
  staleDerivedFiles: [],
  coordinationRisks: [],
};

/**
 * Record that `derivedFile` is derived from `sourceFile`.
 * Used when the agent explicitly notes a dependency,
 * or when auto-detected from imports.
 */
export function recordDerivedFrom(
  derived: string,
  source: string,
  relation: string,
  turn: number,
): void {
  // Avoid duplicates
  const exists = _coordinationState.derivedFiles.find(
    (d) => d.derived === derived && d.source === source,
  );
  if (exists) return;

  _coordinationState.derivedFiles.push({
    source,
    derived,
    relation,
    turn,
    stale: true, // Starts stale until verified
  });
}

/**
 * Clear stale flags for all derived files touching a source.
 * Called when the agent touches a file that may resolve derived dependencies.
 */
export function markDerivedResolved(source: string, derived: string): void {
  for (const d of _coordinationState.derivedFiles) {
    if (d.source === source && d.derived === derived) {
      d.stale = false;
    }
  }
}

/**
 * Auto-detect derived files from file content (import scanning).
 * Scans the read file for imports of recently-edited files.
 */
function detectImportDerived(
  readFilePath: string,
  content: string,
  recentlyEditedFiles: Set<string>,
  turn: number,
): void {
  // Match: import ... from "relative/path"
  const importRegex = /from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const imported = match[1];
    if (!imported.startsWith(".")) continue; // Skip non-relative imports

    // Resolve relative import against read file's directory
    const dir = readFilePath.substring(0, readFilePath.lastIndexOf("/") + 1);
    const resolved = resolveRelativeImport(dir, imported);

    // Check if the imported file was recently edited
    for (const edited of recentlyEditedFiles) {
      if (filesAreRelated(resolved, edited)) {
        recordDerivedFrom(readFilePath, edited, "import", turn);
      }
    }
  }

  // Match: require("relative/path") or require('./path')
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    const imported = match[1];
    if (!imported.startsWith(".")) continue;
    const dir = readFilePath.substring(0, readFilePath.lastIndexOf("/") + 1);
    const resolved = resolveRelativeImport(dir, imported);
    for (const edited of recentlyEditedFiles) {
      if (filesAreRelated(resolved, edited)) {
        recordDerivedFrom(readFilePath, edited, "require", turn);
      }
    }
  }
}

/**
 * Resolve a relative import path against a directory.
 */
function resolveRelativeImport(dir: string, importPath: string): string {
  // Normalize: remove ./ prefix, resolve ../ up one level
  let resolved = importPath;
  if (resolved.startsWith("./")) resolved = resolved.slice(2);
  while (resolved.startsWith("../")) {
    resolved = resolved.slice(3);
    const parts = dir.split("/");
    if (parts.length > 1) {
      dir = parts.slice(0, -2).join("/") + "/";
    }
  }
  return dir + resolved;
}

/**
 * After a file is edited, check for stale derived files.
 * Returns coordination risks if any exist.
 */
export function checkCoordinationRisk(
  ctx: ExtensionContext,
  editedFile: string,
  turn: number,
): string | null {
  const state = getVerifierState(ctx);

  // Find derived files that depend on the edited file and are still stale
  const staleDerived = _coordinationState.derivedFiles.filter(
    (d) => d.source === editedFile && d.stale,
  );

  // Check if any of these derived files were touched AFTER the source edit
  const sourceEditTurn = state.touchTurns.get(editedFile) ?? turn;
  const stillStale: DerivedFile[] = [];
  for (const d of staleDerived) {
    const derivedTouchTurn = state.touchTurns.get(d.derived);
    if (!derivedTouchTurn || derivedTouchTurn < sourceEditTurn) {
      stillStale.push(d);
    }
  }

  if (stillStale.length === 0) return null;

  // Build coordination risk descriptions
  const risks: Array<{ source: string; stale: string; relation: string }> = [];
  for (const d of stillStale) {
    risks.push({ source: d.source, stale: d.derived, relation: d.relation });
    d.stale = true; // Keep as stale
  }

  _coordinationState.staleDerivedFiles.push(...stillStale);
  _coordinationState.coordinationRisks.push(
    ...risks.map((r) => ({ turn, ...r })),
  );

  const riskDesc = risks
    .map((r) => `"${r.stale}" (${r.relation}) depends on edited "${r.source}" but wasn't updated`)
    .join("; ");

  return `Coordination risk: ${riskDesc}`;
}

/**
 * Auto-scan a read file for imports of recently-edited files.
 * Called externally when agent reads a file.
 */
export function scanForDerivedFiles(
  ctx: ExtensionContext,
  readFilePath: string,
  content: string,
  turn: number,
): void {
  const state = getVerifierState(ctx);
  detectImportDerived(readFilePath, content, state.editedFiles, turn);
}

/**
 * Get a summary of coordination checks (Phase 4).
 */
export function getCoordinationCheckSummary(): string {
  const lines: string[] = [];

  if (_coordinationState.derivedFiles.length === 0) {
    return "No derived file relationships tracked.";
  }

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

/**
 * Get a combined verification report (Phases 1-4).
 */
export function getFullVerificationReport(ctx: ExtensionContext): string {
  const touchGraph = getTouchGraphSummary(ctx);
  const artifactValidation = getArtifactValidationSummary();
  const completion = validateCompletion(ctx);
  const coordinationCheck = getCoordinationCheckSummary();

  const lines: string[] = [];
  lines.push("=== Bidirectional Verifier Report ===");
  lines.push("");
  lines.push("--- Forward Trace (Phase 1) ---");
  lines.push(touchGraph);
  lines.push("");
  lines.push("--- Artifact Validation (Phase 2) ---");
  lines.push(artifactValidation);
  lines.push("");
  lines.push("--- Backward Check (Phase 3) ---");
  lines.push(`Problem files touched: ${completion.problemFiles - completion.problemFilesNotTouched.length}/${completion.problemFiles}`);
  if (completion.problemFilesNotTouched.length > 0) {
    lines.push(`Untouched problem files: ${completion.problemFilesNotTouched.join(", ")}`);
  }
  lines.push(`Verification score: ${(completion.verificationScore * 100).toFixed(0)}/100`);
  if (completion.verificationScore < 0.5) {
    lines.push("WARNING: Low verification score — fix may not address the problem");
  }
  lines.push("");
  lines.push("--- Coordination Check (Phase 4) ---");
  lines.push(coordinationCheck);
  if (_coordinationState.coordinationRisks.length > 0) {
    lines.push("WARNING: Derived files may need updates — coordination risk detected");
  }
  lines.push("");
  lines.push("To reset verifier state for a new task, call clearVerifierState().");

  return lines.join("\n");
}

/**
 * Reset all verifier state (for new tasks/sessions).
 */
export function clearVerifierState(ctx: ExtensionContext): void {
  const state = getVerifierState(ctx);
  state.problemFiles.clear();
  state.readFiles.clear();
  state.editedFiles.clear();
  state.touchTurns.clear();
  state.localizationRisks = [];
  _validationState.claimed = [];
  _validationState.mismatches = [];
  _coordinationState.derivedFiles = [];
  _coordinationState.staleDerivedFiles = [];
  _coordinationState.coordinationRisks = [];
}
