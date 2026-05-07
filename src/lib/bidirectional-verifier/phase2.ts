/**
 * Bidirectional Verifier — Phase 2: Artifact Validator.
 *
 * Validates that artifacts (written files) match claimed actions.
 * Uses module-level state for cross-turn tracking.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { filesAreRelated } from "./phase1.js";
import type { ClaimedAction, ArtifactValidationState } from "./types.js";

const _validationState: ArtifactValidationState = {
  claimed: [],
  mismatches: [],
};

/** Reset module-level state (used by clearVerifierState). */
export function _resetArtifactState(): void {
  _validationState.claimed = [];
  _validationState.mismatches = [];
}

function isLikelyFilePath(s: string): boolean {
  return (
    (s.includes("/") || /\.\w+$/.test(s)) &&
    !/^https?:\/\//.test(s) &&
    !/^[A-Z][a-z]+$/.test(s) &&
    s.length > 2
  );
}

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
    _validationState.claimed.push(claim);
  }
  if (_validationState.claimed.length > 20) {
    _validationState.claimed = _validationState.claimed.slice(-20);
  }
}

export function validateArtifact(
  ctx: ExtensionContext,
  actualFile: string,
  turn: number,
): string | null {
  const matchingClaims = _validationState.claimed.filter(
    (c) => !c.verified && (filesAreRelated(c.file, actualFile) || c.file === actualFile),
  );
  if (matchingClaims.length > 0) {
    for (const c of matchingClaims) c.verified = true;
    return null;
  }

  const pendingClaims = _validationState.claimed.filter((c) => !c.verified);
  if (pendingClaims.length > 0) {
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
  return null;
}

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
