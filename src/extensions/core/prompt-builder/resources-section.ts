/**
 * Resources section for the prompt-builder.
 *
 * Renders a consolidated Resources block showing skill counts, per-skill
 * line counts grouped by directory, and memory entry count. Placed just
 * before the skills XML block so skill paths sit near skill descriptions.
 *
 * Extracted from instance-composition.ts (2026-07-18) to keep the Instance
 * block focused on environment/session metadata.
 */

import { readFile } from "node:fs/promises";
import type { PromptSection } from "./section.js";

// ── Utilities (extracted from instance-composition.ts) ──────────────────────

/** Render a path relative to cwd when possible, else absolute. */
function relativeToCwd(p: string, cwd: string): string {
  if (p === cwd) return p + " (cwd)";
  if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  return p;
}

/** Render a list of paths relative to cwd, deduplicating. */
function relativeToCwdList(paths: string[], cwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const rel = relativeToCwd(p, cwd);
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/** Read a SKILL.md file and count its lines. Returns 0 on error. */
async function getSkillLineCount(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

/** Minimal skill info for the Resources block. */
export interface SkillEntry {
  name: string;
  filePath: string;
  baseDir: string;
}

export interface ResourcesContext {
  /** Skills available (from prompt-builder). */
  skillCount: number;
  /** Unique base directories for loaded skills. */
  skillDirs: string[];
  /** Skill entries for line-count rendering. */
  skills: SkillEntry[];
  /** Memory entries (from three-memory-stores). */
  memoryCount: number;
  /** Current working directory for relative path rendering. */
  cwd: string;
}

// ── Section builder ─────────────────────────────────────────────────────────

export function resourcesSection(ctx: ResourcesContext): PromptSection {
  return {
    name: "resources",
    render: async () => renderResources(ctx),
  };
}

async function renderResources(d: ResourcesContext): Promise<string> {
  const lines: string[] = [];

  if (d.skillCount > 0) {
    const dirs = relativeToCwdList(d.skillDirs, d.cwd);

    // Skill line counts for individual skills (grouped by directory)
    if (d.skills.length > 0) {
      const byDir = new Map<string, SkillEntry[]>();
      for (const skill of d.skills) {
        const dir = skill.baseDir || "(unknown)";
        const list = byDir.get(dir);
        if (list) list.push(skill);
        else byDir.set(dir, [skill]);
      }

      // Render each directory group, skills sorted by name
      const skillLines: string[] = [];
      for (const [dir, group] of byDir) {
        const sorted = group.sort((a, b) => a.name.localeCompare(b.name));
        const rel = relativeToCwd(dir, d.cwd);
        const lineCounts = await Promise.all(
          sorted.map((s) => getSkillLineCount(s.filePath)),
        );
        const skillEntries = sorted
          .map((s, i) => `${s.name} (${lineCounts[i]})`)
          .join(", ");
        skillLines.push(`  ${rel}: ${skillEntries}`);
      }

      const mem = d.memoryCount > 0 ? ` | memory: ${d.memoryCount}` : "";
      lines.push(`Resources: ${d.skillCount} skills${mem}`);
      lines.push(...skillLines);
    } else {
      // Fallback: just show directories (no skill entries provided)
      const dirInfo =
        dirs.length > 0 ? ` from ${dirs.join(", ")}` : "";
      const parts: string[] = [
        `${d.skillCount} skill${d.skillCount === 1 ? "" : "s"}${dirInfo}`,
      ];
      if (d.memoryCount > 0)
        parts.push(
          `${d.memoryCount} memor${d.memoryCount === 1 ? "y" : "ies"}`,
        );
      lines.push(`Resources: ${parts.join(", ")}`);
    }
  } else if (d.memoryCount > 0) {
    lines.push(
      `Resources: ${d.memoryCount} memor${d.memoryCount === 1 ? "y" : "ies"}`,
    );
  }

  if (lines.length === 0) return "";

  lines.push("");
  lines.push(
    "Discover on demand: `read` any path above to inspect its source; the file tools (`bash`, `grep`, `find`, `ls`) reach the wider runtime including ~/.pi/agent and the pi-core package.",
  );

  return lines.join("\n");
}