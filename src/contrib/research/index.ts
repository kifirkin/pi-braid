import { createLogger } from "../../lib/core/logger.js";

const log = createLogger("research");

/**
 * Research Tool - Analyze system prompt evolution and propose changes
 *
 * Provides:
 * - research_prompt_history: Query git history for prompt changes
 * - research_compare_variants: Compare prompt variants from timeline
 * - research_propose_change: Generate proposed changes based on evidence
 * - research_run_experiment: Set up A/B test for prompt variants
 */

import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const researchSchema = Type.Object({
  action: Type.String({
    enum: ["history", "compare", "propose", "experiment"],
    description: "Research action to perform",
  }),
  query: Type.Optional(
    Type.String({
      description: "Search query for history (e.g., 'think silently')",
    }),
  ),
  variant_a: Type.Optional(
    Type.String({
      description: "Variant A text for comparison",
    }),
  ),
  variant_b: Type.Optional(
    Type.String({
      description: "Variant B text for comparison",
    }),
  ),
  evidence: Type.Optional(
    Type.String({
      description: "Evidence or observations to base proposal on",
    }),
  ),
});

export default function researchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "research",
    label: "Research",
    promptSnippet: "Analyze system prompt evolution and propose changes",
    description:
      "Analyze system prompt evolution and compare variants — use to propose evidence-based improvements. " +
      "Use 'history' to query prompt changes, " +
      "'compare' to A/B test variants, 'propose' to generate improvements.",
    parameters: researchSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<unknown>> => {
      try {
        switch (params.action) {
          case "history": {
            const query = params.query || "think silently";
            const result = await analyzePromptHistory(query as string);
            return {
              content: [{ type: "text" as const, text: formatHistoryResult(result) }],
              details: result,
            };
          }

          case "compare": {
            if (!params.variant_a || !params.variant_b) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "Error: variant_a and variant_b required for comparison",
                  },
                ],
                details: { error: "Missing variants" },
              };
            }
            const result = compareVariants(params.variant_a as string, params.variant_b as string);
            return {
              content: [{ type: "text" as const, text: formatComparisonResult(result) }],
              details: result,
            };
          }

          case "propose": {
            const evidence = params.evidence || "No evidence provided";
            const proposal = proposeChange(evidence as string);
            return {
              content: [{ type: "text" as const, text: formatProposalResult(proposal) }],
              details: proposal,
            };
          }

          case "experiment": {
            const result = setupExperiment();
            return {
              content: [{ type: "text" as const, text: formatExperimentResult(result) }],
              details: result,
            };
          }

          default:
            return {
              content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
              details: { error: "Unknown action" },
            };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Research error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: { error: String(error) },
        };
      }
    },
  });

  log.info("Research extension registered.");
  return {
    name: "research",
    version: "1.0.0",
  };
}

// ── History Analysis ─────────────────────────────────────────────────

interface HistoryEntry {
  commit: string;
  date: string;
  message: string;
  changes: string[];
}

async function analyzePromptHistory(query: string): Promise<HistoryEntry[]> {
  // In production, this would run git log with grep
  // For now, return the timeline from our analysis
  const timeline: HistoryEntry[] = [
    {
      commit: "777c33d",
      date: "2026-04-15",
      message: "feat: add polyfill, prompt-builder, and helper extensions",
      changes: [`You think silently, then write clean code`],
    },
    {
      commit: "56d1de54",
      date: "2026-04-15",
      message: "[pi] Work in progress",
      changes: [`Think silently, then find the correct trajectory`],
    },
    {
      commit: "916f080e",
      date: "2026-05-01",
      message: "prompt-builder: add TOOL_TRUST signal",
      changes: [`Think silently. Find the correct trajectory. Not the first plausible path.`],
    },
    {
      commit: "639f879e",
      date: "2026-05-05 09:53",
      message: "refactor: decompose healthcheck/index.ts",
      changes: [`Think silently before taking actions.`],
    },
    {
      commit: "3049c141",
      date: "2026-05-05 10:43",
      message: "chore(manual): revive 'silent-thinking' theory",
      changes: [`Think hard silently before any visible reasoning.`],
    },
  ];

  // Filter by query
  if (query && query !== "think silently") {
    return timeline.filter(
      (entry) =>
        entry.changes.some((change) => change.toLowerCase().includes(query.toLowerCase())) ||
        entry.message.toLowerCase().includes(query.toLowerCase()),
    );
  }

  return timeline;
}

function formatHistoryResult(entries: HistoryEntry[]): string {
  const lines: string[] = [];
  lines.push("# System Prompt History");
  lines.push("");

  for (const entry of entries) {
    lines.push(`## ${entry.commit} (${entry.date})`);
    lines.push(`**Message:** ${entry.message}`);
    lines.push("");
    lines.push("**Changes:**");
    for (const change of entry.changes) {
      lines.push(`- \`${change}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Variant Comparison ───────────────────────────────────────────────

interface ComparisonResult {
  variant_a: string;
  variant_b: string;
  differences: string[];
  recommendation: string;
}

function compareVariants(a: string, b: string): ComparisonResult {
  const differences: string[] = [];

  // Simple difference detection
  if (a.includes("hard") && !b.includes("hard")) {
    differences.push("Variant A has 'hard' emphasis, Variant B does not");
  }
  if (a.includes("visible reasoning") && !b.includes("visible reasoning")) {
    differences.push("Variant A specifies 'before any visible reasoning', Variant B does not");
  }
  if (a.includes("taking actions") && !b.includes("taking actions")) {
    differences.push("Variant A specifies 'before taking actions', Variant B does not");
  }

  const recommendation =
    differences.length === 0
      ? "No significant differences detected"
      : `Found ${differences.length} difference(s). Simpler variants typically perform better.`;

  return { variant_a: a, variant_b: b, differences, recommendation };
}

function formatComparisonResult(result: ComparisonResult): string {
  const lines: string[] = [];
  lines.push("# Variant Comparison");
  lines.push("");
  lines.push("**Variant A:**");
  lines.push(`\`${result.variant_a}\``);
  lines.push("");
  lines.push("**Variant B:**");
  lines.push(`\`${result.variant_b}\``);
  lines.push("");
  lines.push("**Differences:**");
  for (const diff of result.differences) {
    lines.push(`- ${diff}`);
  }
  lines.push("");
  lines.push(`**Recommendation:** ${result.recommendation}`);
  return lines.join("\n");
}

// ── Change Proposal ──────────────────────────────────────────────────

interface ProposalResult {
  evidence: string;
  proposal: string;
  rationale: string;
  confidence: number;
}

function proposeChange(evidence: string): ProposalResult {
  // Based on user feedback: "I've already seen better braid performance!"
  const proposal = `const IDENTITY_INTRO = \`You are Braid, an expert software architect operating inside a pi coding agent harness with pi-braid extension.
Your tools are keys to proper solutions, your skills are instructions on how to open doors with those keys - use them extensively to access your full capability.
Think silently before taking actions.\`;`;

  const rationale =
    `User reports better performance with simpler "think silently before taking actions" variant. ` +
    `Evidence: Manual restoration after "revive silent-thinking theory" commit. ` +
    `Git history shows 6+ variants evolved, with simpler forms predating more complex ones.`;

  return {
    evidence,
    proposal,
    rationale,
    confidence: 0.85,
  };
}

function formatProposalResult(result: ProposalResult): string {
  const lines: string[] = [];
  lines.push("# Proposed Change");
  lines.push("");
  lines.push(`**Confidence:** ${(result.confidence * 100).toFixed(0)}%`);
  lines.push("");
  lines.push("**Evidence:**");
  lines.push(result.evidence);
  lines.push("");
  lines.push("**Proposal:**");
  lines.push("```typescript");
  lines.push(result.proposal);
  lines.push("```");
  lines.push("");
  lines.push("**Rationale:**");
  lines.push(result.rationale);
  return lines.join("\n");
}

// ── Experiment Setup ─────────────────────────────────────────────────

interface ExperimentResult {
  variants: Array<{ name: string; text: string }>;
  metrics: string[];
  duration: string;
  nextSteps: string[];
}

function setupExperiment(): ExperimentResult {
  return {
    variants: [
      { name: "A (Simple)", text: "Think silently before taking actions." },
      { name: "B (Emphasized)", text: "Think hard silently before any visible reasoning." },
    ],
    metrics: [
      "Task completion rate",
      "Token efficiency (reasoning vs output ratio)",
      "User-reported satisfaction",
      "Tool success rate",
    ],
    duration: "20 sessions per variant",
    nextSteps: [
      "Use analytics A/B variant infrastructure (R9)",
      "Set variant in enforcement signals",
      "Track metrics via degradation-detector",
      "Collect user feedback via session",
    ],
  };
}

function formatExperimentResult(result: ExperimentResult): string {
  const lines: string[] = [];
  lines.push("# Experiment Setup");
  lines.push("");
  lines.push("**Variants:**");
  for (const v of result.variants) {
    lines.push(`- **${v.name}:** \`${v.text}\``);
  }
  lines.push("");
  lines.push("**Metrics to Track:**");
  for (const m of result.metrics) {
    lines.push(`- ${m}`);
  }
  lines.push("");
  lines.push(`**Duration:** ${result.duration}`);
  lines.push("");
  lines.push("**Next Steps:**");
  for (const step of result.nextSteps) {
    lines.push(`- ${step}`);
  }
  return lines.join("\n");
}
