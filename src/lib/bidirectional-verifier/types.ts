/**
 * Bidirectional Verifier — types shared across all phases.
 */

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

export interface ArtifactValidationState {
  claimed: ClaimedAction[];
  mismatches: Array<{ turn: number; claimedFile: string; actualFile: string; action: string }>;
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

export interface CoordinationCheckState {
  derivedFiles: DerivedFile[];
  staleDerivedFiles: DerivedFile[];
  coordinationRisks: Array<{ turn: number; source: string; stale: string; relation: string }>;
}
