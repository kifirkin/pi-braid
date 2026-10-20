/**
 * explore-paths tool - parallel hypothesis investigation
 *
 * Self-contained: file-finding helpers + the explore_paths tool.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as url from "node:url";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { addEvidence } from "../../../lib/store/evidence-pool.js";

const execFileAsync = promisify(execFile);

// Last-resort search root, resolved from this module's location: the
// packages/core tree the tool ships in. Normally the session cwd wins, so a
// search covers the project the agent is actually working in.
const PACKAGE_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../../..");

/**
 * Pick the directory explore_paths searches: an explicit `searchRoot`
 * parameter wins; otherwise the session cwd; otherwise the package tree this
 * module lives in. A relative explicit root resolves against the session cwd.
 */
function resolveSearchRoot(explicit: string | undefined, cwd: string | undefined): string {
  const explicitRoot = explicit?.trim();
  if (explicitRoot) {
    return path.isAbsolute(explicitRoot)
      ? explicitRoot
      : path.resolve(cwd?.trim() || process.cwd(), explicitRoot);
  }
  return cwd?.trim() || PACKAGE_ROOT;
}

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

/** Search for a file under `searchRoot` using find */
async function globFind(pattern: string, searchRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "find",
      [
        searchRoot,
        // Prune VCS internals, installed dependencies, and build output:
        // never the source a hypothesis points at, and walking them stalls
        // a search rooted at a repository (node_modules alone can exceed
        // the timeout below).
        "(",
        "-name",
        "node_modules",
        "-o",
        "-name",
        ".git",
        "-o",
        "-name",
        "dist",
        ")",
        "-prune",
        "-o",
        "-name",
        pattern,
        "-type",
        "f",
        "-print",
      ],
      { timeout: 8000 },
    );
    const found = stdout.trim().split("\n").filter(Boolean);
    // Prefer .ts over .js over .mjs
    const ts = found.find((f) => f.endsWith(".ts"));
    const js = found.find((f) => f.endsWith(".js"));
    return ts || js || found[0] || "";
  } catch {
    return "";
  }
}

/** Run a grep search under `searchRoot` and return first few matches */
async function grepSearch(term: string, searchRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "grep",
      [
        "-r",
        "-l",
        "-m",
        "3",
        "--include=*.ts",
        "--include=*.js",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
        term,
        searchRoot,
      ],
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

// The two result shapes (a named refusal and a report) carry different
// details, so the tool declares its own type rather than letting the first
// return statement narrow every other branch.
export function createExplorePathsTool(): ToolDefinition<any, any, any> {
  return {
    name: "explore_paths",
    label: "Explore Paths",
    promptSnippet: "Search for files and read first lines to gather evidence",
    description:
      "Per hypothesis, find matching files and read their first lines as evidence — local search, not a sub-agent. Searches the session working directory by default.",
    parameters: Type.Object({
      hypothesis_1: Type.String({
        description:
          "First potential root cause location: 'The bug might be in FILE because REASON'",
      }),
      hypothesis_2: Type.String({
        description: "Second root-cause location: 'The bug might be in OTHER_FILE because REASON'",
      }),
      hypothesis_3: Type.Optional(
        Type.String({
          description:
            "Third root-cause location: 'The bug might be in ANOTHER_FILE because REASON'",
        }),
      ),
      searchRoot: Type.Optional(
        Type.String({
          description:
            "Directory to search. Defaults to the session working directory; a relative path resolves against it.",
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
      const { hypothesis_1, hypothesis_2, hypothesis_3, searchRoot } = params as {
        hypothesis_1: string;
        hypothesis_2: string;
        hypothesis_3?: string;
        searchRoot?: string;
      };

      // A blank hypothesis names nothing to search. Both are schema-legal
      // (`Type.String()` accepts ""), and the report that followed came back
      // with "No useful keywords found" -- read as "no evidence", not as an
      // unusable call.
      const requiredHypotheses: Array<[string, unknown]> = [
        ["hypothesis_1", hypothesis_1],
        ["hypothesis_2", hypothesis_2],
      ];
      const blankRequired = requiredHypotheses
        .filter(([, value]) => typeof value !== "string" || value.trim().length === 0)
        .map(([name]) => name);
      if (blankRequired.length > 0) {
        const named = blankRequired.map((name) => `'${name}'`).join(" and ");
        return {
          details: { error: "missing_hypothesis", blank: blankRequired },
          content: [
            {
              type: "text" as const,
              text: `explore_paths requires a non-empty ${named}: name a file and a reason, e.g. "The bug might be in src/parser.ts because the offset is never clamped".`,
            },
          ],
        };
      }

      const searchDir = resolveSearchRoot(searchRoot, ctx?.cwd);

      const results: string[] = [];
      const hypotheses = [hypothesis_1, hypothesis_2];
      // An optional third hypothesis is absent when blank; a blank one used to
      // become a report section with an empty title and an empty search.
      const third =
        typeof hypothesis_3 === "string" && hypothesis_3.trim().length > 0
          ? hypothesis_3
          : undefined;
      if (third) hypotheses.push(third);

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
            const grepResult = await grepSearch(keyTerm, searchDir);
            if (grepResult) {
              localResults.push(`Keyword search for "${keyTerm}":`);
              localResults.push(
                grepResult
                  .split("\n")
                  .map((f) => `  [file] ${f}`)
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
          const searchResults = await Promise.all(
            candidates.map(async (candidate) => {
              const foundPath = await globFind(candidate, searchDir);
              return { candidate, foundPath };
            }),
          );

          const found = searchResults.filter((r) => r.foundPath);
          const notFound = searchResults.filter((r) => !r.foundPath);

          if (found.length > 0) {
            for (const { candidate, foundPath } of found) {
              const relPath = path.relative(searchDir, foundPath);
              localResults.push(`[ok] "${candidate}" -> ${relPath}`);
              const preview = await readFileHead(foundPath);
              const previewLines = preview.split("\n").slice(0, 15);
              localResults.push("```");
              localResults.push(...previewLines);
              localResults.push("```");
            }
          }
          if (notFound.length > 0) {
            for (const { candidate } of notFound) {
              localResults.push(`[fail] "${candidate}" not found`);
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

      if (ctx) {
        for (const hyp of hypotheses) {
          addEvidence(ctx, hyp, "session", hyp, 0.5);
        }
      }

      return {
        details: { hypotheses: hypotheses.length, projectRoot: searchDir },
        content: [{ type: "text" as const, text: results.join("\n") }],
      };
    },
  };
}
