/**
 * ODAR (Optimal Depth Allocation Routing) and budget helpers.
 *
 * ODAR maps a task description to a complexity score (0-1) and a depth
 * level (quick | standard | deep). The depth level is then mapped to
 * a per-step token budget + guidance via DEPTH_BUDGETS.
 *
 * The complexity score uses keyword counting (high/medium technical
 * terms), length signal, multi-step indicators, and question count.
 * Not a learned routing algorithm -- heuristic. Saves 30-60% tokens on
 * simple tasks by routing to the fast system.
 *
 * Calibration helpers track prediction error: how far our confidence
 * (0-1) is from actual outcome (success/failure). Used to detect
 * overconfidence patterns and adjust the calibration score per session.
 */

// The ThoughtChainState and related types (ThoughtRecord,
// CalibrationSample) are defined inline in think.ts. We re-declare
// the minimal shape needed here to keep this file standalone.
// If the inline definition in think.ts ever changes, mirror that
// change here.
export interface CalibrationSample {
  thoughtId: string;
  predictedConfidence: number;
  actualOutcome: "success" | "failure";
  calibrationError: number; // |predicted - actual|
  createdAt: number;
}

interface CalibrationStateSlice {
  calibrationSamples: CalibrationSample[];
}

const COMPLEXITY_KEYWORDS = {
  high: [
    /\b(architectur|design\s+pattern|algorithm|optimize|refactor|benchmark|security|concurren|async|parallel|middleware|plugin|extension)\b/i,
    /\b(integrat|deploy|docker|kubernetes|ci\/|cd\/|pipeline|auth|oauth|jwt|encrypt)\b/i,
    /\b(migrate|upgrade|deprecat|legacy|monolith|microservice|api\s+design)\b/i,
    /\b(database|schema|migration|transaction|index|query\s+optim|partition)\b/i,
  ],
  medium: [
    /\b(function|class|interface|type\s+alias|module|import|export|async|await)\b/i,
    /\b(error|exception|handler|middleware|callback|promise|observable)\b/i,
    /\b(test|spec|assert|mock|stub|coverage|debug|profil)\b/i,
    /\b(config|environment|variable|setup|install|configure|build|compile)\b/i,
  ],
};

/**
 * Estimate complexity score (0-1) from a task description.
 * 0-0.3: simple (quick depth)
 * 0.3-0.7: medium (medium depth)
 * 0.7-1.0: complex (deep depth)
 */
export function estimateComplexity(taskText: string): number {
  if (!taskText || taskText.length < 10) return 0.1;

  let score = 0.3; // baseline for any non-trivial task

  // Length signal: longer = more complex
  const len = taskText.length;
  if (len > 500) score += 0.2;
  else if (len > 300) score += 0.15;
  else if (len > 150) score += 0.1;
  else if (len < 50) score -= 0.15;

  // High complexity keywords
  for (const re of COMPLEXITY_KEYWORDS.high) {
    if (re.test(taskText)) {
      score += 0.2;
      break;
    }
  }

  // Medium complexity keywords
  let mediumHits = 0;
  for (const re of COMPLEXITY_KEYWORDS.medium) {
    if (re.test(taskText)) mediumHits++;
  }
  score += Math.min(mediumHits * 0.05, 0.15);

  // Multi-step indicators (numbered lists, "first/then/finally")
  const stepIndicators =
    (taskText.match(/\d+\.\s+\w+/g) ?? []).length +
    (taskText.match(/\b(first|then|next|finally|after|before)\b/gi) ?? []).length;
  if (stepIndicators > 3) score += 0.15;
  else if (stepIndicators > 1) score += 0.08;

  // Question marks (uncertainty -> possibly complex)
  const questions = (taskText.match(/\?/g) ?? []).length;
  if (questions > 2) score += 0.05;

  return Math.max(0.05, Math.min(0.98, score));
}

/**
 * Allowed values for the think tool's `type` field.
 *
 * Single source of truth -- both the schema enum (think.ts) and any
 * internal default reference this const. Add a value here and it
 * becomes accepted by the schema automatically.
 */
export const THINK_TYPES = [
  "observation",
  "planning",
  "execution",
  "reflection",
  "conclusion",
  "debugging",
  "design",
  "analysis",
  "insight",
  "research",
] as const;
export type ThinkType = (typeof THINK_TYPES)[number];

/** Default `type` when the agent omits it. Must be a member of THINK_TYPES. */
export const DEFAULT_THINK_TYPE: ThinkType = "insight";

/**
 * Allowed values for the think tool's `depth` field.
 *
 * Note: `quick`, `medium`, `deep` are the ODAR-aligned levels; the
 * earlier `minimal`/`low`/`high`/`max` entries exist for explicit
 * fine-grained control. The two vocabularies coexist deliberately --
 * removing the legacy entries would break callers that pass them.
 */
export const DEPTH_LEVELS = ["minimal", "low", "medium", "high", "max", "quick", "deep"] as const;

/**
 * Depth levels reachable via ODAR complexity -> depth routing.
 *
 * NOTE: vocabulary is aligned with `think.ts`'s depth enum and
 * `DEPTH_BUDGETS` — the value must be a member of both, or `getBudget`
 * silently falls back to "quick".
 */
export const ODAR_DEPTH_LEVELS = ["quick", "medium", "deep"] as const;
export type OdarDepthLevel = (typeof ODAR_DEPTH_LEVELS)[number];

/**
 * Map complexity score to ODAR depth level.
 */
export function complexityToDepth(score: number): OdarDepthLevel {
  if (score >= 0.7) return "deep";
  if (score >= 0.3) return "medium";
  return "quick";
}

/**
 * Compute calibration error: |predicted confidence - actual outcome|
 * actual outcome = 1.0 for success, 0.0 for failure
 */
export function computeCalibrationError(predicted: number, actual: "success" | "failure"): number {
  const actualValue = actual === "success" ? 1.0 : 0.0;
  return Math.abs(predicted - actualValue);
}

/**
 * Get calibration statistics for this session.
 */
export function getCalibrationStats(state: CalibrationStateSlice): {
  error: number;
  n: number;
  bias: string;
} {
  if (state.calibrationSamples.length === 0) {
    return { error: 0, n: 0, bias: "no data" };
  }
  const avgError =
    state.calibrationSamples.reduce(
      (s: number, r: { calibrationError: number }) => s + r.calibrationError,
      0,
    ) / state.calibrationSamples.length;
  const bias =
    avgError < 0.1
      ? "calibrated"
      : avgError < 0.25
        ? "slightly biased"
        : avgError < 0.4
          ? "biased"
          : "very biased";
  return { error: Math.round(avgError * 100) / 100, n: state.calibrationSamples.length, bias };
}

/** Per-step effort calibration: depth -> (maxTokens, guidance) */
const DEPTH_BUDGETS: Record<string, { tokens: number; guidance: string }> = {
  minimal: { tokens: 128, guidance: "One-line summary only." },
  low: { tokens: 256, guidance: "Brief: 1-2 sentences." },
  quick: { tokens: 512, guidance: "Concise reasoning." },
  medium: { tokens: 1024, guidance: "Standard analysis." },
  high: { tokens: 2048, guidance: "Thorough analysis with alternatives." },
  max: { tokens: 4096, guidance: "Deep analysis with critique, alternatives, and failure modes." },
  deep: { tokens: 4096, guidance: "Deep analysis with critique, alternatives, and failure modes." },
};

export function getBudget(depth: string) {
  return DEPTH_BUDGETS[depth] ?? DEPTH_BUDGETS.quick;
}
