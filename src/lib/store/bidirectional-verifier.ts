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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "../state/extension-state.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("bidirectional-verifier");

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

// ═════════════════════════════════════════════════════════════════════════
// Phase 2 (replacement): OpenSpec spec parsing and verification
// ═════════════════════════════════════════════════════════════════════════

// ── Spec parsing types ─────────────────────────────────────────────────

export interface ParsedRequirement {
  name: string;
  strength: "SHALL" | "MUST" | "SHOULD" | "MAY";
  text: string;
  scenarios: Array<{ title: string; given: string; when: string; then: string[] }>;
}

export interface ParsedSpec {
  purpose: string;
  domain?: string;
  requirements: ParsedRequirement[];
}

export interface SpecValidationResult {
  requirement: string;
  domain: string;
  strength: string;
  covered: boolean;
  message: string;
}

/**
 * Parse a spec.md file into structured requirements.
 * Understands OpenSpec format: SHALL/MUST/SHOULD/MAY keywords,
 * ### Requirement: <name> headers, #### Scenario: <title> blocks.
 */
export function parseSpec(text: string): ParsedSpec {
  const purposeMatch = text.match(/## Purpose\s+([^#]+)/);
  const purpose = purposeMatch ? purposeMatch[1].trim() : "";

  const requirements: ParsedRequirement[] = [];

  // Match requirement blocks: ### Requirement: <name> ... (next ### or end)
  const reqRegex = /### Requirement: ([^\n]+)\s*\n([\s\S]*?)(?=\n### |$)/g;
  let match;
  while ((match = reqRegex.exec(text)) !== null) {
    const name = match[1].trim();
    const body = match[2].trim();

    // Determine requirement strength from SHALL/MUST/SHOULD/MAY
    let strength: ParsedRequirement["strength"] = "MAY";
    if (/\bSHALL\b/.test(body)) strength = "SHALL";
    else if (/\bMUST\b/.test(body)) strength = "MUST";
    else if (/\bSHOULD\b/.test(body)) strength = "SHOULD";

    // Extract scenarios
    const scenarios: Array<{ title: string; given: string; when: string; then: string[] }> = [];
    const scRegex = /#### Scenario: ([^\n]+)\s*\n([\s\S]*?)(?=\n#### |$)/g;
    let scMatch;
    while ((scMatch = scRegex.exec(body)) !== null) {
      const title = scMatch[1].trim();
      const scBody = scMatch[2];
      const given = scBody.match(/- GIVEN ([^\n]+)/)?.[1]?.trim() ?? "";
      const when = scBody.match(/- WHEN ([^\n]+)/)?.[1]?.trim() ?? "";
      const thens: string[] = [];
      const thenRegex = /- THEN ([^\n]+)/g;
      let tMatch;
      while ((tMatch = thenRegex.exec(scBody)) !== null) {
        thens.push(tMatch[1].trim());
      }
      const andRegex = /- AND ([^\n]+)/g;
      let aMatch;
      while ((aMatch = andRegex.exec(scBody)) !== null) {
        thens.push(aMatch[1].trim());
      }
      scenarios.push({ title, given, when, then: thens });
    }

    requirements.push({ name, strength, text: body, scenarios });
  }

  return { purpose, requirements };
}

/**
 * Load and parse all spec files from openspec/specs/<domain>/spec.md
 * Returns empty array if openspec/ directory doesn't exist.
 */
export function loadSpecs(ctx: ExtensionContext): ParsedSpec[] {
  const specsDir = join(ctx.cwd, "openspec", "specs");
  if (!existsSync(specsDir)) return [];

  const specs: ParsedSpec[] = [];
  try {
    const domains = readdirSync(specsDir, { withFileTypes: true });
    for (const domain of domains) {
      if (!domain.isDirectory()) continue;
      const specPath = join(specsDir, domain.name, "spec.md");
      if (!existsSync(specPath)) continue;
      const content = readFileSync(specPath, "utf-8");
      const parsed = parseSpec(content);
      parsed.domain = domain.name;
      specs.push(parsed);
    }
  } catch (err) {
    log.warn(`Failed to load specs: ${(err as Error).message}`);
  }

  return specs;
}

/**
 * Check if edited files have spec coverage.
 * Returns violations when edits touch a domain without updating the spec.
 */
export function checkSpecCoverage(
  editedFiles: string[],
  specs: ParsedSpec[],
): SpecValidationResult[] {
  if (specs.length === 0) return [];

  const results: SpecValidationResult[] = [];

  for (const spec of specs) {
    // Check if any edited file matches this spec's domain
    const matchesDomain = editedFiles.some(
      (f) => f.startsWith(`src/extensions/${spec.domain}`) || f.includes(`/specs/${spec.domain}/`),
    );

    if (!matchesDomain) continue;

    // Check each requirement for coverage
    for (const req of spec.requirements) {
      if (req.strength === "MAY") continue; // optional requirements don't need verification
      if (req.scenarios.length === 0) continue; // no scenarios = can't verify

      results.push({
        requirement: req.name,
        domain: spec.domain ?? "unknown",
        strength: req.strength,
        covered: true, // file touched, trust edit intent
        message: `${req.strength}: ${req.name}`,
      });
    }
  }

  return results;
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
