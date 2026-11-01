/**
 * Test: the TypeBox surface stays inside JSON Schema.
 *
 * Why: this tree hands its tool parameter schemas to pi, which validates the
 * model's arguments against them. The builder behind that seam is being
 * replaced by a JSON-Schema-only one, and a TypeBox feature JSON Schema cannot
 * express does not survive the replacement: the tree stops compiling in the
 * middle of a dependency bump, and the failure lands on whoever bumped it, not
 * on whoever added the feature. This fixture delivers that notice early. It
 * reads the tree and fails on a constructor outside the allow-list, on an
 * imported symbol beyond `Type` and a type-only `Static`, on a subpath module,
 * and on any feature JSON Schema cannot carry.
 *
 * The allow-list is data here rather than a constant in shipped source: the
 * surface is this fixture's subject, and a package module that knew it would be
 * a policy sitting in a shared layer. Growing the list means editing a row and
 * writing which JSON Schema the constructor emits.
 *
 * The scan reads raw file text, comments included, so a comment naming an
 * excluded feature fails too. That is the safe direction - a reword is cheap, a
 * miss is not - and a scanner that guessed at comment boundaries would hide the
 * call it mis-parsed. The file excludes itself from its own population because
 * the excluded tokens are its data, the reason check-placement.mjs excludes
 * itself.
 *
 * One seam is inventoried rather than policed: an import from a package that
 * re-exports the builder (`@earendil-works/pi-ai`) arrives through the same
 * entry point as that package's own types, so only the builder package's symbol
 * list is judged. The scan counts those seam imports for the summary line, so
 * the population the swap touches stays visible.
 *
 * Two entry points, one code path:
 *   node packages/core/test/runtime/lib/test-typebox-surface.mjs
 *     registers the cases below with node:test
 *   node packages/core/test/runtime/lib/test-typebox-surface.mjs --scan-only [--root <dir>]
 *     prints every violation and exits 1, exits 0 with a summary line when the
 *     tree is clean, and registers nothing - the path the self-test below uses
 *     to run this scan against a synthetic tree
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";

import { collectFiles } from "../../../scripts/lib/collect-files.mjs";

// ── The surface, as data ────────────────────────────────────────────────────

/** The schema builder this fixture pins, and the family its subpaths belong to. */
const BUILDER = "typebox";

/**
 * Entry points that re-export the builder under their own name. Importing
 * `Type` from one of these is the same surface, so the scan follows it and
 * counts what arrives that way.
 */
const REEXPORTING_PACKAGES = new Map([
  ["@earendil-works/pi-ai", "pi re-exports typebox's Type, Static and TSchema"],
]);

/**
 * The symbols a schema import may name. `Static` is type-only by contract: it is
 * erased at build, so the import adds no runtime dependency of its own.
 */
const ALLOWED_SYMBOLS = new Map([
  ["Type", { typeOnly: false }],
  ["Static", { typeOnly: true }],
]);

/**
 * The names a re-exporting package hands on from the builder, used to count the
 * seam imports the summary line reports. The rest of that package's export
 * surface is its own API (`Model`, `Api`, `Context`), which the builder swap
 * does not touch.
 */
const HOST_BUILDER_SYMBOLS = new Map([
  ["Type", "the builder namespace"],
  ["Static", "the schema-derived type"],
  ["TSchema", "the base schema type"],
  ["StringEnum", "a string-enum schema built on the builder's unsafe escape hatch"],
]);

/**
 * Constructors the tree may use, each with the JSON Schema it emits. A
 * constructor whose output is not a plain schema keyword cannot be added by
 * editing a row: it is the feature this gate exists to keep out.
 */
const ALLOWED_CONSTRUCTORS = new Map([
  ["Optional", "no keyword of its own: the property leaves `required`"],
  ["String", '`{ type: "string" }`'],
  ["Number", '`{ type: "number" }`'],
  ["Integer", '`{ type: "integer" }`'],
  ["Boolean", '`{ type: "boolean" }`'],
  ["Literal", "`{ const: value }`"],
  ["Object", '`{ type: "object", properties, required }`'],
  ["Array", '`{ type: "array", items }`'],
  ["Union", "`{ anyOf: [ ... ] }`"],
  ["Any", "`{}`: the empty schema, which every instance validates against"],
  ["Unsafe", "the schema object it is handed, unchanged"],
]);

/**
 * Features JSON Schema cannot carry, with the reason each one is lost. The
 * `Type.` rows are read in the constructor pass; every other row is a plain
 * token, including the ones whose module a schema may not reach.
 */
const EXCLUDED_FEATURES = new Map([
  ["Type.Refine", "a refinement is a callback the builder owns; JSON Schema has no keyword for it"],
  ["Type.Undefined", "JSON has no undefined"],
  ["Type.BigInt", "JSON has no bigint"],
  ["Type.Codec", "a codec pairs a schema with encode/decode functions; a schema carries only the schema"],
  ["Codec(", "codec construction: the same encode/decode pair, built rather than declared"],
  ["Format.Set", "the format registry is a runtime hook the validator owns; a schema records the name, not the check"],
  ["Type.This", "a self-reference the builder resolves; JSON Schema spells it with `$ref`"],
  ["Type.Recursive", "builder-resolved recursion for the same reason; `$ref` is the schema-level spelling"],
]);

// ── The scan ────────────────────────────────────────────────────────────────

const CODE_FILE = /\.(?:[cm]?[jt]s)$/;
const SCAN_DIR = "packages";
const IMPORT_STATEMENT =
  /^[ \t]*(?:import|export)\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/gm;
const CONSTRUCTOR_CALL = /\bType\.([A-Za-z][\w$]*)/g;

const SELF = import.meta.filename;
const DEFAULT_ROOT = resolve(import.meta.dirname, "../../../../..");
/** This file's place in the tree, so a copied tree excludes its own copy too. */
const SELF_IN_TREE = relative(DEFAULT_ROOT, SELF);

/** The line a byte offset falls on, for a finding a reader can open. */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True for the builder itself, its subpaths, and the entry points that re-export it. */
function isBuilderSpecifier(specifier) {
  return (
    specifier === BUILDER ||
    specifier.startsWith(`${BUILDER}/`) ||
    REEXPORTING_PACKAGES.has(specifier)
  );
}

/** The imported names of one brace list, each with whether it is type-only. */
function importedSymbols(names, statementTypeOnly) {
  const symbols = [];
  for (const raw of names.split(",")) {
    const part = raw.trim();
    if (part === "") continue;
    const typeOnly = statementTypeOnly || part.startsWith("type ");
    symbols.push({ name: part.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim(), typeOnly });
  }
  return symbols;
}

/** The code files the scan reads, self excluded: its own text is the token data. */
function codeFiles(root) {
  return collectFiles(join(root, SCAN_DIR), (file) => CODE_FILE.test(file)).filter(
    (file) => relative(root, file) !== SELF_IN_TREE,
  );
}

/** Every builder import in one file's text, rooted at `root` for the report. */
function importsIn(root, file, text) {
  const imports = [];
  for (const match of text.matchAll(IMPORT_STATEMENT)) {
    const [, statementTypeOnly, names, specifier] = match;
    if (!isBuilderSpecifier(specifier)) continue;
    imports.push({
      file: relative(root, file),
      line: lineOf(text, match.index),
      specifier,
      symbols: importedSymbols(names, Boolean(statementTypeOnly)),
    });
  }
  return imports;
}

/**
 * The whole picture in one walk: the population read, every builder import over
 * it as `{ file, line, specifier, symbols }`, the findings as
 * `{ file, line, kind, detail }`, and the imports that reach the builder
 * through a host re-export. A tree the walk could not read yields an
 * `empty-population` finding instead of an empty list, so a scan that read
 * nothing cannot pass.
 *
 * One walk, one read per file: the coverage case and the rules judge the same
 * population, so they cannot disagree about which files exist.
 */
function scan(root) {
  const packagesDir = join(root, SCAN_DIR);
  const files = codeFiles(root);
  const imports = [];
  const found = [];
  const seams = [];
  const report = (file, line, kind, detail) => found.push({ file, line, kind, detail });

  if (files.length === 0) {
    report(
      SCAN_DIR,
      0,
      "empty-population",
      `no code files under ${packagesDir}: a scan that read nothing cannot fail`,
    );
    return { files, imports, found, seams };
  }

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const path = relative(root, file);

    for (const entry of importsIn(root, file, text)) {
      imports.push(entry);
      if (entry.specifier.startsWith(`${BUILDER}/`)) {
        report(
          path,
          entry.line,
          "specifier",
          `${entry.specifier} is a subpath module: the formats, codecs and reflection JSON Schema cannot carry live in those modules`,
        );
      }
      if (entry.specifier !== BUILDER) {
        if (entry.symbols.some((symbol) => HOST_BUILDER_SYMBOLS.has(symbol.name))) seams.push(entry);
        continue;
      }
      for (const symbol of entry.symbols) {
        const allowed = ALLOWED_SYMBOLS.get(symbol.name);
        if (allowed === undefined) {
          report(
            path,
            entry.line,
            "symbol",
            `imports ${symbol.name}: a schema import names Type and a type-only Static`,
          );
        } else if (allowed.typeOnly && !symbol.typeOnly) {
          report(
            path,
            entry.line,
            "symbol",
            `${symbol.name} is imported as a value: it is a type, so it takes \`import type\` or a \`type\` modifier`,
          );
        }
      }
    }

    for (const match of text.matchAll(CONSTRUCTOR_CALL)) {
      const token = `Type.${match[1]}`;
      const excluded = EXCLUDED_FEATURES.get(token);
      if (excluded !== undefined) {
        report(path, lineOf(text, match.index), "excluded-feature", `${token}: ${excluded}`);
      } else if (!ALLOWED_CONSTRUCTORS.has(match[1])) {
        report(
          path,
          lineOf(text, match.index),
          "constructor",
          `${token} is outside the JSON-Schema allow-list: add it to ALLOWED_CONSTRUCTORS with the schema it emits, or write the keyword directly`,
        );
      }
    }

    for (const [token, why] of EXCLUDED_FEATURES) {
      if (token.startsWith("Type.")) continue;
      for (const match of text.matchAll(new RegExp(escapeRegExp(token), "g"))) {
        // `Type.Codec(` reaches this token too; the constructor pass named it.
        if (text.slice(Math.max(0, match.index - 5), match.index) === "Type.") continue;
        report(path, lineOf(text, match.index), "excluded-feature", `${token}: ${why}`);
      }
    }
  }

  return { files, imports, found, seams };
}

const formatFinding = (finding) =>
  `${finding.file}${finding.line === 0 ? "" : `:${finding.line}`}: ${finding.kind}: ${finding.detail}`;

// ── The command line ────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const requestedRoot = rootFlag === -1 ? undefined : argv[rootFlag + 1];

if (argv.includes("--scan-only")) {
  const root = requestedRoot === undefined ? DEFAULT_ROOT : resolve(requestedRoot);
  const result = scan(root);
  for (const finding of result.found) console.log(`FAIL ${formatFinding(finding)}`);
  console.log(
    `typebox-surface: ${result.found.length} violation(s), ${result.files.length} code files read ` +
      `under ${join(root, SCAN_DIR)}, ${result.seams.length} builder import(s) through a host re-export`,
  );
  process.exit(result.found.length === 0 ? 0 : 1);
}

// ── The cases ───────────────────────────────────────────────────────────────

const ROOT = requestedRoot === undefined ? DEFAULT_ROOT : resolve(requestedRoot);
const REAL = scan(ROOT);

const ofKind = (kind) => REAL.found.filter((finding) => finding.kind === kind);
const describeFindings = (findings) => findings.map((f) => `\n  ${formatFinding(f)}`).join("");

describe("TypeBox surface: only the JSON-Schema subset is used", () => {
  it("uses no feature JSON Schema cannot carry", () => {
    assert.deepEqual(
      ofKind("excluded-feature"),
      [],
      `features outside JSON Schema:${describeFindings(ofKind("excluded-feature"))}`,
    );
  });

  it("uses every constructor from the allow-list", () => {
    assert.deepEqual(
      ofKind("constructor"),
      [],
      `constructors outside the allow-list:${describeFindings(ofKind("constructor"))}`,
    );
  });

  it("imports only Type and a type-only Static", () => {
    assert.deepEqual(
      ofKind("symbol"),
      [],
      `symbols outside the schema import:${describeFindings(ofKind("symbol"))}`,
    );
  });

  it("imports the builder from its own entry point, never a subpath", () => {
    assert.deepEqual(
      ofKind("specifier"),
      [],
      `subpath imports:${describeFindings(ofKind("specifier"))}`,
    );
  });

  it("reads a population that could fail", () => {
    assert.deepEqual(
      ofKind("empty-population"),
      [],
      "the walk found no code files, so every rule above would pass over nothing",
    );
    // A floor, not a census: it fails when the walk loses the tree, and no
    // realistic edit to the tree moves it.
    assert.ok(REAL.files.length > 300, `the walk read ${REAL.files.length} code files`);
  });

  it("sees every package that declares the builder", () => {
    const declaring = [];
    for (const manifest of collectFiles(
      join(ROOT, SCAN_DIR),
      (file) => file.endsWith("package.json") && !file.includes("/node_modules/"),
    )) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (typeof parsed.peerDependencies?.[BUILDER] === "string") {
        declaring.push(relative(join(ROOT, SCAN_DIR), manifest).split("/")[0]);
      }
    }
    assert.ok(declaring.length > 0, "no package declares the builder as a peer dependency");
    const rows = REAL.imports;
    for (const pkg of declaring) {
      assert.ok(
        rows.some((row) => row.file.startsWith(`${SCAN_DIR}/${pkg}/`)),
        `packages/${pkg} declares the builder and the scan found no import in it`,
      );
    }
  });
});

describe("TypeBox surface: the gate reddens", () => {
  /**
   * Run the scan over a temporary root, always removing it afterwards. The
   * child process is the real entry point, so the self-test exercises the
   * command the gate runs and not a private copy of its logic.
   */
  function withTempRoot(prepare) {
    const dir = mkdtempSync(join(tmpdir(), "typebox-surface-"));
    try {
      prepare(dir);
      const result = spawnSync(process.execPath, [SELF, "--scan-only", "--root", dir], {
        encoding: "utf8",
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const GREEN = `import { Type, type Static } from "typebox";

export const schema = Type.Object({
  name: Type.String({ description: "a name" }),
  count: Type.Optional(Type.Integer()),
  kind: Type.Union([Type.Literal("one"), Type.Literal("two")]),
});

export type Shape = Static<typeof schema>;
`;

  /** Scan a one-file tree built from `source`, always removing it afterwards. */
  function scanTree(source) {
    return withTempRoot((dir) => {
      const file = join(dir, SCAN_DIR, "demo", "index.ts");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    });
  }

  it("passes a tree that stays inside the subset", () => {
    const { status, output } = scanTree(GREEN);
    assert.equal(status, 0, output);
    assert.match(output, /0 violation\(s\)/);
  });

  it("fails a planted Type.Refine, naming the file and the constructor", () => {
    const { status, output } = scanTree(
      `${GREEN}\nexport const checked = Type.Refine(schema, (value) => value !== null);\n`,
    );
    assert.equal(status, 1, output);
    assert.match(output, /packages\/demo\/index\.ts:\d+: excluded-feature: Type\.Refine/);
  });

  it("fails a feature named in a comment, because the scan reads raw text", () => {
    const { status, output } = scanTree(`${GREEN}\n// Migrated away from Type.BigInt.\n`);
    assert.equal(status, 1, output);
    assert.match(output, /excluded-feature: Type\.BigInt/);
  });

  it("fails a subpath import", () => {
    const { status, output } = scanTree(`import { Format } from "typebox/format";\n${GREEN}`);
    assert.equal(status, 1, output);
    assert.match(output, /specifier: typebox\/format is a subpath module/);
  });

  it("fails a Static imported as a value", () => {
    const { status, output } = scanTree(GREEN.replace("type Static", "Static"));
    assert.equal(status, 1, output);
    assert.match(output, /symbol: Static is imported as a value/);
  });

  it("fails a constructor the allow-list does not carry", () => {
    const { status, output } = scanTree(
      `${GREEN}\nexport const templated = Type.TemplateLiteral("a");\n`,
    );
    assert.equal(status, 1, output);
    assert.match(output, /constructor: Type\.TemplateLiteral is outside the JSON-Schema allow-list/);
  });

  it("fails a root with no packages directory, rather than passing over nothing", () => {
    const { status, output } = withTempRoot(() => {});
    assert.equal(status, 1, output);
    assert.match(output, /empty-population/);
  });

  it("carries a reason with every row of the two lists", () => {
    for (const [name, emits] of ALLOWED_CONSTRUCTORS) {
      assert.ok(emits.trim().length > 0, `allow-list row ${name} carries no reason`);
    }
    for (const [token, why] of EXCLUDED_FEATURES) {
      assert.ok(why.trim().length > 0, `excluded row ${token} carries no reason`);
      assert.ok(
        !ALLOWED_CONSTRUCTORS.has(token.replace(/^Type\./, "")),
        `${token} is both allowed and excluded`,
      );
    }
  });
});
