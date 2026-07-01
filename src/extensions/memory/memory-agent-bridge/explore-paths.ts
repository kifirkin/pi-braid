/**
 * explore-paths tool - parallel hypothesis investigation
 *
 * Extracted from memory-agent-bridge/index.ts for cleaner separation of concerns.
 * Self-contained: file-finding helpers + the explore_paths tool.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as url from "node:url";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addEvidence } from "../../../lib/store/evidence-pool.js";

const execFileAsync = promisify(execFile);

// pi-braid project root - resolved from this file's location so searches work from any CWD
const PROJECT_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../../..");

/** Extract candidate file names from a hypothesis string using multiple patterns */
function extractFileCandidates(hypothesis: string): string[] {
  const candidates = new Set<string>();

  // Pattern 1: "in FILE" or "in path/to/file"
  for (const m of hypothesis.matchAll(/\bin\s+([\w./-]+\.\w+)/gi)) {
    candidates.add(m[1]);
  }
  // Pattern 2: "file FILE" or "file: FILE"
  for (const m of hypothesis.matchAll(/\bfile[:\s]+([\w./-]+\.\w+)/gi)) {
    candidates.add(m[1]);
  }
  // Pattern 3: bare filename.ts / filename.js / .json / .mjs
  for (const m of hypothesis.matchAll(/\b([\w-]+\.(?:ts|js|mjs|json))\b/g)) {
    candidates.add(m[1]);
  }
  // Pattern 4: quoted strings that look like paths
  for (const m of hypothesis.matchAll(/[`'"]([\w./-]+\.\w+)[`'"]/g)) {
    candidates.add(m[1]);
  }

  return [...candidates];
}

/** Search for a file starting from PROJECT_ROOT using find */
async function globFind(pattern: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("find", [PROJECT_ROOT, "-name", pattern, "-type", "f"], {
      timeout: 8000,
    });
    const found = stdout.trim().split("\n").filter(Boolean);
    // Prefer .ts over .js over .mjs
    const ts = found.find((f) => f.endsWith(".ts"));
    const js = found.find((f) => f.endsWith(".js"));
    return ts || js || found[0] || "";
  } catch {
    return "";
  }
}

/** Run a grep search and return first few matches */
async function grepSearch(term: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "grep",
      ["-r", "-l", "-m", "3", "--include=*.ts", "--include=*.js", term, PROJECT_ROOT],
      { timeout: 8000 },
    );
    return stdout.trim().split("\n").filter(Boolean).slice(0, 3).join("\n");
  } catch {
    return "";
  }
}

/** Read first N lines of a file */
async function readFileHead(path: string, lines = 30): Promise<string> {
  if (!path) return "";
  try {
    const { stdout } = await execFileAsync("head", [`-${lines}`, path], { timeout: 5000 });
    return stdout;
  } catch {
    return "(could not read)";
  }
}

export function createExplorePathsTool() {
  return {
    name: "explore_paths",
    label: "Explore Paths",
    promptSnippet: "Search for files and read first lines to gather evidence",
    description:
      "For each hypothesis, search the project for matching files (by name or by keyword) and read the first 15 lines. Use to gather evidence before fixing bugs. The search is local (find/grep/head), NOT a sub-agent invocation. All hypotheses must lead to proper solutions - never use monkey patching.",
    parameters: Type.Object({
      hypothesis_1: Type.String({
        description:
          "First potential root cause location: 'The bug might be in FILE because REASON'",
      }),
      hypothesis_2: Type.String({
        description:
          "Second potential root cause location: 'The bug might be in OTHER_FILE because REASON'",
      }),
      hypothesis_3: Type.Optional(
        Type.String({
          description:
            "Third potential root cause location (optional): 'The bug might be in ANOTHER_FILE because REASON'",
        }),
      ),
    }),

    execute: async (
      _toolCallId: string,
      params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) => {
      const { hypothesis_1, hypothesis_2, hypothesis_3 } = params as {
        hypothesis_1: string;
        hypothesis_2: string;
        hypothesis_3?: string;
      };

      const results: string[] = [];
      const hypotheses = [hypothesis_1, hypothesis_2];
      if (hypothesis_3) hypotheses.push(hypothesis_3);

      // Run all hypothesis investigations in parallel
      const explorations = hypotheses.map(async (hyp, i) => {
        const localResults: string[] = [];
        localResults.push(`### Hypothesis ${i + 1}: ${hyp.substring(0, 120)}`);

        const candidates = extractFileCandidates(hyp);
        if (candidates.length === 0) {
          // No files found - try keyword search
          localResults.push("No file candidates extracted - trying keyword search...");
          const words = hyp
            .split(/\W+/)
            .filter(
              (w) =>
                w.length > 3 &&
                !/^(the|and|for|because|when|that|this|with|from|have|will|been|also|than|then|more|into|use|using|need|want|make|just|only|not|but|all|any|some|their|there|here|where|what|which|while|would|could|should|might|must|such|same|very)$/i.test(
                  w,
                ),
            );
          const keyTerm = words.slice(0, 3).join(" ");
          if (keyTerm.length > 3) {
            const grepResult = await grepSearch(keyTerm);
            if (grepResult) {
              localResults.push(`Keyword search for "${keyTerm}":`);
              localResults.push(
                grepResult
                  .split("\n")
                  .map((f) => `  📄 ${f}`)
                  .join("\n"),
              );
              localResults.push("(first 3 matches shown)");
            } else {
              localResults.push(`No results for keyword search "${keyTerm}"`);
            }
          } else {
            localResults.push("No useful keywords found for search.");
          }
        } else {
          // Try each candidate file in parallel
          const searchResults = await Promise.all(
            candidates.map(async (candidate) => {
              const foundPath = await globFind(candidate);
              return { candidate, foundPath };
            }),
          );

          const found = searchResults.filter((r) => r.foundPath);
          const notFound = searchResults.filter((r) => !r.foundPath);

          if (found.length > 0) {
            for (const { candidate, foundPath } of found) {
              const relPath = foundPath.replace(PROJECT_ROOT + "/", "");
              localResults.push(`✅ "${candidate}" -> ${relPath}`);
              const preview = await readFileHead(foundPath);
              const previewLines = preview.split("\n").slice(0, 15);
              localResults.push("```");
              localResults.push(...previewLines);
              localResults.push("```");
            }
          }
          if (notFound.length > 0) {
            for (const { candidate } of notFound) {
              localResults.push(`❌ "${candidate}" not found in project`);
            }
          }
        }

        localResults.push("");
        return localResults;
      });

      const allResults = await Promise.all(explorations);
      for (const r of allResults) {
        results.push(...r);
      }

      results.push("---");
      results.push("**Next steps:**");
      results.push("1. Review the evidence above - files found show the actual code path");
      results.push("2. Identify which hypothesis has supporting evidence");
      results.push("3. Trace the code path for the most likely hypothesis");
      results.push("4. Propose a PROPER fix (no shortcuts, no technical debt)");
      results.push("");
      results.push(
        "**Quality requirement:** All solutions must be well-designed and maintainable.",
      );

      // Add evidence to pool
      if (ctx) {
        for (const hyp of hypotheses) {
          addEvidence(ctx, hyp, "session", hyp, 0.5);
        }
      }

      return {
        details: { hypotheses: hypotheses.length, projectRoot: PROJECT_ROOT },
        content: [{ type: "text" as const, text: results.join("\n") }],
      };
    },
  };
}
