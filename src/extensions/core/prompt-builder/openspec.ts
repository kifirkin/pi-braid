/**
 * OpenSpec spec context - inject SHALL/MUST/SHOULD requirements from active
 * specs into the system prompt.
 *
 * Extracted from the inline `try { ... }` block in `before_agent_start`.
 * Now uses async I/O (matches the rest of the prompt-builder) and exports
 * a `PromptSection` that the main handler composes.
 *
 * Behavior:
 * - Walks `cwd/openspec/specs/<domain>/spec.md` for up to 3 domains.
 * - Extracts the `### Requirement:` headings and any line containing
 *   SHALL/MUST/SHOULD.
 * - Renders as `## Active Specs` followed by per-domain requirement lists,
 *   plus a footer reminder to update delta specs.
 *
 * If the spec dir is missing or unreadable, the section renders to "".
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { headingSection } from "./section.js";
import { asyncExists } from "../../../lib/utils/async-fs.js";

const MAX_DOMAINS = 3;
const SPECS_DIRNAME = "openspec";
const SPECS_SUBDIR = "specs";
const SPEC_FILENAME = "spec.md";

/** Extract requirement lines from a spec.md file. */
function extractRequirements(content: string): string[] {
  const reqs: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("### Requirement:") ||
      /\b(SHALL|MUST|SHOULD)\b/.test(trimmed)
    ) {
      reqs.push(trimmed.replace(/^[#\s]+/, ""));
    }
  }
  return reqs;
}

interface DomainSpecs {
  domain: string;
  requirements: string[];
}

/** Walk up to MAX_DOMAINS spec domains, return their extracted requirements. */
async function readActiveSpecs(cwd: string): Promise<DomainSpecs[]> {
  const specDir = join(cwd, SPECS_DIRNAME, SPECS_SUBDIR);
  if (!(await asyncExists(specDir))) return [];

  const domains = await readdir(specDir, { withFileTypes: true }).catch(() => []);
  const out: DomainSpecs[] = [];
  for (const domain of domains) {
    if (out.length >= MAX_DOMAINS) break;
    if (!domain.isDirectory()) continue;
    const specPath = join(specDir, domain.name, SPEC_FILENAME);
    if (!(await asyncExists(specPath))) continue;
    try {
      const content = await readFile(specPath, "utf-8");
      const requirements = extractRequirements(content);
      if (requirements.length > 0) {
        out.push({ domain: domain.name, requirements });
      }
    } catch {
      // Skip unreadable spec files.
    }
  }
  return out;
}

/**
 * Build the `## Active Specs` section. Returns "" if no spec domains
 * were found or no requirements could be extracted.
 */
export function activeSpecsSection(cwd: string) {
  return {
    name: "openspec",
    render: async () => {
      let specs: DomainSpecs[];
      try {
        specs = await readActiveSpecs(cwd);
      } catch {
        return "";
      }
      if (specs.length === 0) return "";

      const body = specs
        .map(
          (s) =>
            `${s.domain}:\n${s.requirements.map((r) => `  ${r}`).join("\n")}`,
        )
        .join("\n\n");

      return headingSection(
        "openspec",
        "Active Specs",
        `${body}\n\nWhen editing, check openspec/specs/ for relevant requirements and update delta specs if behavior changes.`,
      ).render();
    },
  };
}
