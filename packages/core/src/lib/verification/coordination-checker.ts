/**
 * Coordination Checker.
 *
 * Tracks derived-from relationships between files (e.g., a generated file
 * derives from its generator template). When a generator is edited, the
 * checker warns if its derived files have not been updated since the edit.
 *
 * The failure mode: the agent fixes a generator template but forgets to
 * regenerate the output file. This checker catches it before the agent
 * claims done.
 *
 * Current status: `entries` is written only by `registerDerived`, which nothing
 * in the tree calls: no build step or extension registers a relationship, and
 * the state key is module-private, so it cannot be populated from elsewhere.
 * `checkCoordination` therefore returns no warnings for any edit today; the
 * edit path in extensions/enforcement/handlers/register-tool-call.ts is wired
 * and starts warning as soon as a registration exists.
 *
 * Usage:
 *   import { registerDerived, checkCoordination, getCoordinationState } from "./coordination-checker.js";
 *
 *   // In a build step: registerDerived(ctx, "template.tsx", "generated/Output.tsx");
 *   // On edit: const warnings = checkCoordination(ctx, "template.tsx", currentTurn);
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../state/extension-state.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("verification:coordination");

// ── Types ──────────────────────────────────────────────────────────────────

export interface CoordinationEntry {
  /** The generator file path (normalized). */
  generator: string;
  /** The derived/generated file path (normalized). */
  derived: string;
  /** Turn when this relationship was registered. */
  registeredTurn: number;
  /** Turn when the derived file was last known to be updated (0 = never). */
  lastDerivedUpdatedTurn: number;
}

export interface CoordinationState {
  /** Registered derived-from relationships. */
  entries: CoordinationEntry[];
  /** Set of turns when each file was last edited (from file-touch tracking). */
  fileEditTurns: Map<string, number>;
}

export interface CoordinationWarning {
  generator: string;
  derived: string;
  message: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const COORDINATION_STATE_KEY = "verification-coordination";

// ── State Factory ──────────────────────────────────────────────────────────

function createState(): CoordinationState {
  return {
    entries: [],
    fileEditTurns: new Map(),
  };
}

export function getCoordinationState(ctx: ExtensionContext): CoordinationState {
  return getExtensionState(ctx, COORDINATION_STATE_KEY, createState);
}

// ── Path Normalization ─────────────────────────────────────────────────────

function normalize(p: string): string {
  return p.replace(/^\.\//, "").replace(/^\.\.\//, "");
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Register a derived-from relationship.
 *
 * @param ctx - Extension context
 * @param generator - Path to the generator/template file (e.g., "src/template.tsx")
 * @param derived - Path to the derived/generated file (e.g., "generated/Output.tsx")
 */
export function registerDerived(ctx: ExtensionContext, generator: string, derived: string): void {
  const state = getCoordinationState(ctx);
  const gen = normalize(generator);
  const der = normalize(derived);

  // Avoid duplicates
  const exists = state.entries.some((e) => e.generator === gen && e.derived === der);
  if (exists) return;

  state.entries.push({
    generator: gen,
    derived: der,
    registeredTurn: getCurrentTurn(ctx),
    lastDerivedUpdatedTurn: 0,
  });

  log.info(`Registered derived: ${gen} -> ${der}`);
}

/**
 * Record that a file was edited at the given turn.
 * Called by the enforcement handler alongside recordFileTouch.
 */
export function recordCoordinationEdit(
  ctx: ExtensionContext,
  filePath: string,
  turn: number,
): void {
  const state = getCoordinationState(ctx);
  state.fileEditTurns.set(normalize(filePath), turn);

  // If an edited file is a derived file, update its lastDerivedUpdatedTurn
  const fp = normalize(filePath);
  for (const entry of state.entries) {
    if (entry.derived === fp) {
      entry.lastDerivedUpdatedTurn = turn;
    }
  }
}

/**
 * Check if editing a file would leave stale derived files behind.
 * Returns warnings for each derived relationship where the generator
 * was edited after the derived file was last updated.
 *
 * @param ctx - Extension context
 * @param editedFile - The file that was just edited
 * @param currentTurn - Current turn number
 * @returns Array of coordination warnings (empty if none)
 */
export function checkCoordination(
  ctx: ExtensionContext,
  editedFile: string,
  currentTurn: number,
): CoordinationWarning[] {
  const state = getCoordinationState(ctx);
  const fp = normalize(editedFile);
  const warnings: CoordinationWarning[] = [];

  const generatorEntries = state.entries.filter((e) => e.generator === fp);

  for (const entry of generatorEntries) {
    const editTurn = state.fileEditTurns.get(fp) ?? currentTurn;

    // If the derived file was never updated, or was updated before this edit
    if (entry.lastDerivedUpdatedTurn === 0 || entry.lastDerivedUpdatedTurn < editTurn) {
      const warning: CoordinationWarning = {
        generator: entry.generator,
        derived: entry.derived,
        message:
          `Coordination: "${entry.generator}" was edited but derived file ` +
          `"${entry.derived}" has not been updated since. ` +
          `If "${entry.derived}" is generated from "${entry.generator}", ` +
          `you may need to regenerate it.`,
      };
      warnings.push(warning);
    }
  }

  if (warnings.length > 0) {
    log.info(`Coordination warnings for ${fp}: ${warnings.length}`);
  }

  return warnings;
}

/**
 * Get the current turn number from the extension context.
 * Falls back to 0 if not available.
 */
function getCurrentTurn(ctx: ExtensionContext): number {
  const enforcementState = getExtensionState(ctx, "enforcement", () => ({})) as any;
  return enforcementState.currentTurn ?? 0;
}
