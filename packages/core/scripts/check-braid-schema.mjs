#!/usr/bin/env node
/**
 * check-braid-schema.mjs — gate braid.* config drift: exit 0 clean, exit 1 on drift.
 *
 * Two arms:
 *
 *   1. Artifact freshness — the committed packages/core/schema/braid.schema.json
 *      must be byte-identical to a fresh in-memory regeneration. A difference
 *      (or a missing artifact) means a reader default moved without a
 *      regeneration: fail with a short diff summary.
 *
 *   2. Doc comparison — the braid.* table rows of the hand-maintained config
 *      reference are checked against the schema: (a) every doc row carries a
 *      valid Status (ACTIVE / DEPRECATED / EXPERIMENTAL); (b) every doc row's
 *      key path exists in the schema; (c) every doc-stated literal default
 *      (number, boolean, quoted string) equals the schema default where the
 *      schema has a literal. Rows outside the braid.* sections are skipped
 *      (their keys do not start with `braid.`). Doc resolution: a --doc <path>
 *      wins; else the lexicographically newest BRAID-CONFIG-REFERENCE-*.md in
 *      the companion braid-docs/notes/ directory, when that directory exists.
 *      With no reference to read the arm is skipped: the skip names its reason
 *      and counts the rows it did not compare, and the gate still exits 0 (the
 *      reference is a companion repo, not a repo artifact, so a checkout that
 *      has nothing beside it stays green). A skipped arm is never printed as a
 *      pass.
 *
 * Usage: node scripts/check-braid-schema.mjs [--doc <path>]
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSchema } from "./gen-braid-schema.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..", "..");
export const SCHEMA_PATH = join(REPO_ROOT, "packages/core/schema/braid.schema.json");
const DOC_NOTES_DIR = join(REPO_ROOT, "..", "braid-docs", "notes");
const DOC_NAME_RE = /^BRAID-CONFIG-REFERENCE-.*\.md$/;

// ── Arm 1: artifact freshness ───────────────────────────────────────────────

/**
 * Byte-compare the committed artifact against a fresh regeneration.
 * Returns { ok, errors } — errors carry a short diff summary each.
 */
export function checkFreshness(committedText, regeneratedText) {
  if (committedText === null) {
    return { ok: false, errors: ["schema artifact missing: packages/core/schema/braid.schema.json (run gen-braid-schema.mjs)"] };
  }
  if (committedText === regeneratedText) return { ok: true, errors: [] };
  const a = committedText.split("\n");
  const b = regeneratedText.split("\n");
  let first = -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      first = i;
      break;
    }
  }
  const diff = Math.abs(a.length - b.length) + (first >= 0 ? 1 : 0);
  return {
    ok: false,
    errors: [
      `schema artifact stale (differs from regeneration near line ${first + 1}, ` +
        `${diff} changed line(s); committed ${a.length} lines vs generated ${b.length}) — ` +
        "run gen-braid-schema.mjs and commit the result",
    ],
  };
}

// ── Doc resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the config reference: --doc <path> argument wins; else the
 * lexicographically newest BRAID-CONFIG-REFERENCE-*.md in the companion
 * braid-docs/notes/ directory (the notesDir parameter, so a caller can point
 * the arm at another tree); else null — no reference was offered, so the arm
 * reports a counted skip instead of a comparison.
 */
export function resolveDocPath(argv = process.argv.slice(2), notesDir = DOC_NOTES_DIR) {
  const i = argv.indexOf("--doc");
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1]);
  if (!existsSync(notesDir)) return null;
  const candidates = readdirSync(notesDir).filter((f) => DOC_NAME_RE.test(f)).sort();
  if (candidates.length === 0) return null;
  return join(notesDir, candidates[candidates.length - 1]);
}

// ── Doc parsing ─────────────────────────────────────────────────────────────

/**
 * Parse markdown table rows; keep keys starting with `braid.` (rows in
 * non-braid.* sections never start with that prefix, so they are skipped).
 * Escaped pipes (\|) inside cells are honoured. Column order is fixed:
 * key | type | default | status | description | read at (file:line).
 */
export function parseDocRows(docText) {
  const rows = [];
  const lines = docText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\|/.test(line) || /^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("\\|")
      .join("\u0000")
      .split("|")
      .map((c) => c.trim().split("\u0000").join("|"));
    const key = cells[0]?.replace(/^`|`$/g, "").trim();
    if (!key || !key.startsWith("braid.")) continue;
    rows.push({
      key,
      defaultCell: cells[2] ?? "",
      status: (cells[3] ?? "").replace(/^`|`$/g, "").trim(),
      line: i + 1,
    });
  }
  return rows;
}

/**
 * Extract literal defaults from a doc default cell: `name: value` pairs
 * (resolved against child properties) and bare literals (resolved at the
 * row's own node). Only numbers, booleans and quoted strings count.
 */
export function extractDocLiterals(cell) {
  const out = [];
  let rest = cell;
  for (const m of cell.matchAll(
    /([A-Za-z_][\w-]*)\s*:\s*("(?:[^"\\]|\\.)*"|'[^']*'|\btrue\b|\bfalse\b|-?\b\d[\d_]*)/g,
  )) {
    out.push({ name: m[1], value: parseDocLiteral(m[2]) });
    rest = rest.replace(m[0], " ");
  }
  for (const m of rest.matchAll(/("(?:[^"\\]|\\.)*"|'[^']*'|\btrue\b|\bfalse\b|-?\b\d[\d_]*\b)/g)) {
    out.push({ name: null, value: parseDocLiteral(m[1]) });
  }
  return out;
}

function parseDocLiteral(token) {
  const s = token.trim();
  if (/^["']/.test(s)) return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  return Number(s.replace(/_/g, ""));
}

// ── Arm 2: doc comparison ───────────────────────────────────────────────────

/** Resolve a schema node by dot path; `<ext>` matches patternProperties. */
function resolveNode(tree, path) {
  const segments = path.split(".");
  segments.shift(); // "braid"
  let node = tree.properties?.braid;
  for (const seg of segments) {
    if (!node) return undefined;
    if (seg.startsWith("<") && seg.endsWith(">")) {
      const pp = node.patternProperties;
      if (!pp) return undefined;
      node = pp[Object.keys(pp)[0]];
      continue;
    }
    node = node.properties?.[seg];
  }
  return node;
}

function valuesEqual(a, b) {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return a === b;
}

/** The lifecycle vocabulary a doc row's Status cell must carry. */
export const DOC_STATUSES = ["ACTIVE", "DEPRECATED", "EXPERIMENTAL"];

/**
 * Check doc rows against the schema tree: every row carries a valid Status;
 * every key exists; every doc-stated literal default equals the schema default
 * where the schema has a literal. A named literal (child: value) names a
 * child property that must exist.
 */
export function checkDoc(schemaText, docText) {
  const tree = JSON.parse(schemaText);
  const rows = parseDocRows(docText);
  const errors = [];
  let compared = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!DOC_STATUSES.includes(row.status)) {
      errors.push(
        `doc row status missing or invalid: ${row.key} (doc line ${row.line}) — ` +
          `expected one of ${DOC_STATUSES.join(", ")}`,
      );
      continue;
    }
    const node = resolveNode(tree, row.key);
    if (!node) {
      errors.push(`doc row key missing from schema: ${row.key} (doc line ${row.line})`);
      continue;
    }
    for (const lit of extractDocLiterals(row.defaultCell)) {
      const target = lit.name
        ? { node: node.properties?.[lit.name], label: `${row.key}.${lit.name}` }
        : { node, label: row.key };
      if (!target.node) {
        errors.push(
          `doc default names a key absent from schema: ${target.label} (doc line ${row.line})`,
        );
        continue;
      }
      if (target.node.default === undefined) {
        skipped++;
        continue;
      }
      compared++;
      if (!valuesEqual(target.node.default, lit.value)) {
        errors.push(
          `doc default mismatch: ${target.label} — doc ${JSON.stringify(lit.value)} vs ` +
            `schema ${JSON.stringify(target.node.default)} (doc line ${row.line})`,
        );
      }
    }
  }
  return { ok: errors.length === 0, errors, docRows: rows.length, compared, skipped };
}

/**
 * The doc arm end to end for one doc path. A reference that is absent, or was
 * never named, is a counted skip rather than a failure: the reference is a
 * companion artifact, so a checkout without one must still pass. The skip line
 * names the directory it looked in, states how many rows went unchecked and
 * how to supply a reference, so it can never be mistaken for a comparison that
 * ran.
 */
export function docArm(docPath, schemaText, notesDir = DOC_NOTES_DIR) {
  if (docPath === null || !existsSync(docPath)) {
    const reason =
      docPath === null
        ? `no reference given and none in ${notesDir}`
        : `reference not present (${docPath})`;
    return {
      ok: true,
      advisory: true,
      output: `doc check skipped: ${reason}; 0 braid.* row(s) compared — pass --doc <path> to check a reference`,
    };
  }
  const result = checkDoc(schemaText, readFileSync(docPath, "utf8"));
  return {
    ok: result.ok,
    advisory: false,
    output:
      `doc: ${result.docRows} braid.* row(s), ${result.compared} literal default(s) compared, ` +
      `${result.skipped} without a schema literal (source: ${docPath})`,
    errors: result.errors,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const { text } = generateSchema();
  let exit = 0;

  const freshness = checkFreshness(existsSync(SCHEMA_PATH) ? readFileSync(SCHEMA_PATH, "utf8") : null, text);
  if (freshness.ok) {
    console.log("✅ schema artifact fresh (byte-identical to regeneration)");
  } else {
    exit = 1;
    for (const e of freshness.errors) console.error(`❌ ${e}`);
  }

  const doc = docArm(resolveDocPath(), text);
  // A skipped arm gets its own marker: a comparison that never ran must not
  // wear the same checkmark as one that did.
  console.log(doc.ok ? `${doc.advisory ? "⏭" : "✅"} ${doc.output}` : `❌ ${doc.output}`);
  if (!doc.ok) {
    exit = 1;
    for (const e of doc.errors) console.error(`  - ${e}`);
  }

  if (exit === 0) {
    console.log(
      doc.advisory
        ? "✅ braid schema check passed (artifact arm only: no reference was compared)"
        : "✅ braid schema check passed",
    );
  }
  process.exit(exit);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (e) {
    console.error(`check-braid-schema: ${e.message}`);
    process.exit(1);
  }
}
