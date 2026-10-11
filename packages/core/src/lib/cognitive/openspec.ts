/**
 * OpenSpec spec context - inject SHALL/MUST/SHOULD requirements from active
 * specs into the agent's context.
 *
 * Delivery model: WHISPER. The active spec requirements are sent once per
 * session as an `openspec` custom message (steer, no trigger). The agent
 * sees them in the next turn but they do NOT live in the system prompt.
 *
 * Rationale: spec context is supplemental. It can be 100+ lines for projects
 * with many domains. Keeping it out of the system prompt keeps every turn's
 * baseline cost low; the agent still has the spec content in its next turn
 * via the whisper and can `read` the full spec.md if it needs more detail.
 *
 * Behavior:
 * - Walks `cwd/openspec/specs/<domain>/spec.md` for up to 3 domains.
 * - Extracts the `### Requirement:` headings and any line containing
 *   SHALL/MUST/SHOULD.
 * - Sends as a `## Active Specs` block with per-domain requirement lists,
 *   plus a footer reminder to update delta specs.
 *
 * If the spec dir is missing or unreadable, the whisper is skipped.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sendTrackedMessage } from "../utils/injection-tracker.js";
import { asyncExists } from "../utils/async-fs.js";

const MAX_DOMAINS = 3;
const SPECS_DIRNAME = "openspec";
const SPECS_SUBDIR = "specs";
const SPEC_FILENAME = "spec.md";

/** Extract requirement lines from a spec.md file. */
function extractRequirements(content: string): string[] {
  const reqs: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("### Requirement:") || /\b(SHALL|MUST|SHOULD)\b/.test(trimmed)) {
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
      // An unreadable spec file is skipped, not fatal.
    }
  }
  return out;
}

/**
 * Build the whisper text for the `## Active Specs` block.
 * Returns "" if no spec domains were found or no requirements could be extracted.
 */
function renderSpecsText(specs: DomainSpecs[]): string {
  if (specs.length === 0) return "";

  const body = specs
    .map((s) => `${s.domain}:\n${s.requirements.map((r) => `  ${r}`).join("\n")}`)
    .join("\n\n");

  return `## Active Specs\n\n${body}\n\nWhen editing, check openspec/specs/ for relevant requirements and update delta specs if behavior changes.`;
}

/**
 * Deliver active OpenSpec spec context as a whisper (once per session).
 * Best-effort: any failure (missing dirs, unreadable files) is swallowed.
 */
export async function deliverActiveSpecs(
  cwd: string,
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
): Promise<void> {
  let specs: DomainSpecs[];
  try {
    specs = await readActiveSpecs(cwd);
  } catch {
    return;
  }

  const text = renderSpecsText(specs);
  if (!text) return;

  try {
    sendTrackedMessage(
      pi,
      {
        customType: "openspec",
        display: true,
        content: [{ type: "text" as const, text }],
      },
      { delivery: "park", deliverAs: "steer" },
      { type: "memory", source: "prompt-builder/openspec" },
    );
  } catch {
    // Non-fatal: steer message send is best-effort
  }
}
