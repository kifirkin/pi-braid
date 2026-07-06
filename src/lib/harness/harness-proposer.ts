/**
 * Harness Proposer — Phase 2 of the Self-Harness Loop (LP-1).
 *
 * Takes actionable WeaknessCluster[] and generates K parallel candidate
 * edits to the suggested editable surfaces. Uses the utility + session
 * model in a proposer role, inspired by the Self-Harness paper (2606.09498)
 * §3.2: "For each weakness cluster, the model generates K candidate
 * harness improvements, each grounded in a specific failure pattern and
 * targeted at one editable surface."
 *
 * Design decisions:
 *   - K=3: conservative starting point per cluster. The paper uses K=5
 *     but K=3 is sufficient for Phase 2 validation.
 *   - One LLM call per cluster (not per candidate). The model generates
 *     all K candidates in one response, parsed by structure markers.
 *   - Only processes clusters with `hasProposal === false` and
 *     `severity >= ACTIONABLE_SEVERITY`.
 *   - No side effects: returns proposals that the caller persists to
 *     HarnessState.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callLlm } from "../ai/llm-call.js";
import { resolveUtilityModel } from "../ai/model-resolver.js";
import { nextId } from "../utils/id.js";
import { createLogger } from "../core/logger.js";
import type {
  WeaknessCluster,
  HarnessProposal,
  CandidateEdit,
  ProposalEffort,
} from "./types.js";

const log = createLogger("harness:proposer");

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum severity for a cluster to generate proposals. */
const ACTIONABLE_SEVERITY = 0.5;

/** Number of candidate edits to generate per cluster. */
const K_CANDIDATES = 3;

/** Maximum characters for the surface context snippet. */
const MAX_SURFACE_CONTEXT_CHARS = 2000;

/** LLM call timeout in ms — proposer should be fast, not exhaustive. */
const PROPOSER_TIMEOUT_MS = 15_000;

/**
 * Maximum tokens for the proposer response.
 * Each candidate is ~100-200 chars; K=3 is ~600 chars (~150 tokens).
 * Add overhead for rationale and structure => 512 tokens is safe.
 */
const PROPOSER_MAX_TOKENS = 512;

// ── Surface Context Reading ──────────────────────────────────────────────────

/**
 * Read a snippet of the current editable surface for context.
 * The proposer uses this to understand what the current configuration
 * looks like before suggesting changes.
 */
function readSurfaceContext(
  _ctx: ExtensionContext,
  surface: string,
): string {
  // In a full implementation, this would read from the actual files.
  // For Phase 2, we return a descriptive placeholder that tells the
  // proposer what kind of surface this is and where to find it.
  switch (surface) {
    case "system-prompt":
      return "System prompt (identity.ts): defines agent identity, interaction style, " +
        "behavioral invariants (TRUTH_FIRST, SCOPES, etc.), and framework-first rule. " +
        "Edits add new directives or invariants.";
    case "tool-description":
      return "Tool descriptions (registered in tool registry): each tool has a " +
        "description string visible to the agent. Edits modify the description to " +
        "guide tool usage more precisely.";
    case "enforcement-signal":
      return "Enforcement signals (turn-end-handler.ts, signals.ts): threshold-based " +
        "detection of agent patterns (tool loops, error bursts, etc.). Edits adjust " +
        "thresholds or add new detection rules.";
    case "heuristic":
      return "Heuristic rules (evolver.ts, three-memory-stores): priority-ranked rules " +
        "that guide agent behavior. Edits add/modify heuristic entries.";
    case "whisper-message":
      return "Whisper messages (injection-tracker): messages shown to the agent during " +
        "runtime. Edits change the content or tone of these messages.";
    default:
      return "Unknown surface.";
  }
}

// ── Prompt Construction ─────────────────────────────────────────────────────

/**
 * Build the system prompt for the proposer LLM call.
 */
function buildProposerSystemPrompt(): string {
  return [
    "You are a harness proposer for an LLM agent system. Your role is to suggest",
    "improvements to the agent's configuration to fix systemic weaknesses.",
    "",
    "For each weakness cluster, generate EXACTLY 3 candidate edits.",
    "Each candidate must be:",
    "- Grounded in the specific failure pattern described",
    "- Targeted at the suggested editable surface",
    "- Minimal — the smallest change likely to fix the pattern",
    "- Specific — concrete text or configuration, not general advice",
    "",
    "Format each candidate as follows (use these exact markers):",
    "",
    "--- CANDIDATE 1 ---",
    "Label: <short label>",
    "Change: <the proposed new content, directive, or configuration>",
    "Rationale: <why this fixes the weakness>",
    "Effort: <simple|moderate|complex>",
    "--- END CANDIDATE ---",
    "",
    "Repeat for CANDIDATE 2 and CANDIDATE 3.",
  ].join("\n");
}

/**
 * Build the user prompt for a specific cluster.
 */
function buildProposerUserPrompt(
  cluster: WeaknessCluster,
  surfaceContext: string,
): string {
  const sigs = cluster.signatures.slice(0, 5); // Use up to 5 examples
  const sigDetails = sigs
    .map(
      (s, i) =>
        `  ${i + 1}. [turn ${s.turn}] ${s.type}: "${s.message}" (tool: ${s.toolName ?? "N/A"}, count: ${s.count})`,
    )
    .join("\n");

  return [
    `Weakness: ${cluster.label}`,
    `Type: ${cluster.type}`,
    `Severity: ${cluster.severity.toFixed(2)}`,
    `Frequency: ${cluster.frequency}x`,
    `Target surface: ${cluster.suggestedSurface}`,
    "",
    `Failure signatures (${sigs.length} of ${cluster.signatures.length}):`,
    sigDetails,
    "",
    `Current surface context:`,
    surfaceContext,
    "",
    `Generate ${K_CANDIDATES} candidate edits that would fix this weakness pattern.`,
  ].join("\n");
}

// ── Response Parsing ─────────────────────────────────────────────────────────

/**
 * Parse an LLM response into candidate edits.
 * Expected format:
 *   --- CANDIDATE 1 ---
 *   Label: ...
 *   Change: ...
 *   Rationale: ...
 *   Effort: ...
 *   --- END CANDIDATE ---
 *
 * Exported for testing. Use generateProposal() for production calls.
 * @internal
 */
export function parseCandidates(raw: string, surface: string): CandidateEdit[] {
  const candidates: CandidateEdit[] = [];
  const blocks = raw.split(/--- CANDIDATE \d+ ---/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith("--- END")) continue;

    // Extract fields via simple line-by-line parsing
    const labelMatch = trimmed.match(/Label:\s*(.+)/i);
    const changeMatch = trimmed.match(/Change:\s*([\s\S]*?)(?=\nRationale:)/i);
    const rationaleMatch = trimmed.match(/Rationale:\s*(.+)/i);
    const effortMatch = trimmed.match(/Effort:\s*(.+)/i);

    if (!changeMatch && !labelMatch) continue; // Not a valid block

    const label = labelMatch?.[1]?.trim() ?? `candidate-${candidates.length + 1}`;
    const change = changeMatch?.[1]?.trim() ?? "";
    const rationale = rationaleMatch?.[1]?.trim() ?? "Addresses the weakness pattern";
    const effortRaw = effortMatch?.[1]?.trim().toLowerCase() ?? "moderate";
    const effort: ProposalEffort = ["simple", "moderate", "complex"].includes(effortRaw)
      ? (effortRaw as ProposalEffort)
      : "moderate";

    if (!change) continue;

    candidates.push({
      id: nextId("cedit"),
      label,
      surface: surface as any,
      proposedChange: change,
      description: label,
      rationale,
      effort,
    });
  }

  return candidates;
}

// ── Proposal Generation ──────────────────────────────────────────────────────

/**
 * Generate a harness proposal for a single weakness cluster.
 * Makes one LLM call to generate K candidate edits.
 *
 * @returns A HarnessProposal with K candidates, or null if generation fails.
 */
export async function generateProposal(
  ctx: ExtensionContext,
  cluster: WeaknessCluster,
  currentTurn: number,
): Promise<HarnessProposal | null> {
  if (cluster.severity < ACTIONABLE_SEVERITY) {
    log.debug(`Skipping low-severity cluster: ${cluster.label} (${cluster.severity.toFixed(2)})`);
    return null;
  }

  const surfaceContext = readSurfaceContext(ctx, cluster.suggestedSurface).slice(
    0,
    MAX_SURFACE_CONTEXT_CHARS,
  );

  const systemPrompt = buildProposerSystemPrompt();
  const userPrompt = buildProposerUserPrompt(cluster, surfaceContext);

  // Resolve model: prefer utility, fall back to session
  const utilityModel = resolveUtilityModel(ctx);
  const model = utilityModel ?? ctx.model;

  if (!model) {
    log.warn("No model available for proposal generation");
    return null;
  }

  const modelProvider = model.provider;
  if (!modelProvider) {
    log.warn("Model has no provider");
    return null;
  }

  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(modelProvider).catch(() => {
    log.warn("Could not resolve API key");
    return null as unknown as string;
  });
  if (!apiKey) {
    log.warn(`No API key for provider ${modelProvider}`);
    return null;
  }

  try {
    log.info(`Generating proposals for cluster: ${cluster.label} (surface: ${cluster.suggestedSurface})`);

    const result = await callLlm(
      model,
      apiKey,
      systemPrompt,
      userPrompt,
      {
        maxTokens: PROPOSER_MAX_TOKENS,
        timeoutMs: PROPOSER_TIMEOUT_MS,
      },
    );

    if ("error" in result) {
      log.warn(`Proposal generation failed: ${result.error}`);
      return null;
    }

    const candidates = parseCandidates(result.text, cluster.suggestedSurface);

    if (candidates.length === 0) {
      log.warn(`No candidates parsed from proposer response for ${cluster.label}`);
      return null;
    }

    const proposal: HarnessProposal = {
      id: nextId("hprop"),
      clusterId: cluster.id,
      label: cluster.label,
      candidates,
      status: "pending",
      creationTurn: currentTurn,
      updatedTurn: currentTurn,
    };

    log.info(
      `Generated proposal ${proposal.id}: ${candidates.length} candidates for ${cluster.label}`,
    );

    return proposal;
  } catch (err) {
    log.warn(`Proposal generation exception: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Generate proposals for all actionable clusters that don't yet have one.
 * Processes clusters in severity order (highest first), with a cap on
 * concurrent LLM calls.
 *
 * @param ctx - Extension context
 * @param clusters - All mined clusters
 * @param existingProposals - Already-generated proposals (to check clusterId)
 * @param currentTurn - Current turn number
 * @param maxClusters - Max clusters to process (default: 1 per call, keeps latency bounded)
 * @returns New proposals generated this call
 */
export async function generateAllPendingProposals(
  ctx: ExtensionContext,
  clusters: WeaknessCluster[],
  existingProposals: HarnessProposal[],
  currentTurn: number,
  maxClusters: number = 1,
): Promise<HarnessProposal[]> {
  const processedClusterIds = new Set(existingProposals.map((p) => p.clusterId));

  const pendingClusters = clusters
    .filter((c) => !processedClusterIds.has(c.id) && c.severity >= ACTIONABLE_SEVERITY)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, maxClusters);

  if (pendingClusters.length === 0) {
    return [];
  }

  log.info(`Generating proposals for ${pendingClusters.length} pending cluster(s)`);

  const proposals: HarnessProposal[] = [];

  for (const cluster of pendingClusters) {
    const proposal = await generateProposal(ctx, cluster, currentTurn);
    if (proposal) {
      proposals.push(proposal);
    }
  }

  return proposals;
}