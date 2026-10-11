/**
 * Test: prompt-builder guarded content — tool-pipelines.ts (multi-tool
 * pipelines) and tool-guidelines.ts (per-tool guideline sync).
 *
 * Pins the contract:
 * 1. Guard semantics: EVERY tool in a pipeline's guard must be active
 * or the pipeline is dropped (the prompt never references a tool
 * that does not exist in the current profile).
 * 2. Honesty contract: every guard tool name appears verbatim in the
 * pipeline's own lines — the sequence actually uses what it guards.
 * 3. Token budget: each pipeline is ≤ 3 lines; the flattened output
 * stays bounded (≤ 6 lines for the 2 remaining domains).
 * 4. Empty result when no guard is satisfied — the caller skips the
 * section entirely.
 *
 * And the tool-guidelines sync contract:
 * 5. Sync: the Reflection column of the TOOLS.md catalog table (between the
 * TOOLS-CATALOG-BEGIN/END markers) matches TOOL_GUIDELINES EXACTLY in both
 * directions — same tool set, same strings. The documented catalog and the
 * injected system-prompt lines cannot drift apart.
 * 6. Gating: perToolGuidelines() emits exactly one `- <name>: <reflection>`
 * line per tool PRESENT in the active set, none for absent tools — the
 * `if has <tool>`conditional-injection contract.
 *
 * The tests import the modules from dist/ (production compile output),
 * not by grepping source. Kept as a single file (rather than split) to
 * preserve the 49-file runtime suite total — the runner counts files.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { TOOL_PIPELINES, toolPipelineLines } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "tool-pipelines.js")
);

const { TOOL_GUIDELINES, perToolGuidelines, resolveToolLine } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "tool-guidelines.js")
);

const { EXTERNAL_TOOL_GUIDELINES } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "external-tool-guidelines.js")
);

const ALL_TOOLS = [...new Set(Object.values(TOOL_PIPELINES).flatMap((p) => p.guard))];

describe("tool-pipelines", () => {
  it("renders every pipeline when the full tool set is active", () => {
    const lines = toolPipelineLines(ALL_TOOLS);
    for (const p of Object.values(TOOL_PIPELINES)) {
      const present = lines.some((l) => l.startsWith(`${p.label}:`));
      assert.ok(present, `pipeline "${p.label}" should render with full tool set`);
    }
    // Each pipeline contributes exactly its own lines (label line + rest).
    const expected = Object.values(TOOL_PIPELINES).reduce((n, p) => n + p.lines.length, 0);
    assert.equal(lines.length, expected);
  });

  it("returns [] when no guard tool is active", () => {
    assert.deepEqual(toolPipelineLines([]), []);
    assert.deepEqual(toolPipelineLines(["read"]), []);
  });

  it("drops a pipeline when any of its guard tools is missing", () => {
    // Remove fetch_content → the research pipeline must disappear.
    const withoutFetch = ALL_TOOLS.filter((t) => t !== "fetch_content");
    const lines = toolPipelineLines(withoutFetch);
    assert.ok(
      !lines.some((l) => l.startsWith("Research:")),
      "research pipeline should drop without fetch_content",
    );
    // All other pipelines survive.
    for (const p of Object.values(TOOL_PIPELINES)) {
      if (p.label === "Research") continue;
      assert.ok(
        lines.some((l) => l.startsWith(`${p.label}:`)),
        `${p.label} should survive`,
      );
    }
  });

  it("honesty contract: every guard tool name appears in the pipeline lines", () => {
    for (const p of Object.values(TOOL_PIPELINES)) {
      const text = p.lines.join(" ");
      for (const tool of p.guard) {
        // Word-boundary match: "read"must not match inside "already".
        const re = new RegExp(`(^|[^\\w])${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`);
        assert.ok(
          re.test(text),
          `pipeline "${p.label}" must reference guarded tool "${tool}" in its lines`,
        );
      }
    }
  });

  it("token budget: each pipeline ≤ 3 lines, flattened output bounded", () => {
    for (const p of Object.values(TOOL_PIPELINES)) {
      assert.ok(p.lines.length <= 3, `pipeline "${p.label}" exceeds 3 lines`);
    }
    const lines = toolPipelineLines(ALL_TOOLS);
    assert.ok(
      lines.length <= Object.keys(TOOL_PIPELINES).length * 3,
      "flattened output exceeds budget",
    );
    // Every rendered line is non-empty.
    assert.ok(lines.every((l) => l.trim().length > 0));
  });

  it("label prefixes exactly the first line of each pipeline", () => {
    const lines = toolPipelineLines(ALL_TOOLS);
    const index = new Map(lines.map((l, i) => [l.split(":")[0], i]));
    for (const p of Object.values(TOOL_PIPELINES)) {
      const i = index.get(p.label);
      assert.ok(i !== undefined, `pipeline "${p.label}" missing from output`);
      // The label line is followed by the pipeline's remaining lines only.
      const slice = lines.slice(i, i + p.lines.length);
      assert.equal(slice[0], `${p.label}: ${p.lines[0].trim()}`);
      for (let k = 1; k < p.lines.length; k++) {
        assert.equal(slice[k], p.lines[k].trim());
      }
    }
  });
});

// ── tool-guidelines: per-tool guideline sync ─────────────────────────────────

// TOOLS.md catalog parsing (strict: only rows in the marked range).
const CATALOG_BEGIN = "<!-- TOOLS-CATALOG-BEGIN -->";
const CATALOG_END = "<!-- TOOLS-CATALOG-END -->";

function parseCatalogTools(md) {
  const begin = md.indexOf(CATALOG_BEGIN);
  const end = md.indexOf(CATALOG_END);
  assert.ok(begin !== -1 && end !== -1 && end > begin, "TOOLS.md catalog markers must be present");
  const block = md.slice(begin + CATALOG_BEGIN.length, end);
  const out = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^\|\s*`([a-z_][a-z0-9_]*)`\s*\|/);
    if (!m) continue;
    const cells = line.split("|").map((c) => c.trim());
    assert.equal(
      cells.length,
      6,
      `catalog row for \`${m[1]}\` must have exactly 4 cells (got ${cells.length - 2}); ` +
        "no pipes allowed inside Purpose/Enablement/Reflection cells",
    );
    out[m[1]] = cells[4];
  }
  return out;
}

const catalogTools = parseCatalogTools(readFileSync(join(ROOT, "TOOLS.md"), "utf8"));
const DOC_TOOLS = Object.keys(TOOL_GUIDELINES);

describe("tool-guidelines", () => {
  it("export contract: TOOL_GUIDELINES is a non-empty record of 1-line strings", () => {
    assert.ok(
      DOC_TOOLS.length >= 25,
      `expected a broad documented tool set, got ${DOC_TOOLS.length}`,
    );
    for (const [name, line] of Object.entries(TOOL_GUIDELINES)) {
      assert.ok(name.length > 0, "tool name must be non-empty");
      assert.ok(
        typeof line === "string" && line.trim().length > 0,
        `\`${name}\` guideline must be non-empty`,
      );
      assert.ok(!line.includes("\n"), `\`${name}\` guideline must be a single line`);
      assert.ok(
        !line.includes("|"),
        `\`${name}\` guideline must not contain a pipe (breaks TOOLS.md table)`,
      );
    }
  });

  it("sync contract: TOOLS.md catalog and TOOL_GUIDELINES are the same tool set", () => {
    const docNames = Object.keys(catalogTools).sort();
    assert.deepEqual(
      [...DOC_TOOLS].sort(),
      docNames,
      "TOOLS.md catalog tools and TOOL_GUIDELINES keys must match exactly",
    );
  });

  it("sync contract: every Reflection in TOOLS.md equals the injected guideline string", () => {
    for (const [name, guideline] of Object.entries(TOOL_GUIDELINES)) {
      assert.ok(
        name in catalogTools,
        `TOOLS.md catalog is missing a row for documented tool \`${name}\``,
      );
      assert.equal(
        catalogTools[name],
        guideline,
        `TOOLS.md Reflection for \`${name}\` must equal the TOOL_GUIDELINES string`,
      );
    }
  });

  it("resolveToolLine priority 1: the tool's OWNING package promptGuidelines win over the static record", () => {
    const owned = ["when: external owner declares its own strategy"];
    assert.equal(resolveToolLine("edit", "Make precise file edits", owned), owned[0]);
    assert.equal(resolveToolLine("telegram_send", "Send a message to the owner", owned), owned[0]);
  });

  it("resolveToolLine priority 2: static record when the owner declares nothing", () => {
    assert.equal(
      resolveToolLine("edit", "Make precise file edits", undefined),
      TOOL_GUIDELINES.edit,
    );
    assert.equal(
      resolveToolLine("read", "Read file contents", []),
      TOOL_GUIDELINES.read,
      "empty array falls through",
    );
  });

  it("resolveToolLine priority 3: external last-resort map for unpatched third-party tools", () => {
    assert.equal(
      resolveToolLine("herdr_agent", "Control a coding agent in a Herdr pane", undefined),
      EXTERNAL_TOOL_GUIDELINES.herdr_agent,
    );
    assert.equal(
      resolveToolLine("fetch_content", "Fetch URL(s)", undefined),
      EXTERNAL_TOOL_GUIDELINES.fetch_content,
    );
  });

  it("resolveToolLine priority 4: first sentence of the description for unknown tools (no static, no map)", () => {
    const line = resolveToolLine(
      "context_compress",
      "Free up context space; prefer archive over compact.",
      undefined,
    );
    assert.equal(line, "Free up context space; prefer archive over compact.");
    assert.equal(
      resolveToolLine("unknown_tool", undefined, undefined),
      undefined,
      "nothing available → undefined",
    );
  });

  it("resolveToolLine: strategy lines do not restate the description verbatim (dedup contract)", () => {
    // The static rewrite must not echo the description text:
    // edit's description starts with "Edit a single file using exact text"
    // while its guideline starts with the strategy frame "when:".
    assert.match(TOOL_GUIDELINES.edit, /^when:/);
    assert.match(TOOL_GUIDELINES.read, /^when:/);
    assert.match(TOOL_GUIDELINES.verify, /^when:/);
  });

  it("gating: one line per present tool, none for absent tools", () => {
    const lines = perToolGuidelines(DOC_TOOLS);
    assert.equal(
      lines.length,
      DOC_TOOLS.length,
      "full set renders exactly one line per documented tool",
    );
    assert.deepEqual(perToolGuidelines([]), []);
    assert.deepEqual(perToolGuidelines(["read", "nope"]), [`- read: ${TOOL_GUIDELINES.read}`]);
    assert.deepEqual(perToolGuidelines(["think", "verify", "read"]), [
      `- read: ${TOOL_GUIDELINES.read}`,
      `- think: ${TOOL_GUIDELINES.think}`,
      `- verify: ${TOOL_GUIDELINES.verify}`,
    ]);
  });

  it("order + format: insertion order preserved, exact `- name: reflection` lines", () => {
    const lines = perToolGuidelines(DOC_TOOLS);
    lines.forEach((line, i) => {
      const name = DOC_TOOLS[i];
      assert.equal(line, `- ${name}: ${TOOL_GUIDELINES[name]}`);
    });
  });

  it("no duplicates: each documented tool renders at most once", () => {
    const lines = perToolGuidelines(DOC_TOOLS);
    assert.equal(new Set(lines).size, lines.length);
  });
});
