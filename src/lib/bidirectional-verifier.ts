/**
 * Bidirectional Verifier — file touch tracking for enforcement.
 *
 * Tracks which files the agent reads/edits, checks if edits relate to the
 * problem context, and flags localization risks (editing unrelated files).
 *
 * Previously had 4 phases with module-level state that leaked across sessions.
 * Phase 2 (artifact validation) and Phase 4 (derived file coordination) were
 * never called externally and have been removed.
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

// ── Helpers ────────────────────────────────────────────────────────────────

function normalize(p: string): string {
  return p
    .replace(/^\.\//, "")
    .replace(/^\.\.\//, "")
    .replace(/^\//, "");
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

  for (const match of text.matchAll(
    /(?:at\s+)?(?:.+?\s+)?([a-zA-Z0-9_\-/.]+\.[a-zA-Z0-9]+):(\d+):(\d+)/g,
  )) {
    refs.push(match[1]);
  }

  return [...new Set(refs)];
}

function isLikelyFilePath(s: string): boolean {
  return (
    (s.includes("/") || /\.\w+$/.test(s)) &&
    !/^https?:\/\//.test(s) &&
    !/^[A-Z][a-z]+$/.test(s) &&
    s.length > 2
  );
}

// ── File touch tracking ────────────────────────────────────────────────────

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

// ── Reset ──────────────────────────────────────────────────────────────────

export function clearVerifierState(ctx: ExtensionContext): void {
  const state = getVerifierState(ctx);
  state.problemFiles.clear();
  state.readFiles.clear();
  state.editedFiles.clear();
  state.touchTurns.clear();
  state.localizationRisks = [];
}